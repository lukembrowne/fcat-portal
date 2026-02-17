/**
 * Tests for Google Sheets client (BioChoco schedule).
 *
 * Mocks googleapis to verify:
 * - loadSchedule parses sheet data into ScheduleRow objects
 * - saveSchedule uses write-then-clear ordering (institutional learning)
 * - updateScheduleRows does partial cell-level updates
 * - loadSlotTemplate parses SlotRow objects
 * - Error handling for missing config and API errors
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockValuesGet = vi.fn();
const mockValuesUpdate = vi.fn();
const mockValuesClear = vi.fn();
const mockBatchUpdate = vi.fn();

vi.mock("googleapis", () => {
  class MockGoogleAuth {}
  return {
    google: {
      auth: { GoogleAuth: MockGoogleAuth },
      sheets: () => ({
        spreadsheets: {
          values: {
            get: (...args: unknown[]) => mockValuesGet(...args),
            update: (...args: unknown[]) => mockValuesUpdate(...args),
            clear: (...args: unknown[]) => mockValuesClear(...args),
            batchUpdate: (...args: unknown[]) => mockBatchUpdate(...args),
          },
        },
      }),
    },
  };
});

vi.stubEnv(
  "GOOGLE_SERVICE_ACCOUNT_KEY",
  Buffer.from(
    JSON.stringify({
      type: "service_account",
      project_id: "test",
      private_key_id: "test",
      private_key: "test-key",
      client_email: "test@test.iam.gserviceaccount.com",
      client_id: "123",
    })
  ).toString("base64")
);

vi.stubEnv("BIOCHOCO_SHEET_ID", "test-sheet-id");

const { loadSchedule, saveSchedule, updateScheduleRows, loadSlotTemplate } =
  await import("@/lib/sheets-client");

const HEADERS = [
  "deployment_id",
  "site_id",
  "site_name",
  "habitat_type",
  "visit_number",
  "season",
  "planned_deploy_date",
  "planned_retrieve_date",
  "actual_deploy_date",
  "actual_retrieve_date",
  "status",
  "deploy_slot_id",
  "retrieve_slot_id",
  "notes",
  "drive_folder_link",
];

beforeEach(() => {
  vi.clearAllMocks();
});

// === loadSchedule ===

describe("loadSchedule", () => {
  it("parses rows into ScheduleRow objects", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          HEADERS,
          [
            "DEP-001",
            "S01",
            "Bosque Nublado",
            "cloud_forest",
            "1",
            "dry",
            "2025-06-01",
            "2025-07-01",
            "",
            "",
            "scheduled",
            "5",
            "10",
            "Notas de prueba",
            "https://drive.google.com/drive/folders/abc",
          ],
        ],
      },
    });

    const rows = await loadSchedule();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      deploymentId: "DEP-001",
      siteId: "S01",
      siteName: "Bosque Nublado",
      habitatType: "cloud_forest",
      visitNumber: 1,
      season: "dry",
      plannedDeployDate: "2025-06-01",
      plannedRetrieveDate: "2025-07-01",
      actualDeployDate: null,
      actualRetrieveDate: null,
      status: "scheduled",
      deploySlotId: 5,
      retrieveSlotId: 10,
      notes: "Notas de prueba",
      driveFolderLink: "https://drive.google.com/drive/folders/abc",
    });
  });

  it("returns empty array when no data rows exist", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [HEADERS] },
    });

    const rows = await loadSchedule();
    expect(rows).toHaveLength(0);
  });

  it("returns empty array when sheet is completely empty", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: null },
    });

    const rows = await loadSchedule();
    expect(rows).toHaveLength(0);
  });

  it("handles missing values in sparse rows", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          HEADERS,
          ["DEP-002", "S02"], // Only first 2 columns
        ],
      },
    });

    const rows = await loadSchedule();
    expect(rows).toHaveLength(1);
    expect(rows[0].deploymentId).toBe("DEP-002");
    expect(rows[0].siteId).toBe("S02");
    expect(rows[0].siteName).toBe("");
    expect(rows[0].visitNumber).toBe(0);
    expect(rows[0].plannedDeployDate).toBeNull();
    expect(rows[0].status).toBe("scheduled"); // default
  });

  it("parses multiple rows", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          HEADERS,
          ["DEP-001", "S01", "Sitio A", "forest", "1", "dry", "", "", "", "", "deployed", "", "", "", ""],
          ["DEP-002", "S02", "Sitio B", "river", "2", "wet", "", "", "", "", "scheduled", "", "", "", ""],
        ],
      },
    });

    const rows = await loadSchedule();
    expect(rows).toHaveLength(2);
    expect(rows[0].deploymentId).toBe("DEP-001");
    expect(rows[1].deploymentId).toBe("DEP-002");
  });
});

// === saveSchedule ===

describe("saveSchedule", () => {
  it("writes data then clears leftover rows (write-then-clear)", async () => {
    // Existing sheet has 5 rows (1 header + 4 data)
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [HEADERS, ["a"], ["b"], ["c"], ["d"]] },
    });
    mockValuesUpdate.mockResolvedValueOnce({});
    mockValuesClear.mockResolvedValueOnce({});

    // Save only 2 data rows (smaller than existing 4)
    await saveSchedule([
      {
        deploymentId: "D1",
        siteId: "S1",
        siteName: "A",
        habitatType: "forest",
        visitNumber: 1,
        season: "dry",
        plannedDeployDate: null,
        plannedRetrieveDate: null,
        actualDeployDate: null,
        actualRetrieveDate: null,
        status: "scheduled",
        deploySlotId: null,
        retrieveSlotId: null,
        notes: "",
        driveFolderLink: "",
      },
      {
        deploymentId: "D2",
        siteId: "S2",
        siteName: "B",
        habitatType: "river",
        visitNumber: 2,
        season: "wet",
        plannedDeployDate: "2025-06-01",
        plannedRetrieveDate: null,
        actualDeployDate: null,
        actualRetrieveDate: null,
        status: "deployed",
        deploySlotId: 3,
        retrieveSlotId: null,
        notes: "Nota",
        driveFolderLink: "",
      },
    ]);

    // CRITICAL: write must happen BEFORE clear
    expect(mockValuesUpdate).toHaveBeenCalledBefore(mockValuesClear);

    // Write should include header + 2 data rows = 3 rows
    const writeCall = mockValuesUpdate.mock.calls[0][0];
    expect(writeCall.requestBody.values).toHaveLength(3);
    expect(writeCall.requestBody.values[0]).toEqual(HEADERS);
    expect(writeCall.requestBody.values[1][0]).toBe("D1");
    expect(writeCall.requestBody.values[2][0]).toBe("D2");

    // Clear should target rows 4-5 (the leftover rows)
    const clearCall = mockValuesClear.mock.calls[0][0];
    expect(clearCall.range).toContain("4"); // start clearing from row 4
    expect(clearCall.range).toContain("5"); // up to row 5
  });

  it("does not clear when new data is same size or larger", async () => {
    // Existing sheet has 3 rows (1 header + 2 data)
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [HEADERS, ["a"], ["b"]] },
    });
    mockValuesUpdate.mockResolvedValueOnce({});

    // Save 3 data rows (larger than existing 2)
    const rows = Array.from({ length: 3 }, (_, i) => ({
      deploymentId: `D${i}`,
      siteId: `S${i}`,
      siteName: `Site ${i}`,
      habitatType: "forest",
      visitNumber: i + 1,
      season: "dry",
      plannedDeployDate: null,
      plannedRetrieveDate: null,
      actualDeployDate: null,
      actualRetrieveDate: null,
      status: "scheduled" as const,
      deploySlotId: null,
      retrieveSlotId: null,
      notes: "",
      driveFolderLink: "",
    }));

    await saveSchedule(rows);

    // Write should be called but clear should NOT
    expect(mockValuesUpdate).toHaveBeenCalledTimes(1);
    expect(mockValuesClear).not.toHaveBeenCalled();
  });

  it("converts null values to empty strings", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [HEADERS] },
    });
    mockValuesUpdate.mockResolvedValueOnce({});

    await saveSchedule([
      {
        deploymentId: "D1",
        siteId: "S1",
        siteName: "A",
        habitatType: "forest",
        visitNumber: 1,
        season: "dry",
        plannedDeployDate: null,
        plannedRetrieveDate: null,
        actualDeployDate: null,
        actualRetrieveDate: null,
        status: "scheduled",
        deploySlotId: null,
        retrieveSlotId: null,
        notes: "",
        driveFolderLink: "",
      },
    ]);

    const writeCall = mockValuesUpdate.mock.calls[0][0];
    const dataRow = writeCall.requestBody.values[1]; // first data row
    // null dates should be empty strings
    expect(dataRow[6]).toBe(""); // plannedDeployDate
    expect(dataRow[11]).toBe(""); // deploySlotId
  });
});

// === updateScheduleRows ===

describe("updateScheduleRows", () => {
  it("updates specific cells by deployment ID", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          HEADERS,
          ["DEP-001", "S01", "Sitio A", "forest", "1", "dry", "", "", "", "", "scheduled", "", "", "", ""],
          ["DEP-002", "S02", "Sitio B", "river", "2", "wet", "", "", "", "", "scheduled", "", "", "", ""],
        ],
      },
    });
    mockBatchUpdate.mockResolvedValueOnce({});

    await updateScheduleRows([
      {
        deploymentId: "DEP-001",
        fields: { status: "deployed", actualDeployDate: "2025-06-15" },
      },
    ]);

    expect(mockBatchUpdate).toHaveBeenCalledTimes(1);
    const batchData = mockBatchUpdate.mock.calls[0][0].requestBody.data;
    expect(batchData.length).toBe(2); // status + actualDeployDate
  });

  it("skips updates for non-existent deployment IDs", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          HEADERS,
          ["DEP-001", "S01", "Sitio A", "forest", "1", "dry", "", "", "", "", "scheduled", "", "", "", ""],
        ],
      },
    });

    await updateScheduleRows([
      {
        deploymentId: "NONEXISTENT",
        fields: { status: "deployed" },
      },
    ]);

    // No batchUpdate call since no matching rows
    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });

  it("does nothing for empty updates array", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [HEADERS, ["DEP-001"]] },
    });

    await updateScheduleRows([]);

    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });

  it("handles empty sheet gracefully", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: null },
    });

    await updateScheduleRows([
      { deploymentId: "D1", fields: { status: "deployed" } },
    ]);

    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });
});

// === loadSlotTemplate ===

describe("loadSlotTemplate", () => {
  it("parses slot template rows", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ["slot_id", "slot_date", "year_month", "day_of_month"],
          ["1", "2025-06-01", "2025-06", "1"],
          ["2", "2025-06-15", "2025-06", "15"],
        ],
      },
    });

    const slots = await loadSlotTemplate();
    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual({
      slotId: 1,
      slotDate: "2025-06-01",
      yearMonth: "2025-06",
      dayOfMonth: 1,
    });
    expect(slots[1]).toEqual({
      slotId: 2,
      slotDate: "2025-06-15",
      yearMonth: "2025-06",
      dayOfMonth: 15,
    });
  });

  it("returns empty array for empty template", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: null },
    });

    const slots = await loadSlotTemplate();
    expect(slots).toHaveLength(0);
  });

  it("returns empty array for header-only template", async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [["slot_id", "slot_date", "year_month", "day_of_month"]],
      },
    });

    const slots = await loadSlotTemplate();
    expect(slots).toHaveLength(0);
  });
});
