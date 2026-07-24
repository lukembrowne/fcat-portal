/**
 * SpeciesShowcase — the merged, imagery-forward species section that replaced
 * the old carousel + table.
 *
 * The test env is `node` with no jsdom/RTL, so we render with
 * `react-dom/server`'s `renderToStaticMarkup` (same approach as
 * landowner-public-shell.test.tsx) and assert on the static HTML.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeciesShowcase } from "../species-showcase";
import type { SiteSpecies } from "@/app/biochoco/resultados/types";

function sp(overrides: Partial<SiteSpecies> = {}): SiteSpecies {
  return {
    speciesName: "Panthera onca",
    spanishName: null,
    commonName: null,
    taxonomicType: "mammal",
    detectionCount: 1,
    avgConfidence: 0,
    photoImageId: 1,
    galleryImageIds: [1],
    publicContent: null,
    iucnStatus: "LC",
    ...overrides,
  } as SiteSpecies;
}

const resolveImageUrl = (id: number, size: "thumb" | "large") =>
  `/img/${id}/${size}`;
// Distinguishable per-name href so we can assert which rows are linked.
const speciesHref = (name: string) =>
  `/gallery/${name.toLowerCase().replace(/\s+/g, "-")}`;

function render(species: SiteSpecies[]) {
  return renderToStaticMarkup(
    <SpeciesShowcase
      species={species}
      resolveImageUrl={resolveImageUrl}
      speciesHref={speciesHref}
      onTapPhoto={() => {}}
    />,
  );
}

describe("SpeciesShowcase", () => {
  it("renders a card for every species, including ones with no photo", () => {
    const html = render([
      sp({ speciesName: "Aaa aaa", spanishName: "Con foto", photoImageId: 5 }),
      sp({ speciesName: "Bbb bbb", spanishName: "Sin foto", photoImageId: null }),
    ]);
    expect(html).toContain("Con foto");
    expect(html).toContain("Sin foto");
  });

  it("links only cards that have a photo to the full-page gallery", () => {
    const html = render([
      sp({ speciesName: "Con Foto", spanishName: "Con foto", photoImageId: 5 }),
      sp({ speciesName: "Sin Foto", spanishName: "Sin foto", photoImageId: null }),
    ]);
    // Photographed species → anchor to its gallery slug.
    expect(html).toContain('href="/gallery/con-foto"');
    // Species without a photo is present but NOT linked (no dead link).
    expect(html).not.toContain('href="/gallery/sin-foto"');
  });

  it("orders most-at-risk species first (delegates to sortSpeciesForTable)", () => {
    const html = render([
      sp({ speciesName: "Low risk", spanishName: "Poco riesgo", iucnStatus: "LC" }),
      sp({ speciesName: "High risk", spanishName: "Mucho riesgo", iucnStatus: "CR" }),
    ]);
    expect(html.indexOf("Mucho riesgo")).toBeLessThan(html.indexOf("Poco riesgo"));
  });

  it("shows the detection count (registros) inline with the name", () => {
    const html = render([sp({ spanishName: "Ocelote", detectionCount: 12 })]);
    expect(html).toContain("12 registros");
  });

  it("does not render an IUCN conservation-status chip", () => {
    const html = render([sp({ spanishName: "Evaluado", iucnStatus: "EN" })]);
    expect(html).not.toContain("En peligro"); // conservation status removed from cards
  });

  it("renders the species-stats caption", () => {
    const html = render([
      sp({ taxonomicType: "bird", detectionCount: 3 }),
      sp({ speciesName: "Otra especie", taxonomicType: "mammal", detectionCount: 2 }),
    ]);
    expect(html).toContain("2 especies");
    expect(html).toContain("5 detecciones");
  });

  it("renders the species contextual content inline (paragraph + bullet)", () => {
    const html = render([
      sp({
        spanishName: "Guatusa",
        publicContent: "Dispersa semillas.\n- Vacunar",
      }),
    ]);
    expect(html).toContain("Dispersa semillas.");
    expect(html).toContain("<li"); // bullet line becomes a list item
    expect(html).toContain("Vacunar");
  });

  it("renders nothing for an empty species list", () => {
    expect(render([])).toBe("");
  });
});
