/**
 * Permission guard tests for biochoco, finance, climate, and giz server actions.
 *
 * Verifies every exported function calls requirePermission(project, role)
 * with the correct project and minimum role.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";
import { setupDbMock } from "../helpers/mock-db";

setupAuthMocks();
setupDbMock();

vi.mock("@/db/schema", () => ({
  users: "users",
  projects: "projects",
  userPermissions: "userPermissions",
  deployments: "deployments",
  processingJobs: "processingJobs",
  images: "images",
  detections: "detections",
  identifications: "identifications",
  species: "species",
  activityLog: "activityLog",
  financeTransactions: "financeTransactions",
  financeBudgetItems: "financeBudgetItems",
  financeCategoryMap: "financeCategoryMap",
  financeSueldosGrants: "financeSueldosGrants",
  financeSueldosTotals: "financeSueldosTotals",
  financeProjections: "financeProjections",
  financeUploads: "financeUploads",
  climateReadings: "climateReadings",
  climateUploads: "climateUploads",
  climateEdits: "climateEdits",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  count: vi.fn(),
  sum: vi.fn(),
  isNotNull: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Biochoco dependencies
vi.mock("@/lib/odk-client", () => ({
  fetchEntities: vi.fn(async () => []),
  fetchSubmissions: vi.fn(async () => []),
  parseWktPoint: vi.fn(() => null),
}));

vi.mock("@/lib/odk-constants", () => ({
  BIOCHOCO_PROJECT_ID: 1,
  BIOCHOCO_DATASET_SITES: "sites",
  BIOCHOCO_FORM_DEPLOY: "deploy",
  BIOCHOCO_FORM_RETRIEVE: "retrieve",
  BIOCHOCO_FORM_HABITAT: "habitat",
  BIOCHOCO_DATASET_HABITAT: "habitat",
  GIZ_PROJECT_ID: 2,
  GIZ_FORM_CACAO_MONITORING: "cacao",
  GIZ_FORM_TREE_PLANTING: "tree",
}));

vi.mock("@/lib/sheets-client", () => ({
  loadSchedule: vi.fn(async () => []),
  saveSchedule: vi.fn(),
  loadSlotTemplate: vi.fn(async () => []),
  updateScheduleRows: vi.fn(),
}));

vi.mock("@/lib/drive-client", () => ({
  checkDeploymentUploads: vi.fn(async () => []),
  extractFolderId: vi.fn(() => null),
}));

// Finance dependencies
vi.mock("@/app/finance/lib/parse-libro-mayor", () => ({
  parseLibroMayor: vi.fn(),
}));

vi.mock("@/app/finance/lib/parse-budget", () => ({
  parseBudgetExcel: vi.fn(),
}));

vi.mock("@/app/finance/lib/parse-category-link", () => ({
  parseCategoryLinkExcel: vi.fn(),
}));

vi.mock("@/app/finance/lib/parse-sueldos", () => ({
  parseSueldosExcel: vi.fn(),
}));

vi.mock("@/app/finance/lib/calculations", () => ({
  budgetProportionByDay: vi.fn(() => 0),
  dayOfYear: vi.fn(() => 1),
  monthSequence: vi.fn(() => []),
}));

vi.mock("@/app/finance/constants", () => ({
  SUELDO_CATEGORIES: [],
}));

// Climate dependencies
vi.mock("@/app/climate/upload/parser", () => ({
  parseTOA5File: vi.fn(),
  detectAnomalies: vi.fn(() => []),
}));

// --- Import all action modules ---

const biochocoOverview = await import("@/app/biochoco/overview/actions");
const biochocoHabitat = await import("@/app/biochoco/habitat/actions");
const biochocoTools = await import("@/app/biochoco/tools/actions");
const biochocoData = await import("@/app/biochoco/data/actions");
const financeRevenue = await import("@/app/finance/revenue/actions");
const financeExpenses = await import("@/app/finance/expenses/actions");
const financeBudget = await import("@/app/finance/budget/actions");
const financeCashflow = await import("@/app/finance/cashflow/actions");
const financeSueldos = await import("@/app/finance/sueldos/actions");
const financeAnnual = await import("@/app/finance/annual/actions");
const financeData = await import("@/app/finance/data/actions");
const climateUpload = await import("@/app/climate/upload/actions");
const climateDashboard = await import("@/app/climate/dashboard/actions");
const gizCacao = await import("@/app/giz/cacao-monitoring/actions");
const gizTree = await import("@/app/giz/tree-planting/actions");

// --- Tests ---

describe("action permission guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePermission.mockResolvedValue(testUser);
  });

  async function expectPermission(
    fn: Function,
    project: string,
    role: string,
    args: unknown[] = []
  ) {
    try {
      await fn(...args);
    } catch {
      // May throw after auth check due to mocked dependencies
    }
    expect(mockRequirePermission).toHaveBeenCalledWith(project, role);
  }

  // ===== Biochoco =====

  describe("biochoco", () => {
    it("fetchBiochocoData requires biochoco viewer", () =>
      expectPermission(biochocoOverview.fetchBiochocoData, "biochoco", "viewer"));

    it("fetchHabitatData requires biochoco viewer", () =>
      expectPermission(biochocoHabitat.fetchHabitatData, "biochoco", "viewer"));

    describe("tools (admin)", () => {
      const adminActions: [string, Function, unknown[]][] = [
        ["fetchToolsData", biochocoTools.fetchToolsData, []],
        ["previewBulkShift", biochocoTools.previewBulkShift, [1, false]],
        ["commitBulkShift", biochocoTools.commitBulkShift, [1, false, "abc"]],
        ["previewDateSwap", biochocoTools.previewDateSwap, ["A", "B"]],
        ["commitDateSwap", biochocoTools.commitDateSwap, ["A", "B", "abc"]],
        ["getAvailableSites", biochocoTools.getAvailableSites, []],
        ["previewAddSite", biochocoTools.previewAddSite, ["S1", "Site 1", "bosque"]],
        ["commitAddSite", biochocoTools.commitAddSite, ["S1", "Site 1", "bosque", "abc"]],
        ["runValidation", biochocoTools.runValidation, []],
        ["previewSyncOdk", biochocoTools.previewSyncOdk, []],
        ["commitSyncOdk", biochocoTools.commitSyncOdk, [["d1"]]],
      ];

      for (const [name, fn, args] of adminActions) {
        it(`${name} requires biochoco admin`, () =>
          expectPermission(fn, "biochoco", "admin", args));
      }
    });

    describe("data (viewer)", () => {
      const viewerActions: [string, Function, unknown[]][] = [
        ["checkSingleDeployment", biochocoData.checkSingleDeployment, ["folder-id"]],
        ["fetchSchedule", biochocoData.fetchSchedule, []],
        ["checkDriveForDeployments", biochocoData.checkDriveForDeployments, []],
      ];

      for (const [name, fn, args] of viewerActions) {
        it(`${name} requires biochoco viewer`, () =>
          expectPermission(fn, "biochoco", "viewer", args));
      }
    });
  });

  // ===== Finance =====

  describe("finance", () => {
    describe("viewer-level", () => {
      const viewerActions: [string, Function, unknown[]][] = [
        ["fetchRevenueData", financeRevenue.fetchRevenueData, [2026]],
        ["fetchExpenseData", financeExpenses.fetchExpenseData, [2026]],
        ["fetchBudgetData", financeBudget.fetchBudgetData, []],
        ["fetchCashflowData", financeCashflow.fetchCashflowData, []],
        ["fetchSueldosData", financeSueldos.fetchSueldosData, [2026]],
        ["fetchAnnualData", financeAnnual.fetchAnnualData, []],
        ["fetchLastUploads", financeData.fetchLastUploads, []],
      ];

      for (const [name, fn, args] of viewerActions) {
        it(`${name} requires finance viewer`, () =>
          expectPermission(fn, "finance", "viewer", args));
      }
    });

    describe("admin-level", () => {
      const adminActions: [string, Function, unknown[]][] = [
        ["previewLibroMayor", financeData.previewLibroMayor, [new FormData()]],
        ["commitLibroMayor", financeData.commitLibroMayor, [new FormData()]],
        ["commitBudget", financeData.commitBudget, [new FormData()]],
        ["commitCategoryLink", financeData.commitCategoryLink, [new FormData()]],
        ["commitSueldos", financeData.commitSueldos, [new FormData()]],
        ["addProjection", financeCashflow.addProjection, [new FormData()]],
        ["updateProjection", financeCashflow.updateProjection, [new FormData()]],
        ["deleteProjection", financeCashflow.deleteProjection, [new FormData()]],
      ];

      for (const [name, fn, args] of adminActions) {
        it(`${name} requires finance admin`, () =>
          expectPermission(fn, "finance", "admin", args));
      }
    });
  });

  // ===== Climate =====

  describe("climate", () => {
    it("previewDatFile requires climate editor", () =>
      expectPermission(climateUpload.previewDatFile, "climate", "editor", [new FormData()]));

    it("commitDatFile requires climate editor", () =>
      expectPermission(climateUpload.commitDatFile, "climate", "editor", [new FormData()]));

    it("fetchLastClimateUploads requires climate viewer", () =>
      expectPermission(climateUpload.fetchLastClimateUploads, "climate", "viewer"));

    describe("dashboard (viewer)", () => {
      const viewerActions: [string, Function, unknown[]][] = [
        ["fetchAvailableYears", climateDashboard.fetchAvailableYears, ["15min"]],
        ["fetchClimateReadingCount", climateDashboard.fetchClimateReadingCount, ["15min"]],
        ["fetchClimateSummary", climateDashboard.fetchClimateSummary, [2026, "15min"]],
        ["fetchClimateChartData", climateDashboard.fetchClimateChartData, [{ year: 2026, month: 1, field: "temp_avg", resolution: "15min" }]],
        ["fetchClimateTablePage", climateDashboard.fetchClimateTablePage, [{ year: 2026, month: 1, resolution: "15min", page: 1, pageSize: 50 }]],
        ["fetchClimateExportData", climateDashboard.fetchClimateExportData, [{ year: 2026, month: 1, resolution: "15min" }]],
      ];

      for (const [name, fn, args] of viewerActions) {
        it(`${name} requires climate viewer`, () =>
          expectPermission(fn, "climate", "viewer", args));
      }
    });

    it("nullClimateValue requires climate editor", () =>
      expectPermission(climateDashboard.nullClimateValue, "climate", "editor", [{ id: 1, field: "temp_avg" }]));
  });

  // ===== GIZ =====

  describe("giz", () => {
    it("fetchCacaoData requires giz viewer", () =>
      expectPermission(gizCacao.fetchCacaoData, "giz", "viewer"));

    it("fetchTreeData requires giz viewer", () =>
      expectPermission(gizTree.fetchTreeData, "giz", "viewer"));
  });
});
