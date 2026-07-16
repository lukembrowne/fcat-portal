/**
 * Unit tests for the finca public-pages table (U4).
 *
 * The repo has no `@testing-library/react`/jsdom (env is "node"), so — like
 * `landowner-public-shell.test.tsx` — we render with `react-dom/server`'s
 * `renderToStaticMarkup`. That renders the always-visible row cells (pills,
 * badges, the "Editar" link) but NOT the Radix dropdown content, which is
 * portaled and closed. That's fine: the dropdown click behaviour / row-nav
 * guard can't be exercised in static markup, but the KTD-4 guarantee we care
 * about here is that no raw share URL is present in the markup — which holds
 * precisely because the URL is fetched on demand and never rendered.
 *
 * `useRouter` and the two server actions are mocked so importing the client
 * table doesn't pull the DB / Next app-router runtime.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/biochoco/paginas-publicas/actions", () => ({
  getSiteShareUrl: vi.fn(),
}));
vi.mock("@/app/biochoco/resultados/actions", () => ({
  revokeSiteShareLink: vi.fn(),
}));

import { PagesTable } from "@/app/biochoco/paginas-publicas/pages-table";
import type { SitePublicPageRow } from "@/app/biochoco/paginas-publicas/sort";

function makeRow(overrides: Partial<SitePublicPageRow> = {}): SitePublicPageRow {
  return {
    siteId: "CCN-014",
    siteName: "Finca La Esperanza",
    habitat: "bosque",
    deploymentCount: 2,
    status: { key: "publicado", personalized: false, viewedAt: null },
    readiness: {
      cameras: "complete",
      audio: "in_progress",
      temperature: "none",
      habitat: "none",
    },
    lastEditedAt: new Date("2026-06-01T00:00:00Z"),
    lastViewedAt: null,
    viewCount: 3,
    hasActiveToken: true,
    ...overrides,
  };
}

function render(rows: SitePublicPageRow[]): string {
  return renderToStaticMarkup(
    <PagesTable rows={rows} sortBy="estado" sortDir="asc" />
  );
}

describe("PagesTable status pills", () => {
  it("renders the correct Spanish label per status key", () => {
    const sinEmpezar = render([
      makeRow({
        siteId: "A-001",
        hasActiveToken: false,
        status: { key: "sin_empezar", personalized: false, viewedAt: null },
      }),
    ]);
    expect(sinEmpezar).toContain("Sin empezar");

    const publicado = render([
      makeRow({
        siteId: "A-002",
        status: { key: "publicado", personalized: false, viewedAt: null },
      }),
    ]);
    expect(publicado).toContain("Publicado");

    const visto = render([
      makeRow({
        siteId: "A-003",
        status: {
          key: "visto",
          personalized: false,
          viewedAt: new Date(Date.now() - 5 * 86_400_000),
        },
      }),
    ]);
    expect(visto).toContain("Visto");
  });
});

describe("PagesTable Personalizada badge", () => {
  it("shows the badge only when personalized is true", () => {
    const personalized = render([
      makeRow({
        status: { key: "publicado", personalized: true, viewedAt: null },
      }),
    ]);
    expect(personalized).toContain("Personalizada");

    const notPersonalized = render([
      makeRow({
        status: { key: "publicado", personalized: false, viewedAt: null },
      }),
    ]);
    expect(notPersonalized).not.toContain("Personalizada");
  });
});

describe("PagesTable relative view text", () => {
  it('shows "hace N días" only for the visto status', () => {
    const visto = render([
      makeRow({
        status: {
          key: "visto",
          personalized: false,
          viewedAt: new Date(Date.now() - 5 * 86_400_000),
        },
      }),
    ]);
    expect(visto).toContain("hace 5 días");

    const publicado = render([
      makeRow({
        status: { key: "publicado", personalized: false, viewedAt: null },
      }),
    ]);
    expect(publicado).not.toContain("hace");
  });
});

describe("PagesTable KTD-4 — no raw share URL", () => {
  it("never renders the public share URL path", () => {
    const html = render([
      makeRow({ siteId: "A-001", hasActiveToken: true }),
      makeRow({
        siteId: "A-002",
        hasActiveToken: false,
        status: { key: "sin_empezar", personalized: false, viewedAt: null },
      }),
    ]);
    expect(html).not.toContain("/public/biochoco/");
    expect(html).not.toContain("wa.me");
  });
});

describe("PagesTable Datos readiness column", () => {
  it("renders the Datos header and per-datatype icon tooltips", () => {
    const html = render([
      makeRow({
        readiness: {
          cameras: "complete",
          audio: "in_progress",
          temperature: "none",
          habitat: "none",
        },
      }),
    ]);
    expect(html).toContain("Datos");
    // Three status icons, each with a Spanish <title> tooltip driven by status.
    expect(html).toContain("Cámaras: verificado");
    expect(html).toContain("BirdNET: audio sin analizar");
    expect(html).toContain("Temperatura: sin datos");
    // Status-driven colors present on the icons.
    expect(html).toContain("text-emerald-600");
    expect(html).toContain("text-amber-500");
  });
});

describe("PagesTable Editar link", () => {
  it("links Editar to the builder route for the row's site", () => {
    const html = render([makeRow({ siteId: "CCN-099" })]);
    expect(html).toContain('href="/biochoco/paginas-publicas/CCN-099"');
  });

  it("renders an empty state when there are no rows", () => {
    const html = render([]);
    expect(html).toContain("No hay fincas para mostrar");
  });
});
