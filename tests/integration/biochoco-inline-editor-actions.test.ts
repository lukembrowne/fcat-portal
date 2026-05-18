/**
 * Action-layer tests for the biochoco overview inline editor.
 *
 * Mocks auth, sheets-client, system-events, and next/cache so we can exercise
 * the action bodies (validation, error localization, event emission, update
 * shape) without hitting the DB or Google Sheets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";
import type { ScheduleRow } from "@/lib/schedule-types";
import { scheduleHash } from "@/lib/schedule-hash";

setupAuthMocks();

const loadScheduleMock = vi.fn();
const updateScheduleRowsMock = vi.fn(async () => undefined);
const recordEventMock = vi.fn(async () => undefined);
const revalidatePathMock = vi.fn();

vi.mock("@/lib/sheets-client", () => ({
  loadSchedule: (...args: unknown[]) => loadScheduleMock(...args),
  updateScheduleRows: (...args: unknown[]) => updateScheduleRowsMock(...args),
}));

vi.mock("@/lib/system-events", () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// Stub out fetchBiochocoData's other dependencies so the module imports.
vi.mock("@/lib/odk-client", () => ({
  fetchEntities: vi.fn(async () => []),
  fetchSubmissions: vi.fn(async () => []),
}));

vi.mock("@/lib/odk-constants", () => ({
  BIOCHOCO_PROJECT_ID: 1,
  BIOCHOCO_DATASET_SITES: "sites",
  BIOCHOCO_FORM_DEPLOY: "deploy",
  BIOCHOCO_FORM_RETRIEVE: "retrieve",
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ deployments: "deployments" }));

const { previewInlineSwap, commitInlineSwap, commitDateEdit } = await import(
  "@/app/biochoco/overview/actions"
);

function makeRow(overrides: Partial<ScheduleRow>): ScheduleRow {
  return {
    deploymentId: "TEST-001_V1",
    siteId: "TEST-001",
    siteName: "Test Site",
    habitatType: "secondary_forest",
    visitNumber: 1,
    season: "wet_peak",
    plannedDeployDate: "2026-03-15",
    plannedRetrieveDate: "2026-04-15",
    actualDeployDate: null,
    actualRetrieveDate: null,
    status: "scheduled",
    deploySlotId: null,
    retrieveSlotId: null,
    driveFolderLink: "",
    ...overrides,
  };
}

const SCHEDULE: ScheduleRow[] = [
  makeRow({
    deploymentId: "A_V1",
    siteId: "A",
    plannedDeployDate: "2026-03-15",
    plannedRetrieveDate: "2026-04-14",
    season: "wet_peak",
    deploySlotId: 1,
    retrieveSlotId: 31,
  }),
  makeRow({
    deploymentId: "B_V1",
    siteId: "B",
    plannedDeployDate: "2026-06-15",
    plannedRetrieveDate: "2026-07-15",
    season: "wet_transition",
  }),
];

describe("biochoco overview inline editor actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePermission.mockResolvedValue(testUser);
    loadScheduleMock.mockResolvedValue(SCHEDULE);
  });

  // ─── commitInlineSwap ─────────────────────────────────────

  describe("commitInlineSwap", () => {
    it("returns Spanish error on hash mismatch", async () => {
      const result = await commitInlineSwap("A_V1", "B_V1", "stale-hash");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("modificado por otro usuario");
      }
      expect(updateScheduleRowsMock).not.toHaveBeenCalled();
      expect(recordEventMock).not.toHaveBeenCalled();
    });

    it("rejects id1 === id2 with Spanish error", async () => {
      const hash = scheduleHash(SCHEDULE);
      const result = await commitInlineSwap("A_V1", "A_V1", hash);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          "No se puede intercambiar una instalación consigo misma.",
        );
      }
      expect(updateScheduleRowsMock).not.toHaveBeenCalled();
    });

    it("writes both rows with the 5 expected fields on success", async () => {
      const hash = scheduleHash(SCHEDULE);
      const result = await commitInlineSwap("A_V1", "B_V1", hash);
      expect(result.success).toBe(true);
      expect(updateScheduleRowsMock).toHaveBeenCalledTimes(1);

      const updates = updateScheduleRowsMock.mock.calls[0][0] as Array<{
        deploymentId: string;
        fields: Record<string, unknown>;
      }>;
      expect(updates).toHaveLength(2);
      const expectedFields = [
        "plannedDeployDate",
        "plannedRetrieveDate",
        "deploySlotId",
        "retrieveSlotId",
        "season",
      ].sort();
      for (const u of updates) {
        expect(Object.keys(u.fields).sort()).toEqual(expectedFields);
      }
      expect(recordEventMock).toHaveBeenCalledTimes(1);
      const event = recordEventMock.mock.calls[0][0];
      expect(event.source).toBe("biochoco-overview");
      expect(event.eventType).toBe("schedule_inline_swap");
    });
  });

  // ─── commitDateEdit ───────────────────────────────────────

  describe("commitDateEdit", () => {
    it("rejects malformed date string", async () => {
      const result = await commitDateEdit("A_V1", "06/12/2026");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("Fecha inválida.");
      expect(updateScheduleRowsMock).not.toHaveBeenCalled();
    });

    it("rejects empty date string", async () => {
      const result = await commitDateEdit("A_V1", "");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("Fecha inválida.");
    });

    it("emits one schedule_date_edit event with slotsCleared=true when slots present", async () => {
      const result = await commitDateEdit("A_V1", "2026-05-12");
      expect(result.success).toBe(true);
      expect(recordEventMock).toHaveBeenCalledTimes(1);
      const event = recordEventMock.mock.calls[0][0];
      expect(event.source).toBe("biochoco-overview");
      expect(event.eventType).toBe("schedule_date_edit");
      expect(event.details.slotsCleared).toBe(true);
      expect(event.details.oldDeployDate).toBe("2026-03-15");
      expect(event.details.newDeployDate).toBe("2026-05-12");
    });

    it("emits slotsCleared=false when source row has no slots", async () => {
      const result = await commitDateEdit("B_V1", "2026-08-12");
      expect(result.success).toBe(true);
      const event = recordEventMock.mock.calls[0][0];
      expect(event.details.slotsCleared).toBe(false);
    });

    it("writes exactly the 5 partial-update fields with slot IDs nulled", async () => {
      const result = await commitDateEdit("A_V1", "2026-05-12");
      expect(result.success).toBe(true);
      expect(updateScheduleRowsMock).toHaveBeenCalledTimes(1);
      const updates = updateScheduleRowsMock.mock.calls[0][0] as Array<{
        deploymentId: string;
        fields: Record<string, unknown>;
      }>;
      expect(updates).toHaveLength(1);
      expect(updates[0].deploymentId).toBe("A_V1");
      expect(Object.keys(updates[0].fields).sort()).toEqual(
        [
          "plannedDeployDate",
          "plannedRetrieveDate",
          "deploySlotId",
          "retrieveSlotId",
          "season",
        ].sort(),
      );
      expect(updates[0].fields.deploySlotId).toBeNull();
      expect(updates[0].fields.retrieveSlotId).toBeNull();
    });

    it("returns warnings on success without blocking commit", async () => {
      // Make B's planned deploy date collide so validateSchedule warns.
      loadScheduleMock.mockResolvedValue([
        makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-03-15", plannedRetrieveDate: "2026-04-15" }),
        makeRow({ deploymentId: "C_V1", siteId: "C", plannedDeployDate: "2026-06-15", plannedRetrieveDate: "2026-07-15" }),
      ]);
      const result = await commitDateEdit("A_V1", "2026-06-15"); // collides with C_V1
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.warnings.length).toBeGreaterThan(0);
      }
      // Commit happened despite warnings.
      expect(updateScheduleRowsMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── previewInlineSwap ────────────────────────────────────

  describe("previewInlineSwap", () => {
    it("returns changes + validation warnings + a stable hash", async () => {
      const result = await previewInlineSwap("A_V1", "B_V1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.changes.length).toBeGreaterThan(0);
        expect(result.data.hash).toBe(scheduleHash(SCHEDULE));
        expect(Array.isArray(result.data.validationErrors)).toBe(true);
      }
      expect(updateScheduleRowsMock).not.toHaveBeenCalled();
    });

    it("localizes self-swap error", async () => {
      const result = await previewInlineSwap("A_V1", "A_V1");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          "No se puede intercambiar una instalación consigo misma.",
        );
      }
    });
  });
});
