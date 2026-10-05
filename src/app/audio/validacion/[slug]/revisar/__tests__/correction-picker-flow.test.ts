/**
 * The "No" → "¿Qué especie era?" flow (U3 of the reviewer-feedback plan).
 *
 * Vitest runs in `node` with no DOM, so the flow is covered through its pure
 * pieces: the answer/correction state, the picker's keymap, and the search.
 */

import { describe, it, expect, vi } from "vitest";

import { resolveReviewKey } from "../use-review-shortcuts";
import {
  buildCorrectionIndex,
  correctionLabel,
  listPlacement,
  moveActive,
  resolvePickerKey,
  searchCorrections,
} from "../correction-search";
import {
  EMPTY_FLOW,
  STALE_CORRECTION_ERROR,
  advanceIfStillOn,
  afterAnswer,
  answerSlot,
  answerVersion,
  applyAnswer,
  applyCorrection,
  closeReopened,
  commitCorrection,
  reopenAnswer,
  rollbackAnswer,
  settleCorrection,
  showsSpeciesPicker,
  type CorrectionCommit,
} from "../review-flow";
import { triggerYieldsKey } from "../download-menu-keys";
import type { CorrectionSpeciesList } from "@/app/audio/validacion/actions";

const LIST: CorrectionSpeciesList = {
  detected: [
    ["Ramphastos ambiguus", "Yellow-throated Toucan", "Tucán Mandíbula Castaña"],
    ["Buteo platypterus", "Broad-winged Hawk", "Gavilán Aludo"],
    ["Passer domesticus", "House Sparrow", "Gorrión Europeo"],
  ],
  others: [
    ["Ardea alba", "Great Egret", "Garceta Grande"],
    ["Egretta garzetta", "Little Egret", null],
    ["Zonotrichia albicollis", "White-throated Sparrow", "Chingolo Gorjiblanco"],
  ],
};

const index = buildCorrectionIndex(LIST, "Buteo platypterus");
const names = (q: string) => searchCorrections(index, q).map((e) => e.scientificName);

describe("review flow after an answer", () => {
  it('"No" does not auto-advance; "Sí" and "No sé" still do', () => {
    expect(afterAnswer("incorrect")).toBe("ask-species");
    expect(afterAnswer("correct")).toBe("advance");
    expect(afterAnswer("uncertain")).toBe("advance");
  });

  it('shows the picker on a clip answered "No", including when returning with ←', () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Zonotrichia albicollis");
    s = applyAnswer(s, 2, "correct");
    // Moving back to clip 1 reads the same client state.
    expect(showsSpeciesPicker(s, 1)).toBe(true);
    expect(s.corrections[1]).toBe("Zonotrichia albicollis");
    expect(showsSpeciesPicker(s, 2)).toBe(false);
    expect(showsSpeciesPicker(s, 3)).toBe(false);
  });

  it('changing a "No" to "Sí" hides the picker and drops the correction', () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Zonotrichia albicollis");
    s = applyAnswer(s, 1, "correct");
    expect(showsSpeciesPicker(s, 1)).toBe(false);
    expect(s.corrections[1]).toBeUndefined();
  });

  it('answering "No" again keeps the correction, as the server does', () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Zonotrichia albicollis");
    s = applyAnswer(s, 1, "incorrect");
    expect(s.corrections[1]).toBe("Zonotrichia albicollis");
  });

  it("a refused answer rolls back both the answer and any correction", () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Zonotrichia albicollis");
    s = rollbackAnswer(s, 1);
    expect(s.answers).toEqual({});
    expect(s.corrections).toEqual({});
  });
});

