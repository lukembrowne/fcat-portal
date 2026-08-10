import { describe, it, expect } from "vitest";

import { resolveReviewKey } from "../use-review-shortcuts";

const ctx = (
  over: Partial<{
    inEditableField: boolean;
    inMediaControl: boolean;
    index: number;
  }> = {}
) => ({
  inEditableField: false,
  inMediaControl: false,
  index: 5,
  ...over,
});

describe("resolveReviewKey", () => {
  it("maps 1 and s to correct", () => {
    expect(resolveReviewKey("1", ctx())).toEqual({ kind: "answer", outcome: "correct" });
    expect(resolveReviewKey("s", ctx())).toEqual({ kind: "answer", outcome: "correct" });
  });

  it("maps 2 and n to incorrect", () => {
    expect(resolveReviewKey("2", ctx())).toEqual({ kind: "answer", outcome: "incorrect" });
    expect(resolveReviewKey("n", ctx())).toEqual({ kind: "answer", outcome: "incorrect" });
  });

  it("maps 3 and u to uncertain", () => {
    expect(resolveReviewKey("3", ctx())).toEqual({ kind: "answer", outcome: "uncertain" });
    expect(resolveReviewKey("u", ctx())).toEqual({ kind: "answer", outcome: "uncertain" });
  });

  it("accepts uppercase letters so caps lock does not break the queue", () => {
    expect(resolveReviewKey("S", ctx())).toEqual({ kind: "answer", outcome: "correct" });
    expect(resolveReviewKey("N", ctx())).toEqual({ kind: "answer", outcome: "incorrect" });
    expect(resolveReviewKey("U", ctx())).toEqual({ kind: "answer", outcome: "uncertain" });
  });

  it("maps space to play/pause, not to replay", () => {
    // Space used to restart the clip. Pressing it twice replayed from zero
    // instead of pausing, which is not what any media player does.
    expect(resolveReviewKey(" ", ctx())).toEqual({ kind: "toggle" });
  });

  it("maps r to replay", () => {
    expect(resolveReviewKey("r", ctx())).toEqual({ kind: "replay" });
    expect(resolveReviewKey("R", ctx())).toEqual({ kind: "replay" });
  });

  it("yields the keyboard to the native player while its control has focus", () => {
    // Clicking the <audio> pause button leaves that shadow-DOM control focused,
    // so the browser acts on the next keypress too. Handling it here as well
    // fires both — the reported "space behaves differently after clicking".
    const onPlayer = ctx({ inMediaControl: true });
    for (const key of [" ", "ArrowLeft", "ArrowRight", "r"]) {
      expect(resolveReviewKey(key, onPlayer)).toBeNull();
    }
  });

  it("still answers from the number and letter keys while the player has focus", () => {
    // Those keys mean nothing to a media element, so suppressing them would
    // strand a reviewer who clicked the player and kept working.
    const onPlayer = ctx({ inMediaControl: true });
    expect(resolveReviewKey("1", onPlayer)).toEqual({ kind: "answer", outcome: "correct" });
    expect(resolveReviewKey("n", onPlayer)).toEqual({ kind: "answer", outcome: "incorrect" });
  });

  it("maps ArrowRight to skip", () => {
    expect(resolveReviewKey("ArrowRight", ctx())).toEqual({ kind: "skip" });
  });

  it("maps ArrowLeft to back when there is somewhere to go", () => {
    expect(resolveReviewKey("ArrowLeft", ctx({ index: 3 }))).toEqual({ kind: "back" });
  });

  it("returns null for ArrowLeft at the start of the queue", () => {
    // Guards against stepping to a negative index.
    expect(resolveReviewKey("ArrowLeft", ctx({ index: 0 }))).toBeNull();
  });

  it("suppresses every shortcut while focus is in an editable field", () => {
    const editing = ctx({ inEditableField: true });
    for (const key of ["1", "s", "2", "n", "3", "u", " ", "ArrowLeft", "ArrowRight"]) {
      expect(resolveReviewKey(key, editing)).toBeNull();
    }
  });

  it("ignores unrelated keys", () => {
    for (const key of ["4", "a", "Enter", "Escape", "Tab", "0", "q"]) {
      expect(resolveReviewKey(key, ctx())).toBeNull();
    }
  });

  it("keeps the bindings the on-screen hints advertise", () => {
    // The review footer renders "(←)" next to Anterior, "(→)" next to Omitir,
    // "(espacio)" next to Reproducir/pausar and "(R)" next to Repetir. Those
    // labels are only honest while this mapping holds — a labelling change must
    // not silently drift from the keymap.
    expect(resolveReviewKey("ArrowLeft", ctx({ index: 1 }))).toEqual({ kind: "back" });
    expect(resolveReviewKey("ArrowRight", ctx({ index: 1 }))).toEqual({ kind: "skip" });
    expect(resolveReviewKey(" ", ctx())).toEqual({ kind: "toggle" });
    expect(resolveReviewKey("r", ctx())).toEqual({ kind: "replay" });
  });
});
