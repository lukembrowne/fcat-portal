/**
 * Card list + card markup for /biochoco/fichas-especies (U2, U3, U5).
 *
 * The repo has no jsdom / @testing-library (vitest env is "node"), so — like
 * `landowner-pages-table.test.tsx` — these render with `react-dom/server`'s
 * `renderToStaticMarkup`. That covers everything visible on first paint (cards,
 * badges, the textarea's stored value, the counter, the chunk cap) but NOT
 * interaction: typing, saving, and toggling the preview are exercised through
 * the pure modules in `fichas-especies-card-state.test.ts` and
 * `fichas-especies-list-view.test.ts` instead.
 *
 * The server action is mocked so importing the card doesn't pull the DB.
 */

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/biochoco/fichas-especies/actions", () => ({
  updateSpeciesContent: vi.fn(),
}));

import { FichasEspeciesClient } from "@/app/biochoco/fichas-especies/fichas-client";
import { SpeciesCard } from "@/app/biochoco/fichas-especies/species-card";
import { FormatSpeciesContent } from "@/lib/landowner/format-species-content";
import { SPECIES_CONTENT_MAX } from "@/app/biochoco/fichas-especies/content-types";
import type { SpeciesContentRow } from "@/app/biochoco/fichas-especies/content-types";

let nextId = 1;

function makeRow(overrides: Partial<SpeciesContentRow> = {}): SpeciesContentRow {
  return {
    id: nextId++,
    scientificName: "Dasyprocta punctata",
    commonName: "Agouti",
    spanishName: "Guatusa",
    type: "mammal",
    publicContent: null,
    detectionCount: 12,
    hasContent: false,
    representativeImageId: null,
    ...overrides,
  };
}

function renderList(rows: SpeciesContentRow[]): string {
  return renderToStaticMarkup(<FichasEspeciesClient species={rows} />);
}

function renderCard(row: SpeciesContentRow): string {
  return renderToStaticMarkup(
    <SpeciesCard species={row} onDirtyChange={() => {}} onSaved={() => {}} />
  );
}

/** One `aria-label="Ficha de …"` per rendered card. */
function countCards(html: string): number {
  return (html.match(/aria-label="Ficha de /g) ?? []).length;
}

describe("card list", () => {
  it("renders one card per species with its display and scientific name", () => {
    const html = renderList([
      makeRow({ spanishName: "Guatusa", scientificName: "Dasyprocta punctata" }),
      makeRow({ spanishName: "Armadillo", scientificName: "Dasypus novemcinctus" }),
    ]);
    expect(countCards(html)).toBe(2);
    expect(html).toContain("Guatusa");
    expect(html).toContain("Dasyprocta punctata");
    expect(html).toContain("Armadillo");
    expect(html).toContain("Dasypus novemcinctus");
  });

  it("badges species by whether a ficha exists", () => {
    const html = renderList([
      makeRow({ spanishName: "Guatusa", hasContent: true }),
      makeRow({ spanishName: "Armadillo", hasContent: false }),
    ]);
    expect(html).toContain("Con ficha");
    expect(html).toContain("Sin ficha");
  });

  it("groups record counts in Spanish and shows an em dash for zero", () => {
    const html = renderList([
      makeRow({ spanishName: "Guatusa", detectionCount: 1204 }),
      // Zero-detection rows only appear under the "Todas" scope, so this one is
      // reached via the pinning-free default only when it has records; render it
      // through a card directly to assert the placeholder.
    ]);
    expect(html).toContain("1.204 registros");

    const zero = renderCard(makeRow({ detectionCount: 0 }));
    expect(zero).toContain("—");
    expect(zero).not.toContain("registros");
  });

  it("defaults to the con-registros scope, hiding the audio-only tail", () => {
    const html = renderList([
      makeRow({ spanishName: "Guatusa", detectionCount: 12 }),
      makeRow({ spanishName: "Tangara", type: "bird", detectionCount: 0 }),
    ]);
    expect(countCards(html)).toBe(1);
    expect(html).toContain("Guatusa");
    expect(html).not.toContain("Tangara");
  });

  it("renders the empty state when nothing matches", () => {
    const html = renderList([makeRow({ detectionCount: 0 })]);
    expect(html).toContain("No se encontraron especies");
    expect(countCards(html)).toBe(0);
  });

  it("caps the render window at 100 cards and offers Mostrar más", () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      makeRow({ spanishName: `Especie ${i}`, detectionCount: i + 1 })
    );
    const html = renderList(rows);
    expect(countCards(html)).toBe(100);
    expect(html).toContain("Mostrar más");
    expect(html).toContain("50 restantes");
  });

  it("does not offer Mostrar más when everything fits", () => {
    const html = renderList([makeRow(), makeRow({ spanishName: "Otra" })]);
    expect(html).not.toContain("Mostrar más");
  });

  it("counts fichas against the visible scope", () => {
    const html = renderList([
      makeRow({ spanishName: "Guatusa", hasContent: true }),
      makeRow({ spanishName: "Armadillo", hasContent: false }),
    ]);
    expect(html).toContain("1 de 2 especies con ficha");
  });
});

