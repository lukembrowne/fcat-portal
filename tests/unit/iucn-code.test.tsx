/**
 * U6 — IucnCode staff-facing category tag.
 *
 * Renders the raw Red List code for meaningful categories (LC/NT/VU/EN/CR/EW/EX)
 * and nothing for null / DD / unknown. Must stay distinct from ConservationBadge,
 * which never exposes the raw code (landowner-facing honesty contract, R9).
 *
 * Repo has no jsdom (env "node"); we render with renderToStaticMarkup like the
 * other component tests.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IucnCode, getIucnCategory } from "@/components/iucn-code";
import { ConservationBadge } from "@/components/conservation-badge";

describe("getIucnCategory", () => {
  it("returns the category for meaningful codes", () => {
    expect(getIucnCategory("VU")?.code).toBe("VU");
    expect(getIucnCategory("EN")?.name).toBe("Endangered");
    expect(getIucnCategory("LC")?.code).toBe("LC");
  });

  it("is case-insensitive and trims", () => {
    expect(getIucnCategory(" vu ")?.code).toBe("VU");
  });

  it("returns null for null, DD, and unknown codes", () => {
    expect(getIucnCategory(null)).toBeNull();
    expect(getIucnCategory("")).toBeNull();
    expect(getIucnCategory("DD")).toBeNull();
    expect(getIucnCategory("ZZ")).toBeNull();
  });
});

describe("IucnCode", () => {
  it("renders the code for VU/EN/LC", () => {
    expect(renderToStaticMarkup(<IucnCode status="VU" />)).toContain("VU");
    expect(renderToStaticMarkup(<IucnCode status="EN" />)).toContain("EN");
    expect(renderToStaticMarkup(<IucnCode status="LC" />)).toContain("LC");
  });

  it("renders nothing for null / DD / unknown", () => {
    expect(renderToStaticMarkup(<IucnCode status={null} />)).toBe("");
    expect(renderToStaticMarkup(<IucnCode status="DD" />)).toBe("");
    expect(renderToStaticMarkup(<IucnCode status="ZZ" />)).toBe("");
  });
});

describe("ConservationBadge non-regression (R9)", () => {
  it("never exposes the raw code (uses warm Spanish label)", () => {
    const html = renderToStaticMarkup(<ConservationBadge status="VU" />);
    expect(html).toContain("Vulnerable");
    expect(html).not.toContain("VU");
  });

  it("renders nothing for Least Concern (threatened-only)", () => {
    expect(renderToStaticMarkup(<ConservationBadge status="LC" />)).toBe("");
  });
});
