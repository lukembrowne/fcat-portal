import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteResultsContent } from "../site-results-content";
import type { HabitatAssessment } from "../../../habitat/types";

/**
 * These tests exercise the composition in `site-results-content.tsx` by
 * rendering it to a static HTML string (no jsdom — the repo's Vitest env is
 * "node"). We keep the child tree minimal (`showFauna={false}`, `audio={null}`,
 * empty temperature) so the assertions target the variant gating, not the
 * heavy recharts/species subtrees.
 */

const habitat: HabitatAssessment = {
  instanceId: "inst-1",
  siteId: "SITE-1",
  siteName: "Sitio 1",
  habitatType: "primary_forest",
  assessmentDate: "2026-01-01",
  canopyCoverPercent: 85,
  canopyHeightClass: "tall",
  treesMedium: 4,
  treesLarge: 2,
  understoryDensity: "medium",
  slopeCategory: "moderate",
  distanceToEdgeM: 120,
  adjacentHabitat: "forest",
  disturbanceSigns: "none",
  habitatNotes: "",
  photoNorth: "",
  photoEast: "",
  photoSouth: "",
  photoWest: "",
  photoCanopy: "",
};

const baseData = {
  species: [],
  temperature: [],
  temperatureStats: null,
  habitat,
  habitatAssessmentCount: 1,
  // Fields not read by SiteResultsContent when showFauna=false / audio=null.
} as unknown as Parameters<typeof SiteResultsContent>[0]["data"];

function renderVariant(variant: "public" | "internal"): string {
  return renderToStaticMarkup(
    <SiteResultsContent
      data={baseData}
      audio={null}
      resolveImageUrl={(id, size) => `/img/${id}/${size}`}
      speciesHref={null}
      variant={variant}
      showFauna={false}
    />,
  );
}

describe("SiteResultsContent — public variant", () => {
  it("renders NO temperature heading on the public variant", () => {
    const html = renderVariant("public");
    expect(html).not.toContain("Temperatura");
  });

  it("still renders the temperature section on the internal variant", () => {
    const html = renderVariant("internal");
    expect(html).toContain("Temperatura");
  });

  it("renders the habitat explainer above the stat grid on the public variant", () => {
    const html = renderVariant("public");
    // Explainer copy is present.
    expect(html).toContain("Estas cifras describen el bosque de su tierra");
    expect(html).toContain("Cobertura y altura del dosel");

    // And it appears BEFORE the first stat-grid label ("Cobertura del dosel").
    const explainerIdx = html.indexOf("Estas cifras describen el bosque");
    const statGridIdx = html.indexOf("Cobertura del dosel");
    expect(explainerIdx).toBeGreaterThanOrEqual(0);
    expect(statGridIdx).toBeGreaterThan(explainerIdx);
  });

  it("hides slope / distance-to-edge / disturbance on the public variant", () => {
    const html = renderVariant("public");
    expect(html).not.toContain("Distancia al borde");
    expect(html).not.toContain("Dist. al borde");
    expect(html).not.toContain("Pendiente");
  });

  it("still shows slope / distance-to-edge on the internal variant", () => {
    const html = renderVariant("internal");
    expect(html).toContain("Dist. al borde");
    expect(html).toContain("Pendiente");
  });
});