describe("species card", () => {
  it("puts the stored ficha inside the always-mounted textarea", () => {
    const html = renderCard(
      makeRow({ publicContent: "Dispersa semillas.", hasContent: true })
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("Dispersa semillas.");
  });

  it("renders an empty textarea with the authoring placeholder when there is no ficha", () => {
    const html = renderCard(makeRow({ publicContent: null }));
    expect(html).toContain("<textarea");
    expect(html).toContain("dispersa semillas");
    expect(html).toContain("consejo de manejo");
  });

  it("labels the textarea with the species name for screen readers", () => {
    const html = renderCard(makeRow({ spanishName: "Guatusa" }));
    expect(html).toContain('aria-label="Ficha de Guatusa"');
  });

  it("does not hard-cap typing — a pasted overlong draft must not be truncated", () => {
    const html = renderCard(makeRow());
    expect(html).not.toContain("maxLength");
  });

  it("warns by how much an overlong ficha exceeds the cap", () => {
    const html = renderCard(
      makeRow({ publicContent: "x".repeat(SPECIES_CONTENT_MAX + 12) })
    );
    expect(html).toContain("Te pasaste por 12 caracteres");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("uses the singular when exactly one character over", () => {
    const html = renderCard(
      makeRow({ publicContent: "x".repeat(SPECIES_CONTENT_MAX + 1) })
    );
    expect(html).toContain("Te pasaste por 1 carácter.");
  });

  it("says nothing about length when the ficha fits", () => {
    const html = renderCard(makeRow({ publicContent: "Dispersa semillas." }));
    expect(html).not.toContain("Te pasaste");
    expect(html).toContain('aria-invalid="false"');
  });

  it("counts the trimmed length so the counter matches what the server enforces", () => {
    const html = renderCard(makeRow({ publicContent: "  abcde  " }));
    expect(html).toContain(`5/${SPECIES_CONTENT_MAX}`);
  });

  it("keeps a row count as the fallback for browsers without field-sizing", () => {
    const html = renderCard(makeRow());
    expect(html).toMatch(/rows="\d+"/);
  });

  it("shows the character counter against the stored content length", () => {
    const html = renderCard(makeRow({ publicContent: "abcde" }));
    expect(html).toContain(`5/${SPECIES_CONTENT_MAX}`);
  });

  it("renders the Spanish type label, falling back to the raw value", () => {
    expect(renderCard(makeRow({ type: "mammal" }))).toContain("Mamífero");
    expect(renderCard(makeRow({ type: "bird" }))).toContain("Ave");
    expect(renderCard(makeRow({ type: "quimera" }))).toContain("quimera");
  });

  it("hides the save controls until the card is dirty", () => {
    const html = renderCard(makeRow({ publicContent: "Ya guardado" }));
    expect(html).not.toContain("Guardar");
    expect(html).not.toContain("Descartar");
  });

  it("renders the representative photo through the internal image proxy", () => {
    const html = renderCard(makeRow({ representativeImageId: 4321 }));
    expect(html).toContain('src="/api/ct-images/4321?size=thumb"');
  });

  it("falls back to a placeholder when the species has no photo", () => {
    const html = renderCard(makeRow({ representativeImageId: null }));
    expect(html).not.toContain("/api/ct-images/");
    expect(html).toContain("lucide-paw-print");
  });

  it("keeps the thumbnail decorative so the name isn't announced twice", () => {
    const html = renderCard(makeRow({ representativeImageId: 99 }));
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the preview collapsed on first paint", () => {
    const html = renderCard(makeRow({ publicContent: "Dispersa semillas." }));
    expect(html).toContain("Vista previa");
    expect(html).not.toContain("Así se verá");
  });
});

describe("preview formatting (what the card previews and the finca page renders)", () => {
  const render = (text: string) =>
    renderToStaticMarkup(<FormatSpeciesContent text={text} />);

  it("splits blank-line separated text into paragraphs", () => {
    const html = render("Primer parrafo.\n\nSegundo parrafo.");
    expect((html.match(/<p /g) ?? []).length).toBe(2);
  });

  it("renders dash-prefixed lines as a single bullet list", () => {
    const html = render("Consejos:\n- Vacunar\n- Esterilizar");
    expect((html.match(/<ul /g) ?? []).length).toBe(1);
    expect((html.match(/<li /g) ?? []).length).toBe(2);
    expect(html).toContain("Vacunar");
  });

  it("renders nothing for empty text", () => {
    expect(render("")).toBe("");
    expect(render("   \n  ")).toBe("");
  });

  it("escapes markup instead of injecting it", () => {
    const html = render('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