describe('the answer slot: buttons, or "Incorrecta" + species search', () => {
  it('a "No" swaps the three buttons for the species search; other answers keep them', () => {
    expect(answerSlot(EMPTY_FLOW, 1)).toBe("buttons");
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    expect(answerSlot(s, 1)).toBe("species");
    s = applyAnswer(s, 2, "correct");
    expect(answerSlot(s, 2)).toBe("buttons");
    s = applyAnswer(s, 3, "uncertain");
    expect(answerSlot(s, 3)).toBe("buttons");
  });

  it('"cambiar respuesta" restores the buttons without changing or re-sending the answer', () => {
    const save = vi.fn();
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Zonotrichia albicollis");
    const before = s;
    s = reopenAnswer(s, 1);

    expect(answerSlot(s, 1)).toBe("buttons");
    // The stored answer, the correction and the answer generation are all
    // untouched: nothing new exists to send, and nothing was.
    expect(s.answers).toBe(before.answers);
    expect(s.corrections).toBe(before.corrections);
    expect(s.versions).toBe(before.versions);
    expect(answerVersion(s, 1)).toBe(answerVersion(before, 1));
    expect(save).not.toHaveBeenCalled();
    // Idempotent.
    expect(reopenAnswer(s, 1)).toBe(s);
  });

  it("a correction in flight still lands after the buttons were reopened", () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    const sentAt = answerVersion(s, 1);
    s = reopenAnswer(s, 1);
    const settled = settleCorrection(
      s,
      1,
      sentAt,
      { ok: true, species: "Ardea alba" },
      "Ardea alba"
    );
    expect(settled.advance).toBe(true);
    expect(settled.state.corrections[1]).toBe("Ardea alba");
  });

  it('pressing "No" again from the reopened buttons brings the search back', () => {
    let s = reopenAnswer(applyAnswer(EMPTY_FLOW, 1, "incorrect"), 1);
    s = applyAnswer(s, 1, "incorrect");
    expect(answerSlot(s, 1)).toBe("species");
  });

  it('"Sí" from the reopened buttons re-answers as before and drops the correction', () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Ardea alba");
    s = applyAnswer(reopenAnswer(s, 1), 1, "correct");
    expect(answerSlot(s, 1)).toBe("buttons");
    expect(s.reopened).toBeNull();
    expect(s.corrections[1]).toBeUndefined();
  });

  it("navigating away closes the reopened row, so ← shows the compact line again", () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyCorrection(s, 1, "Ardea alba");
    s = closeReopened(reopenAnswer(s, 1));
    expect(answerSlot(s, 1)).toBe("species");
    expect(s.corrections[1]).toBe("Ardea alba");
    expect(closeReopened(s)).toBe(s);
  });

  it("reopening one clip never affects another", () => {
    let s = applyAnswer(EMPTY_FLOW, 1, "incorrect");
    s = applyAnswer(s, 2, "incorrect");
    s = reopenAnswer(s, 1);
    expect(answerSlot(s, 1)).toBe("buttons");
    expect(answerSlot(s, 2)).toBe("species");
    // A rollback on another clip leaves the reopened one alone.
    expect(rollbackAnswer(s, 2).reopened).toBe(1);
    expect(rollbackAnswer(s, 1).reopened).toBeNull();
  });
});

describe("suggestion list placement", () => {
  it("opens downward when six rows fit below the input", () => {
    expect(listPlacement({ top: 500, bottom: 536 }, 800)).toEqual({
      side: "below",
      maxHeight: 256,
    });
    expect(listPlacement({ top: 100, bottom: 136 }, 900).maxHeight).toBe(288);
  });

  it("flips upward near the bottom of the viewport, capped to the room above", () => {
    expect(listPlacement({ top: 700, bottom: 736 }, 800)).toEqual({
      side: "above",
      maxHeight: 288,
    });
    expect(listPlacement({ top: 150, bottom: 186 }, 300)).toEqual({
      side: "above",
      maxHeight: 142,
    });
  });

  it("stays below when below is cramped but still the roomier side", () => {
    expect(listPlacement({ top: 60, bottom: 96 }, 250)).toEqual({
      side: "below",
      maxHeight: 146,
    });
  });
});

