import { describe, it, expect } from "vitest";

import {
  filterCampaignRows,
  sortCampaignRows,
  SORTABLE_COLUMNS,
  type CampaignRow,
} from "../campaign-table";

const row = (over: Partial<CampaignRow>): CampaignRow =>
  ({
    id: 1,
    species: "Aaa aaa",
    displayName: "Aaa",
    status: "fitted",
    targetSampleSize: 200,
    binCount: 9,
    triageSize: 10,
    triageTruePositives: null,
    abandonedReason: null,
    notes: null,
    sampled: 200,
    reviewed: 100,
    correct: 50,
    incorrect: 45,
    uncertain: 5,
    createdBy: "a@b.c",
    reviewerCount: 1,
    primaryReviewerEmail: null,
    appliedThreshold: null,
    latestThreshold: null,
    unusableReason: null,
    totalDetections: 1000,
    ...over,
  }) as CampaignRow;

describe("sortCampaignRows", () => {
  it("sorts by display name ascending and descending", () => {
    const rows = [
      row({ id: 1, displayName: "Tucán" }),
      row({ id: 2, displayName: "Búho" }),
      row({ id: 3, displayName: "Manakín" }),
    ];
    expect(sortCampaignRows(rows, "species", "asc").map((r) => r.displayName)).toEqual([
      "Búho",
      "Manakín",
      "Tucán",
    ]);
    expect(sortCampaignRows(rows, "species", "desc").map((r) => r.displayName)).toEqual([
      "Tucán",
      "Manakín",
      "Búho",
    ]);
  });

  it("sorts progress numerically by reviewed count, not lexically", () => {
    const rows = [row({ id: 1, reviewed: 9 }), row({ id: 2, reviewed: 100 })];
    expect(sortCampaignRows(rows, "progress", "asc").map((r) => r.reviewed)).toEqual([
      9, 100,
    ]);
  });

  it("sorts by precision derived from correct/reviewed", () => {
    const rows = [
      row({ id: 1, reviewed: 100, correct: 90 }),
      row({ id: 2, reviewed: 100, correct: 10 }),
    ];
    expect(sortCampaignRows(rows, "precision", "desc").map((r) => r.id)).toEqual([1, 2]);
  });

  it("prefers the applied threshold over the latest fit when sorting", () => {
    const rows = [
      row({ id: 1, appliedThreshold: 0.2, latestThreshold: 0.9 }),
      row({ id: 2, appliedThreshold: null, latestThreshold: 0.5 }),
    ];
    expect(sortCampaignRows(rows, "threshold", "asc").map((r) => r.id)).toEqual([1, 2]);
  });

  it("sorts rows with no threshold last in BOTH directions", () => {
    // A species with no threshold is absent, not smallest — burying it under
    // real values either way is what a reader expects.
    const rows = [
      row({ id: 1, latestThreshold: 0.5 }),
      row({ id: 2, latestThreshold: null }),
      row({ id: 3, latestThreshold: 0.9 }),
    ];
    expect(sortCampaignRows(rows, "threshold", "asc").map((r) => r.id)).toEqual([1, 3, 2]);
    expect(sortCampaignRows(rows, "threshold", "desc").map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it("sorts rows with zero reviews last on precision in both directions", () => {
    const rows = [
      row({ id: 1, reviewed: 10, correct: 5 }),
      row({ id: 2, reviewed: 0, correct: 0 }),
    ];
    expect(sortCampaignRows(rows, "precision", "asc").map((r) => r.id)).toEqual([1, 2]);
    expect(sortCampaignRows(rows, "precision", "desc").map((r) => r.id)).toEqual([1, 2]);
  });

  it("breaks ties on id so ordering is stable across pages", () => {
    const rows = [
      row({ id: 3, reviewed: 10 }),
      row({ id: 1, reviewed: 10 }),
      row({ id: 2, reviewed: 10 }),
    ];
    expect(sortCampaignRows(rows, "progress", "asc").map((r) => r.id)).toEqual([1, 2, 3]);
    expect(sortCampaignRows(rows, "progress", "desc").map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ id: 2 }), row({ id: 1 })];
    const before = rows.map((r) => r.id);
    sortCampaignRows(rows, "species", "asc");
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("sorts by reviewer count in both directions", () => {
    const rows = [
      row({ id: 1, reviewerCount: 1 }),
      row({ id: 2, reviewerCount: 3 }),
      row({ id: 3, reviewerCount: 0 }),
    ];
    expect(sortCampaignRows(rows, "reviewers", "desc").map((r) => r.id)).toEqual([
      2, 1, 3,
    ]);
    expect(sortCampaignRows(rows, "reviewers", "asc").map((r) => r.id)).toEqual([
      3, 1, 2,
    ]);
  });

  it("treats a zero reviewer count as a value, not a missing one", () => {
    // Nulls sort last in both directions; 0 is a real count and must not.
    const rows = [row({ id: 1, reviewerCount: 0 }), row({ id: 2, reviewerCount: 2 })];
    expect(sortCampaignRows(rows, "reviewers", "asc").map((r) => r.id)).toEqual([1, 2]);
  });

  it("sorts by the rendered stage label, not the raw status value", () => {
    // "applied" < "draft" as raw strings, but the reader sees "Umbral aplicado"
    // and "Sin preparar" — sorting must follow what is on screen.
    const rows = [row({ id: 1, status: "applied" }), row({ id: 2, status: "draft" })];
    expect(sortCampaignRows(rows, "status", "asc").map((r) => r.id)).toEqual([2, 1]);
  });

  it("keeps the action column out of the sortable set", () => {
    // The column holds a link, not an orderable value.
    expect(SORTABLE_COLUMNS).not.toContain("action" as never);
    expect(SORTABLE_COLUMNS).toEqual([
      "species",
      "status",
      "progress",
      "reviewers",
      "precision",
      "threshold",
      "notes",
    ]);
  });

  it("sorts by notes and keeps the ones without a note last in both directions", () => {
    // Sorting by this column is how a reader pulls the annotated species to
    // the top; an empty note is absent, not "smallest".
    const rows = [
      row({ id: 1, notes: null }),
      row({ id: 2, notes: "Zona equivocada" }),
      row({ id: 3, notes: "Ave rara. REVISAR" }),
    ];
    expect(sortCampaignRows(rows, "notes", "asc").map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortCampaignRows(rows, "notes", "desc").map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("treats an empty note as absent, not as a value that sorts first", () => {
    const rows = [row({ id: 1, notes: "" }), row({ id: 2, notes: "algo" })];
    expect(sortCampaignRows(rows, "notes", "asc").map((r) => r.id)).toEqual([2, 1]);
  });

  it("drops the sample-size column, which was the same number every row", () => {
    // 200 for every drawn species, 0 for every undrawn one. It now rides along
    // as the denominator of `progress` instead of costing its own column.
    expect(SORTABLE_COLUMNS).not.toContain("sampled" as never);
  });
});

describe("filterCampaignRows", () => {
  const rows = [
    row({ id: 1, species: "Ramphastos ambiguus", displayName: "Tucán del Chocó", status: "reviewing" }),
    row({ id: 2, species: "Megascops centralis", displayName: "Búho", status: "draft" }),
    row({ id: 3, species: "Ortalis erythroptera", displayName: "Chachalaca", status: "abandoned" }),
    row({ id: 4, species: "Attila torridus", displayName: "Atila Ocráceo", status: "applied" }),
  ];

  const ids = (out: CampaignRow[]) => out.map((r) => r.id);

  it("hides discarded species by default", () => {
    expect(ids(filterCampaignRows(rows, { search: "", status: "activas" }))).toEqual([
      1, 2, 4,
    ]);
  });

  it("shows everything on 'todas'", () => {
    expect(ids(filterCampaignRows(rows, { search: "", status: "todas" }))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("narrows to a single stage", () => {
    expect(ids(filterCampaignRows(rows, { search: "", status: "draft" }))).toEqual([2]);
    expect(ids(filterCampaignRows(rows, { search: "", status: "abandoned" }))).toEqual([3]);
  });

  it("matches a scientific name", () => {
    expect(ids(filterCampaignRows(rows, { search: "Ramphastos", status: "todas" }))).toEqual([1]);
  });

  it("matches a display name", () => {
    expect(ids(filterCampaignRows(rows, { search: "Chachalaca", status: "todas" }))).toEqual([3]);
  });

  it("matches the notes, which is how the imported CHECK flag is found", () => {
    const annotated = [
      row({ id: 1, species: "Aaa aaa", displayName: "Aaa", notes: "Not on JF list. CHECK" }),
      row({ id: 2, species: "Bbb bbb", displayName: "Bbb", notes: "confirmada" }),
      row({ id: 3, species: "Ccc ccc", displayName: "Ccc", notes: null }),
    ];
    expect(ids(filterCampaignRows(annotated, { search: "check", status: "todas" }))).toEqual([1]);
  });

  it("matches case- and diacritic-insensitively", () => {
    // Same normalisation the picker and the bulk importer use, so all three
    // agree on what counts as the same name.
    expect(ids(filterCampaignRows(rows, { search: "buho", status: "todas" }))).toEqual([2]);
    expect(ids(filterCampaignRows(rows, { search: "TUCAN", status: "todas" }))).toEqual([1]);
    expect(ids(filterCampaignRows(rows, { search: "ocraceo", status: "todas" }))).toEqual([4]);
  });

  it("matches on a substring, not just a prefix", () => {
    expect(ids(filterCampaignRows(rows, { search: "ambiguus", status: "todas" }))).toEqual([1]);
  });

  it("returns every row for an empty search", () => {
    expect(filterCampaignRows(rows, { search: "", status: "todas" })).toHaveLength(4);
    expect(filterCampaignRows(rows, { search: "   ", status: "todas" })).toHaveLength(4);
  });

  it("applies stage and search together", () => {
    // A name that matches but whose stage is excluded must not appear.
    expect(ids(filterCampaignRows(rows, { search: "Chachalaca", status: "activas" }))).toEqual([]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCampaignRows(rows, { search: "zzz", status: "todas" })).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    filterCampaignRows(input, { search: "buho", status: "activas" });
    expect(input).toHaveLength(4);
  });

  it("composes with sorting without either reordering the other", () => {
    // Filter-then-sort must give the same order as sorting the pre-filtered
    // set, or the table's order would depend on which ran first.
    const filter = { search: "", status: "activas" as const };
    const filterThenSort = sortCampaignRows(
      filterCampaignRows(rows, filter),
      "species",
      "asc"
    );
    const sortThenFilter = filterCampaignRows(
      sortCampaignRows(rows, "species", "asc"),
      filter
    );
    expect(ids(filterThenSort)).toEqual(ids(sortThenFilter));
  });
});
