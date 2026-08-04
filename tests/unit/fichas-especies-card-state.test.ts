/**
 * Per-card save state for the fichas de especies editor (U3).
 *
 * This is the part most likely to be subtly wrong — the ""/null equivalence
 * (typing then deleting on an empty ficha is NOT a change) and the saved→dirty
 * transition (typing during the "Guardado" window must not read as saved). The
 * repo has no jsdom, so this pure module is where that behaviour is provable.
 */

import { describe, it, expect } from "vitest";
import {
  isDirty,
  deriveStatus,
  overBy,
} from "@/app/biochoco/fichas-especies/card-state";
import { SPECIES_CONTENT_MAX } from "@/app/biochoco/fichas-especies/content-types";

function state(overrides: Partial<Parameters<typeof deriveStatus>[0]> = {}) {
  return {
    draft: "",
    stored: null as string | null,
    pending: false,
    error: null as string | null,
    saved: false,
    ...overrides,
  };
}

describe("isDirty", () => {
  it("treats an empty draft over null stored content as unchanged", () => {
    expect(isDirty("", null)).toBe(false);
  });

  it("ignores leading/trailing whitespace, matching the server's trim", () => {
    expect(isDirty("  Dispersa semillas.  ", "Dispersa semillas.")).toBe(false);
    expect(isDirty("Dispersa semillas.\n", "Dispersa semillas.")).toBe(false);
  });

  it("is dirty when real text is added to a null ficha", () => {
    expect(isDirty("Dispersa semillas.", null)).toBe(true);
  });

  it("is dirty when an existing ficha is cleared", () => {
    expect(isDirty("", "Dispersa semillas.")).toBe(true);
    expect(isDirty("   ", "Dispersa semillas.")).toBe(true);
  });

  it("is dirty on a real edit", () => {
    expect(isDirty("Dispersa semillas y frutos.", "Dispersa semillas.")).toBe(
      true
    );
  });
});

describe("overBy", () => {
  it("is 0 for a draft well within the cap", () => {
    expect(overBy("Dispersa semillas.")).toBe(0);
  });

  it("is 0 at exactly the cap", () => {
    expect(overBy("x".repeat(SPECIES_CONTENT_MAX))).toBe(0);
  });

  it("reports how many characters over the cap the draft is", () => {
    expect(overBy("x".repeat(SPECIES_CONTENT_MAX + 37))).toBe(37);
  });

  it("measures the trimmed length, matching what the server enforces", () => {
    // Surrounding whitespace is stripped before the server's length check, so
    // it must not push a draft over here either.
    const atCap = "x".repeat(SPECIES_CONTENT_MAX);
    expect(overBy(`  ${atCap}\n\n  `)).toBe(0);
  });

  it("is 0 for an empty draft", () => {
    expect(overBy("")).toBe(0);
    expect(overBy("    ")).toBe(0);
  });
});

describe("deriveStatus", () => {
  it("is idle when nothing has happened", () => {
    expect(deriveStatus(state())).toBe("idle");
  });

  it("is dirty once the draft diverges from stored", () => {
    expect(deriveStatus(state({ draft: "Algo" }))).toBe("dirty");
  });

  it("is saving while pending, even when the draft matches stored", () => {
    expect(
      deriveStatus(state({ draft: "Algo", stored: "Algo", pending: true }))
    ).toBe("saving");
  });

  it("is error when the save was rejected", () => {
    expect(
      deriveStatus(state({ draft: "Algo", error: "El texto no puede superar…" }))
    ).toBe("error");
  });

  it("returns to dirty once the author edits after an error (caller clears the error)", () => {
    expect(deriveStatus(state({ draft: "Algo mas", error: null }))).toBe("dirty");
  });

  it("is saved inside the confirmation window", () => {
    expect(
      deriveStatus(state({ draft: "Algo", stored: "Algo", saved: true }))
    ).toBe("saved");
  });

  it("falls back to idle once the card's timer clears the window", () => {
    expect(
      deriveStatus(state({ draft: "Algo", stored: "Algo", saved: false }))
    ).toBe("idle");
  });

  it("is dirty, not saved, when the author types again during the saved window", () => {
    expect(
      deriveStatus(state({ draft: "Algo mas", stored: "Algo", saved: true }))
    ).toBe("dirty");
  });

  it("prefers saving over a stale error", () => {
    expect(
      deriveStatus(state({ draft: "Algo", pending: true, error: "boom" }))
    ).toBe("saving");
  });
});