describe("download menu trigger", () => {
  it("yields Space to the page (play/pause) instead of opening", () => {
    expect(triggerYieldsKey(" ")).toBe(true);
    // Enter / ↓ still open it, so the menu stays keyboard-reachable; the
    // answer keys do nothing to a button and need no guard.
    for (const key of ["Enter", "ArrowDown", "1", "2", "3"]) {
      expect(triggerYieldsKey(key)).toBe(false);
    }
  });
});

describe("a late correction result never skips a clip", () => {
  const SPARROW = "Zonotrichia albicollis";
  const ITEMS = [{ sampleId: 10 }, { sampleId: 11 }, { sampleId: 12 }];
  const ok: CorrectionCommit = { ok: true, species: SPARROW };

  it("bumps the clip's answer generation on every answer and rollback", () => {
    let s = applyAnswer(EMPTY_FLOW, 10, "incorrect");
    expect(answerVersion(s, 10)).toBe(1);
    s = applyAnswer(s, 10, "incorrect");
    expect(answerVersion(s, 10)).toBe(2);
    s = rollbackAnswer(s, 10);
    expect(answerVersion(s, 10)).toBe(3);
    // Other clips are untouched, and a correction does not count as an answer.
    s = applyCorrection(s, 11, SPARROW);
    expect(answerVersion(s, 11)).toBe(0);
  });

  it("applies and advances when the clip is still the same 'No'", () => {
    const s = applyAnswer(EMPTY_FLOW, 10, "incorrect");
    const settled = settleCorrection(s, 10, answerVersion(s, 10), ok, SPARROW);
    expect(settled.advance).toBe(true);
    expect(settled.state.corrections[10]).toBe(SPARROW);
    expect(settled.commit).toEqual(ok);
  });

  it("drops the result when the reviewer re-answered 'Sí' while it was saving", () => {
    // "No" → type a species → Enter (save sent at this generation) → "Sí"
    // before the save returns.
    let s = applyAnswer(EMPTY_FLOW, 10, "incorrect");
    const sentAt = answerVersion(s, 10);
    s = applyAnswer(s, 10, "correct");

    const settled = settleCorrection(s, 10, sentAt, ok, SPARROW);
    expect(settled.advance).toBe(false);
    expect(settled.state).toBe(s);
    expect(settled.state.corrections[10]).toBeUndefined();
    expect(settled.commit).toEqual({ ok: false, error: STALE_CORRECTION_ERROR });
  });

  it("drops the result when a newer answer came in, even if it is 'No' again", () => {
    let s = applyAnswer(EMPTY_FLOW, 10, "incorrect");
    const sentAt = answerVersion(s, 10);
    s = applyAnswer(s, 10, "uncertain");
    s = applyAnswer(s, 10, "incorrect");
    const settled = settleCorrection(s, 10, sentAt, ok, SPARROW);
    expect(settled.advance).toBe(false);
    expect(settled.state.corrections[10]).toBeUndefined();
  });

  it("a cleared correction (skip) or a failed save never advances", () => {
    const s = applyAnswer(EMPTY_FLOW, 10, "incorrect");
    const v = answerVersion(s, 10);
    expect(settleCorrection(s, 10, v, { ok: true, species: null }, null).advance).toBe(false);
    const failed: CorrectionCommit = { ok: false, error: "no" };
    const settled = settleCorrection(s, 10, v, failed, SPARROW);
    expect(settled).toEqual({ state: s, advance: false, commit: failed });
  });

  it("the delayed auto-advance only moves the queue if it is still on that clip", () => {
    const advance = advanceIfStillOn(ITEMS, 10);
    expect(advance(0)).toBe(1);
    // The reviewer (or another advance) already moved on: no second step.
    expect(advance(1)).toBe(1);
    expect(advance(2)).toBe(2);
    // Past the end of the batch.
    expect(advance(3)).toBe(3);
  });

  it("the race end to end: 'Sí' then a late correction lands exactly one clip on", () => {
    let index = 0;
    // "No" on clip 10, correction sent, then "Sí" on the same clip.
    let s = applyAnswer(EMPTY_FLOW, 10, "incorrect");
    const sentAt = answerVersion(s, 10);
    s = applyAnswer(s, 10, "correct");
    const autoAdvance = advanceIfStillOn(ITEMS, 10); // the 320 ms timer

    // The correction returns first…
    const settled = settleCorrection(s, 10, sentAt, ok, SPARROW);
    if (settled.advance) index = advanceIfStillOn(ITEMS, 10)(index);
    // …then the timer fires.
    index = autoAdvance(index);
    expect(index).toBe(1);

    // Even if a stale result DID advance, the guarded timer would not stack.
    let index2 = advanceIfStillOn(ITEMS, 10)(0);
    index2 = autoAdvance(index2);
    expect(index2).toBe(1);
  });
});

