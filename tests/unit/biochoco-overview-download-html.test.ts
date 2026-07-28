/**
 * Tests for the self-contained HTML export's funders & acknowledgements section.
 *
 * `buildHtml` is a pure function of (snapshot, lang, dataUris, assets), so it is
 * called directly rather than through the route. The fixture snapshot carries no
 * curated images or audio, which keeps `inlineCuratedImages` (Drive + sharp) and
 * `loadStaticAssets` (disk) out of the picture entirely.
 *
 * The live page renders the same content block through a different renderer
 * (report-shell.tsx), so these assertions guard the export half of that pair.
 */

import { describe, it, expect } from "vitest";
import { buildHtml, renderAckGroups } from "@/app/public/biochoco-overview/download/route";
import { CONTENT } from "@/app/public/biochoco-overview/content";
import type { ReportSnapshot } from "@/app/public/biochoco-overview/lib/snapshot-types";

const SNAPSHOT: ReportSnapshot = {
  slug: "biochoco-overview",
  generatedAt: "2026-07-28T12:00:00.000Z",
  generatedBy: null,
  stats: {
    project: { id: 1, name: "BioChoco" },
    deploymentCount: 10,
    retrievedCount: 8,
    retrievedSensors: { cam: 8, audio: 6, climate: 5 },
    distinctSites: 8,
    habitatCounts: {},
    byStatus: [],
    samplingSpan: { start: "2024-01-01", end: "2026-06-30" },
    cameraTrapDays: 240,
    totalImages: 1000,
    totalDetections: 400,
    cameraRealSpecies: 35,
    cameraSpeciesByType: { mammal: 20, bird: 15 },
    identificationsReviewed: 400,
    cameraTopSpecies: [],
    audio: { files: 500, bytes: 1e12, deployments: 6 },
    audioSpeciesCount: 100,
    audioDetections08: 5000,
    audioReviewedSpeciesCount: 40,
    audioThreshold: 0.8,
    audioTopSpecies: [],
    ibutton: { processed: 5, readings: 20000 },
    uploadBytes: { camera: 0, audio: 0, ibutton: 0 },
    uploadCounts: { camPhotos: 1000, audioFiles: 500, ibuttonFiles: 5 },
    deploymentsByMonth: [],
    deployments: [],
  },
  images: [],
  audio: [],
};

const NO_ASSETS = { hero: null, habitat: {}, gallery: [] };

function render(lang: "en" | "es"): string {
  return buildHtml(SNAPSHOT, lang, new Map(), NO_ASSETS);
}

describe("download export — funders & acknowledgements", () => {
  it("renders the English section with all three funders and MAATE", () => {
    const html = render("en");
    expect(html).toContain("Funders and acknowledgements");
    expect(html).toContain("Wedgetail Foundation");
    expect(html).toContain("National Science Foundation");
    expect(html).toContain("Private donors");
    expect(html).toContain(
      "Ministry of the Environment, Water and Ecological Transition (MAATE)",
    );
    expect(html).toContain("Research permitting and institutional support");
  });

  it("renders the Spanish section and none of the English group copy", () => {
    const html = render("es");
    expect(html).toContain("Financiadores y agradecimientos");
    expect(html).toContain("Donantes privados");
    expect(html).toContain(
      "Ministerio del Ambiente, Agua y Transición Ecológica (MAATE)",
    );
    expect(html).not.toContain("Funders and acknowledgements");
    expect(html).not.toContain("Private donors");
  });

  it("keeps MAATE after the funders, so the two groups can't be conflated", () => {
    for (const lang of ["en", "es"] as const) {
      const html = render(lang);
      const funders = CONTENT[lang].acknowledgements.groups[0].entries;
      const maate = CONTENT[lang].acknowledgements.groups[1].entries[0].name;
      const lastFunder = Math.max(
        ...funders.map((f) => html.indexOf(f.name)),
      );
      expect(lastFunder).toBeGreaterThan(-1);
      expect(html.indexOf(maate)).toBeGreaterThan(lastFunder);
    }
  });

  it("places the section before the footer", () => {
    const html = render("en");
    expect(html.indexOf("Funders and acknowledgements")).toBeLessThan(
      html.indexOf("<footer>"),
    );
  });

  it("escapes group titles, entry names, and notes", () => {
    const html = renderAckGroups([
      {
        title: "Funders & partners",
        body: "Support comes from <these> organizations:",
        entries: [{ name: 'Smith & Jones "Foundation"', note: "Award <1234>" }],
      },
    ]);
    expect(html).toContain("Funders &amp; partners");
    expect(html).toContain("Support comes from &lt;these&gt; organizations:");
    expect(html).toContain("Smith &amp; Jones &quot;Foundation&quot;");
    expect(html).toContain("Award &lt;1234&gt;");
    expect(html).not.toContain("<these>");
  });

  it("omits the note line when an entry has none", () => {
    const html = renderAckGroups([
      { title: "T", body: "B", entries: [{ name: "No Note Foundation" }] },
    ]);
    expect(html).toContain("<b>No Note Foundation</b></li>");
  });

  it("omits the lead paragraph when a group has no body", () => {
    const html = renderAckGroups([{ title: "T", entries: [{ name: "X" }] }]);
    expect(html).toContain("<h3>T</h3><ul");
    expect(html).not.toContain("<p>");
  });
});
