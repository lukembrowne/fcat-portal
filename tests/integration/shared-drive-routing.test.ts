import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
} from "../helpers/test-db";
import { mockRequirePermission, setupAuthMocks, testUser } from "../helpers/mock-auth";
import { DEPLOYMENT_QUOTA } from "@/lib/shared-drives";

setupAuthMocks();
setupIntegrationDbMock();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ODK + Sheets are external — stub with the minimum the action reads.
vi.mock("@/lib/odk-client", () => ({
  fetchSubmissions: vi.fn(),
  fetchEntities: vi.fn(),
}));
vi.mock("@/lib/sheets-client", () => ({
  loadSchedule: vi.fn(async () => []),
  updateScheduleRows: vi.fn(async () => {}),
}));
// Mock the Drive folder creation; selection/reservation logic stays real.
vi.mock("@/lib/drive-client", () => ({
  createDeploymentFolder: vi.fn(),
}));

const odk = await import("@/lib/odk-client");
const driveClient = await import("@/lib/drive-client");
const actions = await import("@/app/biochoco/data/drive-folder-actions");

const fetchSubmissions = vi.mocked(odk.fetchSubmissions);
const fetchEntities = vi.mocked(odk.fetchEntities);
const createDeploymentFolder = vi.mocked(driveClient.createDeploymentFolder);

const DEPLOY_ID = "TP-999";

// Set by seedBioChocoProject() in beforeEach; seeded drives belong to it.
let bioChocoProjectId = 0;

function seedDrive(id: string, reconciledCount: number, status: schema.SharedDriveStatus = "active") {
  testDbRef.current
    .insert(schema.sharedDrives)
    .values({
      id,
      driveId: `0A${id.padEnd(16, "x")}`,
      rootFolderId: `root-${id}`,
      name: id,
      cameraTrapProjectId: bioChocoProjectId,
      status,
      reconciledCount,
    })
    .run();
}

function seedBioChocoProject() {
  const [row] = testDbRef.current
    .insert(schema.cameraTrapProjects)
    .values({ name: "BioChoco", driveFolderId: "legacy-root" })
    .returning({ id: schema.cameraTrapProjects.id })
    .all();
  bioChocoProjectId = row.id;
}

function setOdkFixtures() {
  // First call (deploy form) returns our submission; second (retrieve) empty.
  fetchSubmissions
    .mockResolvedValueOnce([
      {
        __id: "sub-1",
        site_selection: { deployment_id: DEPLOY_ID, site_id: "S1" },
        deployment_info: { deploy_date: "2026-05-01" },
      },
    ])
    .mockResolvedValueOnce([]);
  fetchEntities.mockResolvedValue([
    { site_id: "S1", site_name: "Sitio 1", latitude: "0.1", longitude: "-79.1", label: "Sitio 1" },
  ]);
  createDeploymentFolder.mockResolvedValue({
    id: "folder-new",
    name: DEPLOY_ID,
    webViewLink: "https://drive.google.com/x",
    subfolderIds: { camarasTrampas: "c", grabadoresDeAudio: "g", ibutton: "i" },
  });
}

function deploymentRow() {
  return testDbRef.current.get(
    sql`SELECT name, drive_folder_id, shared_drive_id, ct_project_id FROM biochoco_deployments WHERE name = ${DEPLOY_ID}`,
  ) as { name: string; drive_folder_id: string; shared_drive_id: string | null; ct_project_id: number | null } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  testDbRef.current = createTestDb();
  mockRequirePermission.mockResolvedValue(testUser);
  seedBioChocoProject();
  setOdkFixtures();
});

describe("createSingleDriveFolder — routing enabled", () => {
  it("routes a new deployment to the fullest eligible drive and reserves a slot", async () => {
    vi.stubEnv("SHARED_DRIVE_ROUTING_ENABLED", "true");
    seedDrive("fcat-biochoco", 300_000); // fuller
    seedDrive("fcat-biochoco-2", 10_000); // emptier

    const res = await actions.createSingleDriveFolder(DEPLOY_ID);
    expect(res.success).toBe(true);
    expect(res.folderId).toBe("folder-new");

    // Folder created under the FULLER drive's root (bin-pack).
    expect(createDeploymentFolder).toHaveBeenCalledWith("root-fcat-biochoco", DEPLOY_ID);

    const dep = deploymentRow();
    expect(dep?.shared_drive_id).toBe("fcat-biochoco");

    // Reservation token created, attached to the deployment, counter bumped.
    const reservations = testDbRef.current.all(
      sql`SELECT shared_drive_id, deployment_id, released_at FROM shared_drive_reservations`,
    ) as { shared_drive_id: string; deployment_id: number | null; released_at: string | null }[];
    expect(reservations).toHaveLength(1);
    expect(reservations[0].shared_drive_id).toBe("fcat-biochoco");
    expect(reservations[0].deployment_id).not.toBeNull();
    expect(reservations[0].released_at).toBeNull();

    const pend = testDbRef.current.get(
      sql`SELECT pending_reservations_count AS p FROM shared_drives WHERE id = 'fcat-biochoco'`,
    ) as { p: number };
    expect(pend.p).toBe(DEPLOYMENT_QUOTA);
    vi.unstubAllEnvs();
  });

  it("skips a read-only drive and routes to the active one", async () => {
    vi.stubEnv("SHARED_DRIVE_ROUTING_ENABLED", "true");
    seedDrive("fcat-biochoco", 300_000, "read-only"); // fuller but read-only
    seedDrive("fcat-biochoco-2", 10_000, "active");

    const res = await actions.createSingleDriveFolder(DEPLOY_ID);
    expect(res.success).toBe(true);
    expect(createDeploymentFolder).toHaveBeenCalledWith("root-fcat-biochoco-2", DEPLOY_ID);
    expect(deploymentRow()?.shared_drive_id).toBe("fcat-biochoco-2");
    vi.unstubAllEnvs();
  });

  it("fails loudly with no capacity and records an error event", async () => {
    vi.stubEnv("SHARED_DRIVE_ROUTING_ENABLED", "true");
    // Only drive is at the hard threshold already.
    seedDrive("fcat-biochoco", 460_000); // 92% > 85% hard
    const res = await actions.createSingleDriveFolder(DEPLOY_ID);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/capacidad/i);
    expect(createDeploymentFolder).not.toHaveBeenCalled();

    const evts = testDbRef.current.all(
      sql`SELECT event_type FROM system_events WHERE source = 'shared-drives'`,
    ) as { event_type: string }[];
    expect(evts.some((e) => e.event_type.startsWith("deployment_folder_create_"))).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("createSingleDriveFolder — routing disabled (legacy)", () => {
  it("uses the legacy project root and sets no shared_drive_id", async () => {
    vi.stubEnv("SHARED_DRIVE_ROUTING_ENABLED", "false");
    seedDrive("fcat-biochoco", 10_000); // present but unused when routing off

    const res = await actions.createSingleDriveFolder(DEPLOY_ID);
    expect(res.success).toBe(true);
    expect(createDeploymentFolder).toHaveBeenCalledWith("legacy-root", DEPLOY_ID);
    expect(deploymentRow()?.shared_drive_id).toBeNull();

    const reservations = testDbRef.current.all(
      sql`SELECT id FROM shared_drive_reservations`,
    ) as unknown[];
    expect(reservations).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});
