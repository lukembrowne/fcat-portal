import { describe, it, expect } from "vitest";

import {
  STAGE_LABEL,
  STAGE_HINT,
  STAGE_TONE,
  STAGE_FILTERS,
  stageLabel,
  stageHint,
  stageTone,
  rowAction,
} from "../labels";

/**
 * Mirrors the `CampaignStatus` union in `@/lib/birdnet-validation/types`, which
 * in turn mirrors the SQLite CHECK constraint. Restated here as data so the
 * totality assertions below iterate over it — a type union cannot be enumerated
 * at runtime, and `Record<CampaignStatus, string>` only proves totality at
 * compile time for object literals, not for a value arriving from the database.
 */
const ALL_STATUSES = [
  "draft",
  "sampled",
  "reviewing",
  "fitted",
  "unusable",
  "applied",
  "abandoned",
] as const;

describe("stage vocabulary", () => {
  it("labels every status the schema can produce", () => {
    for (const status of ALL_STATUSES) {
      expect(STAGE_LABEL[status], `missing label for ${status}`).toBeTruthy();
    }
    expect(Object.keys(STAGE_LABEL).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("gives every status a next-step hint", () => {
    for (const status of ALL_STATUSES) {
      expect(STAGE_HINT[status], `missing hint for ${status}`).toBeTruthy();
    }
    expect(Object.keys(STAGE_HINT).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("never says 'campaña' or 'campaign'", () => {
    // The regression guard for R7. The word describes the table, not the task,
    // and is easy to reintroduce by copying an older string.
    const strings = [...Object.values(STAGE_LABEL), ...Object.values(STAGE_HINT)];
    for (const text of strings) {
      expect(text.toLowerCase()).not.toContain("campañ");
      expect(text.toLowerCase()).not.toContain("campaign");
    }
  });

  it("falls back to the raw value for an unknown status", () => {
    // Defensive: a status added to the schema but not here should render as
    // itself rather than as "undefined".
    expect(stageLabel("some_new_status")).toBe("some_new_status");
    expect(stageHint("some_new_status")).toBeNull();
  });

  it("resolves a known status through the helpers", () => {
    expect(stageLabel("applied")).toBe(STAGE_LABEL.applied);
    expect(stageHint("applied")).toBe(STAGE_HINT.applied);
  });
});

describe("stage tones", () => {
  it("gives every status a tone", () => {
    for (const status of ALL_STATUSES) {
      expect(STAGE_TONE[status], `missing tone for ${status}`).toBeTruthy();
    }
    expect(Object.keys(STAGE_TONE).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("does not colour 'sin umbral utilizable' as an error", () => {
    // Load-bearing, not cosmetic. Most species BirdNET reports have no true
    // positives at any score, so `unusable` is the expected outcome of a
    // correctly-run validation. Painting it red teaches every reader the
    // opposite of what this module exists to establish.
    for (const alarming of ["red-", "rose-", "destructive"]) {
      expect(STAGE_TONE.unusable).not.toContain(alarming);
    }
  });

  it("reserves the alarm tone for a human decision to stop", () => {
    expect(STAGE_TONE.abandoned).toContain("rose-");
  });

  it("falls back to a real, unalarming tone for an unknown status", () => {
    // A status added to the schema but not here must still render a pill
    // rather than an unstyled fragment of class string — and must not borrow
    // draft's amber, which now means "this species' draw failed".
    const fallback = stageTone("some_new_status");
    expect(fallback).toContain("border-");
    expect(fallback).not.toBe(STAGE_TONE.draft);
    expect(stageTone("applied")).toBe(STAGE_TONE.applied);
  });

  it("marks draft as needing attention", () => {
    // Draft is no longer a starting point — it is reachable only when the
    // draw failed at creation, so it is the one stage that wants a nudge.
    expect(STAGE_TONE.draft).toContain("amber-");
  });
});

describe("STAGE_FILTERS", () => {
  it("defaults the list to in-progress species, with an explicit escape", () => {
    expect(STAGE_FILTERS[0].value).toBe("activas");
    expect(STAGE_FILTERS.map((o) => o.value)).toContain("todas");
  });

  it("offers every individual stage as well", () => {
    const values = STAGE_FILTERS.map((o) => o.value);
    for (const status of ALL_STATUSES) {
      expect(values, `missing filter for ${status}`).toContain(status);
    }
  });

  it("labels each stage exactly as the table does", () => {
    for (const option of STAGE_FILTERS) {
      if (option.value === "activas" || option.value === "todas") continue;
      expect(option.label).toBe(stageLabel(option.value));
    }
  });
});

describe("rowAction", () => {
  it("offers review once a sample exists", () => {
    expect(rowAction(200)).toMatchObject({ label: "Revisar", suffix: "/revisar" });
  });

  it("offers preparation when nothing has been sampled", () => {
    // Sending someone to an empty review queue is worse than sending them to
    // the page that holds the controls.
    expect(rowAction(0)).toMatchObject({ label: "Preparar", suffix: "" });
  });

  it("treats a single sampled clip as reviewable", () => {
    expect(rowAction(1).label).toBe("Revisar");
  });

  it("returns an icon IDENTIFIER, never a component", () => {
    // React components cannot cross the Server→Client boundary as props, and
    // `npm run build` does not catch it — the failure is at runtime.
    for (const sampled of [0, 1, 200]) {
      expect(typeof rowAction(sampled).icon).toBe("string");
    }
  });

  it("explains where each action goes", () => {
    // The row has two destinations. An unlabelled pair reads as one control
    // behaving inconsistently, which is the confusion this fixes.
    for (const sampled of [0, 200]) {
      expect(rowAction(sampled).title.length).toBeGreaterThan(10);
    }
    expect(rowAction(200).title).not.toBe(rowAction(0).title);
  });
});
