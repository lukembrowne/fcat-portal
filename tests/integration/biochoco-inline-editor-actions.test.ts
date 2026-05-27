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
const updateScheduleRowsMock = vi.fn(async () => ({ matchedRows: 1, cellsWritten: 1 }));
const recordEventMock = vi.fn(async () => undefined);
const revalidatePathMock = vi.fn();
const updateTagMock = vi.fn();
const fetchEntityMock = vi.fn();
const updateEntityMock = vi.fn();

// Real error class so the action's `err instanceof OdkEntityError` checks work.
class OdkEntityError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OdkEntityError";
    this.status = status;
  }
}

vi.mock("@/lib/sheets-client", () => ({
  loadSchedule: (...args: unknown[]) => loadScheduleMock(...args),
  updateScheduleRows: (...args: unknown[]) => updateScheduleRowsMock(...args),
}));

vi.mock("@/lib/system-events", () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
  updateTag: (...args: unknown[]) => updateTagMock(...args),
}));

// Stub out fetchBiochocoData's other dependencies so the module imports.
vi.mock("@/lib/odk-client", () => ({
  fetchEntities: vi.fn(async () => []),
  fetchSubmissions: vi.fn(async () => []),
  fetchEntity: (...args: unknown[]) => fetchEntityMock(...args),
  updateEntity: (...args: unknown[]) => updateEntityMock(...args),
  OdkEntityError,
}));

vi.mock("@/lib/odk-constants", () => ({
  BIOCHOCO_PROJECT_ID: 1,
  BIOCHOCO_DATASET_SITES: "sites",
  BIOCHOCO_FORM_DEPLOY: "deploy",
  BIOCHOCO_FORM_RETRIEVE: "retrieve",
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ deployments: "deployments" }));

