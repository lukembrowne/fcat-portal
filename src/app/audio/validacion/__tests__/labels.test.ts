import { describe, it, expect } from "vitest";

import {
  STAGE_LABEL,
  STAGE_HINT,
  STAGE_TONE,
  STAGE_FILTERS,
  PRIORITY_LABEL,
  PRIORITY_HINT,
  PRIORITY_TONE,
  PRIORITY_RANK,
  PRIORITY_FILTERS,
  priorityLabel,
  priorityRank,
  priorityTone,
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

/** Mirrors `CampaignPriority`, restated as data for the same reason as above. */
const ALL_PRIORITIES = ["high", "medium", "low"] as const;

describe("priority vocabulary", () => {
  it("labels, explains and tones every level the schema can produce", () => {
    for (const map of [PRIORITY_LABEL, PRIORITY_HINT, PRIORITY_TONE]) {
      for (const priority of ALL_PRIORITIES) {
        expect(map[priority], `missing entry for ${priority}`).toBeTruthy();
      }
      expect(Object.keys(map).sort()).toEqual([...ALL_PRIORITIES].sort());
    }
  });

  it("ranks the levels in descending urgency", () => {
    expect(PRIORITY_RANK.high).toBeLessThan(PRIORITY_RANK.medium);
    expect(PRIORITY_RANK.medium).toBeLessThan(PRIORITY_RANK.low);
  });

  it("sorts an unknown level after every known one", () => {
    // A level added to the schema but not here must not tie with `high` at 0
    // and silently jump the queue.
    expect(priorityRank("urgentísima")).toBeGreaterThan(PRIORITY_RANK.low);
  });

  it("falls back to the raw value for an unknown level, without alarming", () => {
    expect(priorityLabel("urgentísima")).toBe("urgentísima");
    const fallback = priorityTone("urgentísima");
    expect(fallback).toContain("border-");
    expect(fallback).not.toBe(PRIORITY_TONE.high);
  });

  it("says explicitly that 'media' means unmarked", () => {
    // Load-bearing: every species predating the column is medium, so reading
    // it as an assessment somebody made would be reading a default as a
    // decision.
    expect(PRIORITY_HINT.medium.toLowerCase()).toContain("defecto");
  });

  it("uses no colour the stage pill beside it uses", () => {
    // Two coloured pills in adjacent columns must not read as one scale.
    const stageHues = ["amber", "sky", "blue", "violet", "stone", "emerald", "rose"];
    for (const tone of Object.values(PRIORITY_TONE)) {
      for (const hue of stageHues) {
        expect(tone, `${tone} collides with a stage hue`).not.toContain(`${hue}-`);
      }
    }
  });

  it("marks only the top level for attention", () => {
    // Low is the faded one, not a second alarm: a deprioritised species should
    // recede from the list, which is the point of marking it.
    expect(PRIORITY_TONE.high).toContain("orange-");
    expect(PRIORITY_TONE.low).not.toContain("orange-");
    expect(PRIORITY_TONE.medium).not.toContain("orange-");
  });

  it("never says 'campaña' or 'campaign'", () => {
    for (const text of [
      ...Object.values(PRIORITY_LABEL),
      ...Object.values(PRIORITY_HINT),
      ...PRIORITY_FILTERS.map((o) => o.label),
    ]) {
      expect(text.toLowerCase()).not.toContain("campañ");
      expect(text.toLowerCase()).not.toContain("campaign");
    }
  });
});

describe("PRIORITY_FILTERS", () => {
  it("defaults to showing every level", () => {
    expect(PRIORITY_FILTERS[0].value).toBe("todas");
  });

  it("offers every individual level", () => {
    const values = PRIORITY_FILTERS.map((o) => o.value);
    for (const priority of ALL_PRIORITIES) {
      expect(values, `missing filter for ${priority}`).toContain(priority);
    }
  });

  it("lists the levels most urgent first", () => {
    const ranks = PRIORITY_FILTERS.filter((o) => o.value !== "todas").map((o) =>
      priorityRank(o.value)
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
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
