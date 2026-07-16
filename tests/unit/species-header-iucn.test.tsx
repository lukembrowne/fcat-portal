/**
 * U8 — SpeciesHeader shows the IUCN code (staff detail pages) when assessed,
 * and nothing when unassessed. Renders with renderToStaticMarkup (no jsdom).
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeciesHeader } from "@/components/species/species-header";
import type { Species } from "@/db/schema";

function makeSpecies(overrides: Partial<Species>): Species {
  return {
    id: 1,
    scientificName: "Adelomyia melanogenys",
    commonName: "Speckled Hummingbird",
    spanishName: null,
    taxonomicRank: "species",
    type: "bird",
    iucnStatus: null,
    cameraSelectable: false,
    ...overrides,
  } as Species;
}

describe("SpeciesHeader IUCN code", () => {
  it("renders the code when iucnStatus is present", () => {
    const html = renderToStaticMarkup(
      <SpeciesHeader
        species={makeSpecies({ iucnStatus: "VU" })}
        totalCount={10}
        siteCount={2}
        backHref="/audio/species"
      />,
    );
    expect(html).toContain("VU");
  });

  it("renders no code when iucnStatus is null", () => {
    const html = renderToStaticMarkup(
      <SpeciesHeader
        species={makeSpecies({ iucnStatus: null })}
        totalCount={10}
        siteCount={2}
        backHref="/audio/species"
      />,
    );
    // The common name still renders; the raw code does not appear anywhere.
    expect(html).toContain("Speckled Hummingbird");
    expect(html).not.toMatch(/\b(LC|NT|VU|EN|CR)\b/);
  });
});