describe("commitCorrection", () => {
  it("calls the correction action once, after the answer has landed", async () => {
    const order: string[] = [];
    let landAnswer!: (ok: boolean) => void;
    const pendingAnswer = new Promise<boolean>((r) => (landAnswer = r)).then((ok) => {
      order.push("answer");
      return ok;
    });
    const save = vi.fn(async (_id: number, species: string | null) => {
      order.push("correction");
      return { success: true as const, data: { correctedSpecies: species } };
    });

    const pending = commitCorrection(7, "Zonotrichia albicollis", { pendingAnswer, save });
    landAnswer(true);
    const result = await pending;

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(7, "Zonotrichia albicollis");
    expect(order).toEqual(["answer", "correction"]);
    expect(result).toEqual({ ok: true, species: "Zonotrichia albicollis" });
  });

  it("a failed write reports the server's Spanish error and does not advance", async () => {
    const save = vi.fn(async () => ({
      success: false as const,
      error: '"Zonotrichia albicolis" no está en la lista de especies de BirdNET',
    }));
    const result = await commitCorrection(7, "Zonotrichia albicolis", { save });
    expect(result).toEqual({
      ok: false,
      error: '"Zonotrichia albicolis" no está en la lista de especies de BirdNET',
    });
  });

  it("a network failure becomes a Spanish error", async () => {
    const save = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const result = await commitCorrection(7, "Ardea alba", { save });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No se pudo guardar/);
  });

  it("does not send a correction when the answer it hangs on failed", async () => {
    const save = vi.fn();
    const result = await commitCorrection(7, "Ardea alba", {
      pendingAnswer: Promise.resolve(false),
      save,
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe("picker keyboard", () => {
  const ctx = (query: string, activeIndex = -1, resultCount = 3) => ({
    query,
    activeIndex,
    resultCount,
  });

  it('typing "s", "n", "u" or "r" in the input answers nothing', () => {
    // The page shortcuts are suppressed on an editable target…
    for (const key of ["s", "n", "u", "r", "1", "2", "3", " "]) {
      expect(resolveReviewKey(key, { inEditableField: true, inMediaControl: false, index: 3 })).toBeNull();
      // …and the picker treats them as ordinary text.
      expect(resolvePickerKey(key, ctx("gar"))).toBeNull();
    }
  });

  it("Enter on an empty box skips, without choosing the top suggestion", () => {
    expect(resolvePickerKey("Enter", ctx("", -1))).toEqual({ kind: "skip" });
    expect(resolvePickerKey("Enter", ctx("   ", -1))).toEqual({ kind: "skip" });
  });

  it("→ on an empty box skips; with text it moves the caret", () => {
    expect(resolvePickerKey("ArrowRight", ctx(""))).toEqual({ kind: "skip" });
    expect(resolvePickerKey("ArrowRight", ctx("gar"))).toBeNull();
  });

  it("← on an empty box goes back; with text it moves the caret", () => {
    expect(resolvePickerKey("ArrowLeft", ctx(""))).toEqual({ kind: "back" });
    expect(resolvePickerKey("ArrowLeft", ctx("gar"))).toBeNull();
  });

  it("Enter chooses the highlighted row, or the top match once text is typed", () => {
    expect(resolvePickerKey("Enter", ctx("gar", 2))).toEqual({ kind: "choose", index: 2 });
    expect(resolvePickerKey("Enter", ctx("gar", -1))).toEqual({ kind: "choose", index: 0 });
    // Arrowed into the suggestions from an empty box: that is a choice.
    expect(resolvePickerKey("Enter", ctx("", 1))).toEqual({ kind: "choose", index: 1 });
  });

  it("Enter with text but no match does nothing (no free text reaches the record)", () => {
    expect(resolvePickerKey("Enter", ctx("xyzzy", -1, 0))).toBeNull();
  });

  it("Esc clears the text first, then releases the keyboard", () => {
    expect(resolvePickerKey("Escape", ctx("gar"))).toEqual({ kind: "clear" });
    expect(resolvePickerKey("Escape", ctx(""))).toEqual({ kind: "release" });
  });

  it("↑/↓ move within the list and back up into the box", () => {
    expect(resolvePickerKey("ArrowDown", ctx("gar"))).toEqual({ kind: "move", delta: 1 });
    expect(resolvePickerKey("ArrowDown", ctx("gar", -1, 0))).toBeNull();
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(2, 1, 3)).toBe(2);
    expect(moveActive(0, -1, 3)).toBe(-1);
    expect(moveActive(0, 1, 0)).toBe(-1);
  });
});

describe("correction search", () => {
  it("never offers the species being validated", () => {
    expect(index.map((e) => e.scientificName)).not.toContain("Buteo platypterus");
    expect(names("buteo")).toEqual([]);
  });

  it("matches scientific, English and Spanish names, ignoring case and accents", () => {
    expect(names("zonotrichia")).toEqual(["Zonotrichia albicollis"]);
    expect(names("white-throated")).toEqual(["Zonotrichia albicollis"]);
    expect(names("CHINGOLO")).toEqual(["Zonotrichia albicollis"]);
    expect(names("tucan mandibula")).toEqual(["Ramphastos ambiguus"]);
  });

  it("matches every word of a multi-word query across names", () => {
    expect(names("sparrow gorjiblanco")).toEqual(["Zonotrichia albicollis"]);
  });

  it("ranks prefix matches first, then detected species", () => {
    // "sparrow": both are word-prefix matches; the detected one ranks first.
    expect(names("sparrow")).toEqual(["Passer domesticus", "Zonotrichia albicollis"]);
    // "gar": "Garceta Grande" is a whole-name prefix, "Egretta garzetta" a word prefix.
    expect(names("gar")).toEqual(["Ardea alba", "Egretta garzetta"]);
  });

  it("ranks a whole-word match ahead of a word prefix", () => {
    const hawks = buildCorrectionIndex(
      {
        detected: [],
        others: [
          ["Accipiter gularis", "Japanese Sparrowhawk", "Gavilán Japonés"],
          ["Zonotrichia albicollis", "White-throated Sparrow", "Chingolo Gorjiblanco"],
        ],
      },
      "x"
    );
    expect(searchCorrections(hawks, "sparrow").map((e) => e.scientificName)).toEqual([
      "Zonotrichia albicollis",
      "Accipiter gularis",
    ]);
  });

  it("an empty query lists only the detected species", () => {
    expect(names("")).toEqual(["Ramphastos ambiguus", "Passer domesticus"]);
  });

  it("caps the rendered results", () => {
    const big: CorrectionSpeciesList = {
      detected: [],
      others: Array.from({ length: 100 }, (_, i) => [
        `Genus species${i}`,
        `Bird ${i}`,
        null,
      ]),
    };
    expect(searchCorrections(buildCorrectionIndex(big, "x"), "bird")).toHaveLength(30);
  });

  it("labels follow the name-language preference, falling back to English", () => {
    const [toucan] = searchCorrections(index, "ramphastos");
    expect(correctionLabel(toucan, "es")).toBe("Tucán Mandíbula Castaña");
    expect(correctionLabel(toucan, "en")).toBe("Yellow-throated Toucan");
    const [egret] = searchCorrections(index, "little egret");
    expect(correctionLabel(egret, "es")).toBe("Little Egret");
  });
});