const { previewInlineSwap, commitInlineSwap, commitDateEdit, updateSiteEntity } = await import(
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

  // ─── updateSiteEntity ─────────────────────────────────────

  describe("updateSiteEntity", () => {
    const BASE_INPUT = {
      siteId: "A",
      uuid: "uuid-a",
      name: "A - Nuevo Nombre",
      latitude: "0.5",
      longitude: "-79.2",
      habitatType: "primary_forest",
      landownerName: "Nuevo Dueño",
      landownerPhone: "0999999999",
      notes: "Nueva nota",
      expected: {
        name: "A - Viejo Nombre",
        latitude: "0.5",
        longitude: "-79.2",
        habitatType: "secondary_forest",
        landownerName: "Viejo Dueño",
        landownerPhone: "0888888888",
        notes: "Vieja nota",
      },
    };

    /** Live entity whose values match BASE_INPUT.expected (no conflict). */
    function liveMatchingExpected(overrides: Record<string, string> = {}) {
      return {
        currentVersion: {
          version: 3,
          label: "A - Viejo Nombre",
          data: {
            site_id: "A",
            latitude: "0.5",
            longitude: "-79.2",
            habitat_type: "secondary_forest",
            landowner_name: "Viejo Dueño",
            landowner_phone: "0888888888",
            notes: "Vieja nota",
            ...overrides,
          },
        },
      };
    }

    beforeEach(() => {
      fetchEntityMock.mockResolvedValue(liveMatchingExpected());
      updateEntityMock.mockResolvedValue({ currentVersion: { version: 4, label: "A", data: {} } });
      loadScheduleMock.mockResolvedValue([
        makeRow({ deploymentId: "A_V1", siteId: "A" }),
        makeRow({ deploymentId: "A_V2", siteId: "A" }),
      ]);
      updateScheduleRowsMock.mockResolvedValue({ matchedRows: 2, cellsWritten: 2 });
    });

    it("blocks the network when the name is blank (validation first)", async () => {
      const result = await updateSiteEntity({ ...BASE_INPUT, name: "   " });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("El nombre no puede estar vacío.");
      expect(fetchEntityMock).not.toHaveBeenCalled();
      expect(updateEntityMock).not.toHaveBeenCalled();
    });

    it("rejects out-of-range coordinates without any network call", async () => {
      const result = await updateSiteEntity({ ...BASE_INPUT, latitude: "999", longitude: "0" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("Coordenadas inválidas.");
      expect(fetchEntityMock).not.toHaveBeenCalled();
    });

    it("rejects one-empty-one-filled coordinates", async () => {
      const result = await updateSiteEntity({ ...BASE_INPUT, latitude: "0.5", longitude: "" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("Coordenadas inválidas.");
      expect(fetchEntityMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown habitat", async () => {
      const result = await updateSiteEntity({ ...BASE_INPUT, habitatType: "lava_field" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("Hábitat inválido.");
      expect(fetchEntityMock).not.toHaveBeenCalled();
    });

    it("detects a page-load conflict (live values changed) and does NOT PATCH", async () => {
      fetchEntityMock.mockResolvedValue(
        liveMatchingExpected({ habitat_type: "pasture" }), // someone changed habitat
      );
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("actualizado por otra persona");
      expect(updateEntityMock).not.toHaveBeenCalled();
    });

    it("maps a 404 on read to the 'ya no existe' message", async () => {
      fetchEntityMock.mockRejectedValue(new OdkEntityError("gone", 404));
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("ya no existe");
      expect(updateEntityMock).not.toHaveBeenCalled();
    });

    it("maps a 409 on PATCH to the conflict message", async () => {
      updateEntityMock.mockRejectedValue(new OdkEntityError("conflict", 409));
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("actualizado por otra persona");
    });

    it("PATCHes label + data and emits a site_entity_edit event on success", async () => {
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(true);

      expect(updateEntityMock).toHaveBeenCalledTimes(1);
      const [, , uuid, patch, baseVersion] = updateEntityMock.mock.calls[0];
      expect(uuid).toBe("uuid-a");
      expect(baseVersion).toBe(3);
      expect(patch.label).toBe("A - Nuevo Nombre");
      expect(patch.data).toMatchObject({
        latitude: "0.5",
        longitude: "-79.2",
        habitat_type: "primary_forest",
        habitat_type_spanish: "Bosque Primario", // synced parallel column
        geometry: "0.5 -79.2 0 0", // ODK geopoint format, default alt/acc
        landowner_name: "Nuevo Dueño",
        landowner_phone: "0999999999",
        notes: "Nueva nota",
      });

      expect(recordEventMock).toHaveBeenCalledTimes(1);
      const event = recordEventMock.mock.calls[0][0];
      expect(event.source).toBe("biochoco-overview");
      expect(event.eventType).toBe("site_entity_edit");
      expect(event.targetType).toBe("site");
      expect(updateTagMock).toHaveBeenCalledWith("biochoco-sites");
    });

    it("syncs the name to every schedule row for the site", async () => {
      await updateSiteEntity(BASE_INPUT);
      const updates = updateScheduleRowsMock.mock.calls[0][0] as Array<{
        deploymentId: string;
        fields: Record<string, unknown>;
      }>;
      expect(updates).toHaveLength(2);
      for (const u of updates) {
        expect(u.fields).toEqual({ siteName: "A - Nuevo Nombre" });
      }
    });

    it("rebuilds geometry in ODK geopoint format, preserving altitude/accuracy", async () => {
      fetchEntityMock.mockResolvedValue(liveMatchingExpected({ geometry: "0.5 -79.2 142.7 4.057" }));
      await updateSiteEntity({
        ...BASE_INPUT,
        latitude: "0.6",
        longitude: "-79.3",
        expected: { ...BASE_INPUT.expected, latitude: "0.5", longitude: "-79.2" },
      });
      const patch = updateEntityMock.mock.calls[0][3];
      // New lat/lng, but altitude + accuracy carried over from the existing point.
      expect(patch.data.geometry).toBe("0.6 -79.3 142.7 4.057");
    });

    it("clears geometry (and coords) when coordinates are cleared", async () => {
      await updateSiteEntity({
        ...BASE_INPUT,
        latitude: "",
        longitude: "",
        expected: { ...BASE_INPUT.expected, latitude: "0.5", longitude: "-79.2" },
      });
      const patch = updateEntityMock.mock.calls[0][3];
      expect(patch.data.latitude).toBe("");
      expect(patch.data.longitude).toBe("");
      expect(patch.data.geometry).toBe("");
    });

    it("detects a conflict when landowner/notes changed upstream and does NOT PATCH", async () => {
      fetchEntityMock.mockResolvedValue(liveMatchingExpected({ landowner_phone: "0777777777" }));
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("actualizado por otra persona");
      expect(updateEntityMock).not.toHaveBeenCalled();
    });

    it("still succeeds (with a warning) when the Sheet sync fails — ODK is committed", async () => {
      updateScheduleRowsMock.mockRejectedValue(new Error("sheets down"));
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.warnings.length).toBeGreaterThan(0);
        expect(result.data.warnings[0]).toContain("ODK");
      }
      // The ODK write still happened.
      expect(updateEntityMock).toHaveBeenCalledTimes(1);
    });

    it("warns when the site_name column is missing (silent no-op detected)", async () => {
      updateScheduleRowsMock.mockResolvedValue({ matchedRows: 2, cellsWritten: 0 });
      const result = await updateSiteEntity(BASE_INPUT);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.warnings.some((w) => w.includes("site_name"))).toBe(true);
      }
    });
  });
});
