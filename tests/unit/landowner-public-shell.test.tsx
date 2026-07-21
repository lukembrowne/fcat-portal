/**
 * Unit tests for the redesigned landowner public page (U6).
 *
 * The repo has no `@testing-library/react`/jsdom, and the test env is "node",
 * so we render with `react-dom/server`'s `renderToStaticMarkup`. That skips
 * effects — which is exactly the no-JS / reduced-motion / no-IntersectionObserver
 * baseline: `StoryStat` initialises to the FINAL number, so the static markup is
 * the same number a reduced-motion user sees.
 *
 * The heavy children (species grid, contact form, share button) pull server
 * actions / chart deps, so they're mocked to keep the shell render light.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/biochoco/resultados/[siteId]/site-results-content", () => ({
  SiteResultsContent: () => <div data-testid="site-results">GRID_ESPECIES</div>,
}));
vi.mock("@/app/public/biochoco/[token]/contact-form", () => ({
  ContactForm: () => <div data-testid="contact-form">FORM_CONTACTO</div>,
}));
vi.mock("@/components/photo-share-button", () => ({
  PhotoShareButton: () => <button>compartir</button>,
}));
// The lightbox pulls a "use server" action (DB deps). It only mounts on a card
// tap, so the static shell render never needs it — stub it out to stay light.
vi.mock("@/app/public/biochoco/[token]/species-lightbox", () => ({
  SpeciesLightbox: () => null,
}));

import { PublicSiteShell } from "@/app/public/biochoco/[token]/public-site-shell";
import { buildSpeciesStatsText } from "@/app/public/biochoco/[token]/species-carousel";
import {
  StoryStat,
  buildStoryStatText,
} from "@/app/public/biochoco/[token]/story-stat";
import type { PublicSiteDetail } from "@/app/biochoco/resultados/actions";
import type { SiteSpecies } from "@/app/biochoco/resultados/types";

function makeData(overrides: Partial<PublicSiteDetail> = {}): PublicSiteDetail {
  return {
    siteId: "CCN-014",
    heroImageId: 42,
    deploymentIds: [1],
    contentBlocks: [],
    species: [
      {
        photoImageId: 99,
        speciesName: "Leopardus pardalis",
        spanishName: "Ocelote",
        commonName: "Ocelot",
        iucnStatus: "LC",
      },
    ],
    totalCameraTrapDays: 84,
    dateRange: { start: null, end: null },
    site: { siteName: "Finca La Esperanza", habitatType: "bosque" },
    ...overrides,
  } as unknown as PublicSiteDetail;
}

describe("buildStoryStatText", () => {
  it("uses plural species form for 0 species", () => {
    const t = buildStoryStatText({ speciesCount: 0, days: 0 });
    expect(t.unit).toBe("especies de animales");
  });

  it("uses singular species form for exactly 1 species", () => {
    const t = buildStoryStatText({ speciesCount: 1, days: 84 });
    expect(t.unit).toBe("especie de animal");
  });

  it("uses plural species form for many species", () => {
    const t = buildStoryStatText({ speciesCount: 37, days: 84 });
    expect(t.unit).toBe("especies de animales");
  });

  it("omits the days clause when days === 0", () => {
    const t = buildStoryStatText({ speciesCount: 37, days: 0 });
    expect(t.sub).not.toMatch(/día/);
    expect(t.sub).toContain("Nuestras cámaras y grabadores registraron esta vida");
  });

  it("uses singular día for exactly 1 day", () => {
    const t = buildStoryStatText({ speciesCount: 37, days: 1 });
    expect(t.sub).toContain("1 día de monitoreo");
  });

  it("uses plural días for many days", () => {
    const t = buildStoryStatText({ speciesCount: 37, days: 84 });
    expect(t.sub).toContain("84 días de monitoreo");
  });
});

describe("StoryStat (static / reduced-motion baseline)", () => {
  it("renders the final species number without animation", () => {
    const html = renderToStaticMarkup(<StoryStat speciesCount={37} days={84} />);
    expect(html).toContain(">37<");
    expect(html).toContain("especies de animales");
    expect(html).toContain("84 días de monitoreo");
  });

  it("renders 0 cleanly when no species were recorded", () => {
    const html = renderToStaticMarkup(<StoryStat speciesCount={0} days={0} />);
    expect(html).toContain(">0<");
  });
});

describe("buildSpeciesStatsText", () => {
  const sp = (
    taxonomicType: string | null,
    detectionCount: number,
  ): SiteSpecies =>
    ({
      speciesName: "X",
      spanishName: null,
      commonName: null,
      taxonomicType,
      detectionCount,
      avgConfidence: 0,
      photoImageId: 1,
      iucnStatus: null,
    }) as unknown as SiteSpecies;

  it("counts species, detections, aves and mamíferos with plurals", () => {
    const t = buildSpeciesStatsText([
      sp("bird", 100),
      sp("mammal", 40),
      sp("mammal", 10),
    ]);
    expect(t).toBe("3 especies · 150 detecciones · 1 ave · 2 mamíferos");
  });

  it("uses singular forms and omits empty taxonomic groups", () => {
    const t = buildSpeciesStatsText([sp("reptile", 1)]);
    expect(t).toBe("1 especie · 1 detección");
  });

  it("degrades to species + detections when types are unknown", () => {
    const t = buildSpeciesStatsText([sp(null, 5), sp(null, 3)]);
    expect(t).toBe("2 especies · 8 detecciones");
  });
});

describe("PublicSiteShell", () => {
  it("renders the hero image from heroImageId", () => {
    const html = renderToStaticMarkup(
      <PublicSiteShell data={makeData()} token="tok123" />,
    );
    expect(html).toContain("/api/public/site-images/tok123/42?size=large");
    expect(html).toContain("Finca La Esperanza");
    expect(html).toContain("Esto vive en su tierra");
  });

  it("falls back to a text header when there is no hero image", () => {
    const html = renderToStaticMarkup(
      <PublicSiteShell
        data={makeData({ heroImageId: null, species: [] })}
        token="tok123"
      />,
    );
    // No <img> hero, but the name + eyebrow still render.
    expect(html).not.toContain("<img");
    expect(html).toContain("Finca La Esperanza");
    expect(html).toContain("Esto vive en su tierra");
  });

  it("renders the video placeholder when no intro video is configured", () => {
    const html = renderToStaticMarkup(
      <PublicSiteShell data={makeData()} token="tok" hasIntroVideo={false} />,
    );
    expect(html).toContain("un mensaje en video del equipo FCAT");
    expect(html).not.toContain("/api/public/intro-video");
  });

  it("renders the intro video when configured", () => {
    const html = renderToStaticMarkup(
      <PublicSiteShell data={makeData()} token="tok" hasIntroVideo />,
    );
    expect(html).toContain("/api/public/intro-video");
  });

  it("promotes projectContext above the config-ordered blocks (U6)", () => {
    const data = makeData({
      contentBlocks: [
        { type: "note", text: "NOTA_FCAT" },
        { type: "summary", text: "RESUMEN_TEXTO" },
        { type: "projectContext", blurb: "SOBRE_PROYECTO", siteCount: 42 },
      ],
    });
    const html = renderToStaticMarkup(
      <PublicSiteShell data={data} token="tok" />,
    );
    const iNote = html.indexOf("NOTA_FCAT");
    const iSummary = html.indexOf("RESUMEN_TEXTO");
    const iContext = html.indexOf("SOBRE_PROYECTO");
    // projectContext is pulled out of config order and rendered first (right
    // under the video); the remaining blocks keep their configured order.
    expect(iContext).toBeGreaterThan(-1);
    expect(iContext).toBeLessThan(iNote);
    expect(iSummary).toBeGreaterThan(iNote);
    expect(html).toContain("42 fincas");
  });

  it("renders the species grid and the contact form at the end", () => {
    const html = renderToStaticMarkup(
      <PublicSiteShell data={makeData()} token="tok" />,
    );
    expect(html).toContain("GRID_ESPECIES");
    expect(html).toContain("FORM_CONTACTO");
    // Contact form is the last section.
    expect(html.indexOf("GRID_ESPECIES")).toBeLessThan(
      html.indexOf("FORM_CONTACTO"),
    );
  });
});
