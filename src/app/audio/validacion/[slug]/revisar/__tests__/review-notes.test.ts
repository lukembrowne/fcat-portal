/**
 * Clip notes on the review page: what counts as a change, and the ordering a
 * note typed before answering depends on.
 */

import { describe, expect, it, vi } from "vitest";

import { commitNote } from "../review-flow";
import { noteIsDirty, normalizeReviewNote } from "@/lib/birdnet-validation/review-notes";

describe("normalizeReviewNote", () => {
  it("trims, and collapses blank to null", () => {
    expect(normalizeReviewNote("  canto  ")).toBe("canto");
    expect(normalizeReviewNote(" \n ")).toBeNull();
    expect(normalizeReviewNote(null)).toBeNull();
    expect(normalizeReviewNote(undefined)).toBeNull();
  });
});

describe("noteIsDirty", () => {
  it("compares the normalised draft with what the server holds", () => {
    expect(noteIsDirty("canto ", "canto")).toBe(false);
    expect(noteIsDirty("canto", null)).toBe(true);
    expect(noteIsDirty("   ", null)).toBe(false);
    expect(noteIsDirty("", "canto")).toBe(true);
    expect(noteIsDirty(undefined, undefined)).toBe(false);
  });
});

describe("commitNote", () => {
  it("sends the note only after the answer has landed", async () => {
    const order: string[] = [];
    let landAnswer!: (ok: boolean) => void;
    const pendingAnswer = new Promise<boolean>((r) => (landAnswer = r)).then((ok) => {
      order.push("answer");
      return ok;
    });
    const save = vi.fn(async (_id: number, note: string | null) => {
      order.push("note");
      return { success: true as const, data: { note } };
    });

    const pending = commitNote(7, "alarma", { pendingAnswer, save });
    landAnswer(true);

    expect(await pending).toEqual({ ok: true, note: "alarma" });
    expect(order).toEqual(["answer", "note"]);
  });

  it("does not send when the answer failed", async () => {
    const save = vi.fn();
    const result = await commitNote(7, "alarma", {
      pendingAnswer: Promise.resolve(false),
      save,
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("reports the server's Spanish error", async () => {
    const save = vi.fn(async () => ({
      success: false as const,
      error: "La nota supera los 2000 caracteres",
    }));
    expect(await commitNote(7, "x", { save })).toEqual({
      ok: false,
      error: "La nota supera los 2000 caracteres",
    });
  });

  it("turns a thrown request into a Spanish error", async () => {
    const save = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await commitNote(7, "x", { save })).toEqual({
      ok: false,
      error: "No se pudo guardar la nota",
    });
  });
});
