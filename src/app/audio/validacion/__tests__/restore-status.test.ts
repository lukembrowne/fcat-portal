import { describe, it, expect } from "vitest";

import { deriveRestoredStatus, type RestoreFacts } from "../restore-status";

const facts = (over: Partial<RestoreFacts> = {}): RestoreFacts => ({
  hasActiveThreshold: false,
  fitCount: 0,
  latestFitUnusable: false,
  reviewCount: 0,
  sampledAt: null,
  sampleCount: 0,
  ...over,
});

describe("deriveRestoredStatus", () => {
  it("returns draft when nothing was ever drawn", () => {
    expect(deriveRestoredStatus(facts())).toBe("draft");
  });

  it("returns sampled when clips exist but the draw timestamp does not", () => {
    // Belt and braces: clips on the row mean the draw happened, so the species
    // must not be restored into the state that means "the draw failed".
    expect(deriveRestoredStatus(facts({ sampleCount: 200 }))).toBe("sampled");
  });

  it("returns sampled once the stratified draw ran with nothing reviewed", () => {
    expect(
      deriveRestoredStatus(facts({ sampleCount: 200, sampledAt: new Date() }))
    ).toBe("sampled");
  });

  it("returns reviewing as soon as any answer exists", () => {
    expect(
      deriveRestoredStatus(
        facts({ sampleCount: 210, sampledAt: new Date(), reviewCount: 1 })
      )
    ).toBe("reviewing");
  });

  it("returns fitted when a usable fit exists", () => {
    expect(
      deriveRestoredStatus(facts({ reviewCount: 40, fitCount: 1 }))
    ).toBe("fitted");
  });

  it("returns unusable when the most recent fit produced no threshold", () => {
    expect(
      deriveRestoredStatus(
        facts({ reviewCount: 40, fitCount: 2, latestFitUnusable: true })
      )
    ).toBe("unusable");
  });

  it("returns applied when a threshold is live", () => {
    expect(
      deriveRestoredStatus(
        facts({ reviewCount: 40, fitCount: 1, hasActiveThreshold: true })
      )
    ).toBe("applied");
  });

  it("prefers the most advanced stage when several facts are true at once", () => {
    // A campaign holds samples AND reviews AND fits AND a live threshold
    // simultaneously. Restoring to "reviewing" because reviews exist would
    // hide a threshold that is actively filtering the portal.
    const everything = facts({
      hasActiveThreshold: true,
      fitCount: 3,
      latestFitUnusable: true,
      reviewCount: 200,
      sampledAt: new Date(),
      sampleCount: 210,
    });
    expect(deriveRestoredStatus(everything)).toBe("applied");

    // Same stack without the live threshold falls to the fit, not to reviewing.
    expect(
      deriveRestoredStatus({ ...everything, hasActiveThreshold: false })
    ).toBe("unusable");
  });

  it("never returns abandoned", () => {
    // Restoring into the state being undone would make the action a no-op that
    // reports success.
    const combos: RestoreFacts[] = [
      facts(),
      facts({ sampleCount: 10 }),
      facts({ sampleCount: 210, sampledAt: new Date() }),
      facts({ reviewCount: 5 }),
      facts({ fitCount: 1 }),
      facts({ hasActiveThreshold: true, fitCount: 1 }),
    ];
    for (const c of combos) {
      expect(deriveRestoredStatus(c)).not.toBe("abandoned");
    }
  });
});
