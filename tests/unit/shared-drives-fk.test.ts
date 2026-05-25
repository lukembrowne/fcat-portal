import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createSharedDrivesTestDb } from "../helpers/test-db";

describe("foreign key enforcement", () => {
  it("src/db/index.ts enables PRAGMA foreign_keys = ON", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/db/index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/pragma\(["']foreign_keys\s*=\s*ON["']\)/);
  });

  it("ON DELETE RESTRICT blocks deleting a drive that still has reservations", () => {
    const db = createSharedDrivesTestDb();
    db.insert(schema.sharedDrives)
      .values({ id: "d", driveId: "0Adxxxxxxxxxxxxxxx", rootFolderId: "root-d", name: "d" })
      .run();
    db.insert(schema.sharedDriveReservations)
      .values({ id: "r1", sharedDriveId: "d", quota: 40_000 })
      .run();

    expect(() => db.run(sql`DELETE FROM shared_drives WHERE id = 'd'`)).toThrow();
  });
});
