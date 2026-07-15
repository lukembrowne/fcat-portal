import { describe, it, expect } from "vitest";
import { shouldUpdateDateEnd } from "@/lib/camera-trap-sync-internals";

/**
 * The ODK retrieval-date → deployment.date_end decision. Regression guard for
 * the fill-null-only bug (REF-001): once date_end was set (even wrongly), a
 * corrected retrieve_sensors submission could never overwrite it, so the results
 * page computed the wrong camera-day window forever.
 */
describe("shouldUpdateDateEnd", () => {
  const odk = (dateEnd: string | null) => ({ dateEnd, metadataSource: "odk" });

  it("does nothing when there is no ODK retrieval date", () => {
    expect(shouldUpdateDateEnd(odk("2026-03-11"), undefined)).toBe(false);
  });

  it("does nothing when the retrieval already matches date_end", () => {
    expect(shouldUpdateDateEnd(odk("2026-03-23"), "2026-03-23")).toBe(false);
  });

  it("fills a null date_end from ODK (any source)", () => {
    expect(shouldUpdateDateEnd(odk(null), "2026-03-23")).toBe(true);
    expect(shouldUpdateDateEnd({ dateEnd: null, metadataSource: "manual" }, "2026-03-23")).toBe(true);
    expect(shouldUpdateDateEnd({ dateEnd: null, metadataSource: null }, "2026-03-23")).toBe(true);
  });

  it("overwrites a stale odk-sourced date_end with the corrected retrieval (the REF-001 fix)", () => {
    // date_end was frozen at the install date; ODK now reports the real retrieval.
    expect(shouldUpdateDateEnd(odk("2026-03-11"), "2026-03-23")).toBe(true);
    // null metadataSource (legacy/auto) is also treated as non-manual.
    expect(shouldUpdateDateEnd({ dateEnd: "2026-03-11", metadataSource: null }, "2026-03-23")).toBe(true);
  });

  it("never clobbers a manual edit", () => {
    expect(shouldUpdateDateEnd({ dateEnd: "2026-03-11", metadataSource: "manual" }, "2026-03-23")).toBe(false);
  });
});
