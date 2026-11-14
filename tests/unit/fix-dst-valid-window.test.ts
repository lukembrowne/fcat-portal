import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import * as mod from "../../scripts/fix-dst-valid-window.mjs";

interface Decision { field: string; from?: string; to?: string; imageId?: number; untouched?: boolean }
interface Change { deploymentId: number; field: string; from: string; to: string }
const planDeployment = mod.planDeployment as unknown as (d: object, imgs: object[]) => Decision[];
const plan = mod.plan as unknown as (db: Database.Database) => { changes: Change[]; untouched: Decision[]; alreadyCorrect: number };
const apply = mod.apply as unknown as (db: Database.Database, c: Change[], actor: string) => { applied: Change[]; skipped: Change[] };

const s = (iso: string) => Date.parse(iso) / 1000;
// CCN-010_V1 shape: summer photo 15:33 UTC = 10:33 Ecuador = 11:33 New York.
const summer = { id: 1, setupTag: "deployment", exifTimestamp: null, fileModified: s("2026-03-17T15:33:00Z") };
// CCN-001_V1 shape: winter photo, NY == Ecuador.
const winter = { id: 2, setupTag: "deployment", exifTimestamp: null, fileModified: s("2026-02-18T16:04:00Z") };

describe("fix-dst-valid-window", () => {
  it("corrects a summer tag saved +1 h", () => {
    expect(planDeployment({ validStart: "2026-03-17T11:33", validEnd: null }, [summer])).toEqual([
      { field: "valid_start", from: "2026-03-17T11:33", to: "2026-03-17T10:33", imageId: 1 },
    ]);
  });

  it("leaves a value that already matches the photo in Ecuador time", () => {
    expect(planDeployment({ validStart: "2026-03-17T10:33", validEnd: null }, [summer])).toEqual([]);
    expect(planDeployment({ validStart: "2026-02-18T11:04", validEnd: null }, [winter])).toEqual([]);
  });

  it("never touches a hand-typed value or a window with no tagged photo", () => {
    const d = planDeployment({ validStart: "2026-03-17T09:00", validEnd: "2026-04-17T10:51" }, [summer]);
    expect(d.every((x) => x.untouched)).toBe(true);
    expect(d).toHaveLength(2);
  });

  it("only matches a tag for the same end of the window", () => {
    const retrievalOnly = { ...summer, setupTag: "retrieval" };
    expect(planDeployment({ validStart: "2026-03-17T11:33", validEnd: null }, [retrievalOnly])[0].untouched).toBe(true);
  });

  it("applies guarded updates and records one audit event", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE biochoco_deployments (id INTEGER PRIMARY KEY, name TEXT, valid_start TEXT, valid_end TEXT, updated_at INTEGER);
      CREATE TABLE biochoco_images (id INTEGER PRIMARY KEY, deployment_id INTEGER, setup_tag TEXT, exif_timestamp TEXT, file_modified INTEGER);
      CREATE TABLE system_events (id INTEGER PRIMARY KEY, occurred_at INTEGER, event_type TEXT, source TEXT, severity TEXT, actor_email TEXT, project_id TEXT, target_type TEXT, summary TEXT, details TEXT);`);
    db.prepare("INSERT INTO biochoco_deployments VALUES (10,'A','2026-03-17T11:33',NULL,0),(11,'B','2026-03-17T11:33',NULL,0)").run();
    db.prepare("INSERT INTO biochoco_images VALUES (1,10,'deployment',NULL,?),(2,11,'deployment',NULL,?)").run(summer.fileModified, summer.fileModified);
    const p = plan(db);
    expect(p.changes).toHaveLength(2);
    // Someone edits B after the plan was computed: it must be skipped, not overwritten.
    db.prepare("UPDATE biochoco_deployments SET valid_start='2026-03-17T12:00' WHERE id=11").run();
    const r = apply(db, p.changes, "tester@example.org");
    expect(r.applied.map((c) => c.deploymentId)).toEqual([10]);
    expect(r.skipped.map((c) => c.deploymentId)).toEqual([11]);
    const rows = db.prepare("SELECT id, valid_start FROM biochoco_deployments ORDER BY id").all();
    expect(rows).toEqual([{ id: 10, valid_start: "2026-03-17T10:33" }, { id: 11, valid_start: "2026-03-17T12:00" }]);
    const ev = db.prepare("SELECT event_type, details FROM system_events").all() as Array<{ event_type: string; details: string }>;
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].details).applied[0].from).toBe("2026-03-17T11:33");
  });
});
