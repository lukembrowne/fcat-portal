import { describe, it, expect } from "vitest";

import {
  batchKey,
  batchState,
  canFit,
  queuePosition,
  remainingForReviewer,
} from "../review-progress";

describe("batchState", () => {
  it("offers more when the batch is exhausted but the sample is not", () => {
    // The bug this replaces: 50 loaded against a 200-clip sample rendered
    // "Cola completada" with 150 left and no way forward.
    expect(batchState(50, 200)).toBe("more-available");
  });

  it("reports completion when the reviewer has answered the whole sample", () => {
    expect(batchState(200, 200)).toBe("complete");
  });

  it("reports completion when the count exceeds the sample", () => {
    // Reachable if the sample shrinks. Offering a next batch here would load
    // an empty queue and look broken.
    expect(batchState(205, 200)).toBe("complete");
  });

  it("offers more from a standing start", () => {
    expect(batchState(0, 200)).toBe("more-available");
  });

  it("reports completion for an empty sample rather than looping", () => {
    expect(batchState(0, 0)).toBe("complete");
  });
});

describe("remainingForReviewer", () => {
  it("counts what is left for this reviewer", () => {
    expect(remainingForReviewer(50, 200)).toBe(150);
  });

  it("never goes negative", () => {
    expect(remainingForReviewer(205, 200)).toBe(0);
    expect(remainingForReviewer(0, 0)).toBe(0);
  });
});

describe("queuePosition", () => {
  it("is 1-indexed for display", () => {
    expect(queuePosition(0, 50)).toBe(1);
    expect(queuePosition(11, 50)).toBe(12);
  });

  it("never exceeds the batch length", () => {
    // The index runs one past the end when the batch finishes.
    expect(queuePosition(50, 50)).toBe(50);
    expect(queuePosition(999, 50)).toBe(50);
  });

  it("never goes below 1 for a non-empty batch", () => {
    expect(queuePosition(-3, 50)).toBe(1);
  });

  it("returns 0 for an empty batch so nothing renders '1 de 0'", () => {
    expect(queuePosition(0, 0)).toBe(0);
  });
});


describe("batchKey", () => {
  /**
   * The key exists to remount the review client when the server hands it a new
   * batch. Two real bugs traced to that not happening, because `index` and the
   * session's `answers` survived a `router.refresh()` that replaced both the
   * clips and the server's review count:
   *
   *  - the reviewer's total double-counted every answer already saved (the
   *    "20 de 10" on the completion screen), and
   *  - "Cargar siguientes" left `index` past the end of the fresh batch, so the
   *    completion screen never went away and the queue was unreachable.
   */
  const batch = (...ids: number[]) => ids.map((sampleId) => ({ sampleId }));

  it("is stable for the same batch", () => {
    expect(batchKey(batch(11, 12, 13))).toBe(batchKey(batch(11, 12, 13)));
  });

  it("changes when the next batch arrives", () => {
    expect(batchKey(batch(61, 62, 63))).not.toBe(batchKey(batch(11, 12, 13)));
  });

  it("changes when the batch shrinks to its own tail", () => {
    // Same leading clip is not enough — a partially-reviewed reload returns
    // the same first id with fewer clips behind it.
    expect(batchKey(batch(11, 12, 13))).not.toBe(batchKey(batch(11, 12)));
  });

  it("returns a stable constant for an empty batch", () => {
    expect(batchKey([])).toBe(batchKey([]));
    expect(batchKey([])).toBeTruthy();
  });
});

describe("canFit", () => {
  it("offers the fit once enough usable answers exist", () => {
    expect(canFit(20, 0)).toBe(true);
  });

  it("withholds it one answer short", () => {
    expect(canFit(19, 0)).toBe(false);
  });

  it("does not count uncertain answers toward the minimum", () => {
    // `uncertain` rows are excluded from the logistic fit, so counting them
    // here would offer a fit that then refuses as "muestra insuficiente".
    expect(canFit(22, 3)).toBe(false);
    expect(canFit(23, 3)).toBe(true);
  });

  it("never goes negative on inconsistent counts", () => {
    expect(canFit(2, 5)).toBe(false);
  });
});
