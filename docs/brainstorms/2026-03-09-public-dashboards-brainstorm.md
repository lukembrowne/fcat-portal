# Public Dashboards — Brainstorm

**Date**: 2026-03-09
**Status**: Ready for planning

## What We're Building

A generalized public dashboard system that lets FCAT share curated data with collaborators, researchers, and the public — without requiring login. Public dashboards live under `/public/` (already bypasses oauth2-proxy) and are developer-built pages with curated content, interactive charts, and links to formal data repositories (EDI) for downloads and citation.

### Key User Stories

- **External collaborator** visits `portal.fcat-ecuador.org/public/climate`, explores weather station charts interactively, then follows the EDI link to download the formal dataset with its DOI citation
- **FCAT staff member** sees a "Público" section in the sidebar, clicks through to preview exactly what the public sees
- **Researcher** lands on `/public`, sees a card grid of all available data dashboards, picks what interests them
- **Developer** adds a new public dashboard by creating a page under `/public/[slug]` and registering it in a config array

## Why This Approach

### Approach Considered: Admin-managed dashboard builder
- Rejected: Over-engineered for 5-10 curated dashboards. Each dashboard has unique data queries, custom charts, and specific requirements. A generic builder would fight the specificity.

### Approach Considered: Token-gated (like camera trap shares)
- Rejected: Public dashboards should be truly open — no friction for collaborators, embeddable, SEO-friendly, citable with stable URLs.

### Approach Considered: Built-in CSV downloads with citation
- Rejected in favor of linking to EDI (Environmental Data Initiative) for formal dataset publishing. EDI provides DOIs, versioning, proper metadata, and download infrastructure. The portal serves as the interactive exploration layer; EDI is the authoritative data source for downloads and citation.

### Chosen: Code-defined pages with curated content + EDI links
- Each dashboard is a purpose-built Next.js page with its own data queries and layout
- Shared public layout, components, and patterns (charts, EDI links, info panels)
- A registry/config array defines the dashboard catalog (title, description, slug, icon) for the landing page
- Staff see a "Público" sidebar section linking to the public landing page and individual dashboards

## Key Decisions

1. **Truly public URLs** — No tokens, no auth. `/public/*` and `/api/public/*` already bypass oauth2-proxy and proxy.ts. Rate limiting already configured in nginx.

2. **New sidebar section "Público"** — Top-level section visible to all logged-in staff. Links to the public landing page and individual dashboards so staff can preview what the public sees.

3. **Code-defined, curated content** — Each dashboard is a developer-built page. No admin UI for toggling dashboards. Content is thoughtfully curated (descriptions, highlighted metrics, date ranges) rather than raw data dumps.

4. **Shared components, public polish** — Reuse internal chart/table components but wrap them in a cleaner public layout with better typography and FCAT branding. Not a full redesign, but polished for external visitors.

5. **Landing page at `/public`** — Card grid showing all available dashboards with descriptions and icons. Entry point for visitors.

6. **EDI for data downloads and citation** — Formal datasets published through EDI (edirepository.org) with DOIs. Public dashboards link to EDI for downloads rather than serving CSVs directly. Each dashboard includes an "Access the data" section pointing to the EDI package with suggested citation.

7. **Dashboard registry pattern** — A simple config array (e.g., `PUBLIC_DASHBOARDS` in a shared file) defines each dashboard's metadata (slug, title, description, icon, ediUrl, terms). The landing page and sidebar both read from this array. Adding a new dashboard = creating the page + adding an entry.

8. **Analytics via Umami** — No built-in visitor tracking. Umami analytics added separately.

9. **Terms vary by project** — Each dashboard/dataset can specify its own usage terms and license.

## Architecture Notes

### Existing Infrastructure (already in place)
- nginx bypasses auth for `/public/*` (rate limited: 5r/s, burst 15) and `/api/public/*` (10r/s, burst 30)
- `proxy.ts` matcher excludes `/public/` and `/api/public/`
- Public layout exists at `src/app/public/layout.tsx` (FCAT logo header, no sidebar)
- Camera trap share pages under `/public/share/[token]` prove the pattern works

### New Components Needed
- **Dashboard registry** — Config array with slug, title, description, icon, ediUrl, terms for each dashboard
- **Public landing page** — `/public/page.tsx` with responsive card grid
- **Enhanced public layout** — Extend existing `public/layout.tsx` with lightweight nav for switching between dashboards
- **Shared public components** — EDI link/citation block, data info panel, chart wrappers
- **Sidebar "Público" section** — Added to `sidebar-nav.tsx`, visible to all authenticated users

### Climate Dashboard (First Implementation)
- Route: `/public/climate`
- Data: Temperature, humidity, rainfall, solar radiation, wind from existing climate tables
- Charts: Time series with date range selector (reuse existing chart components)
- EDI link: Points to the published climate dataset on edirepository.org
- Info panel: Station metadata (location, elevation, instruments), data coverage period, update frequency
- Terms: Specific to climate data (defined per project)

## Planned Dashboards (Roadmap)

1. **Datos Climáticos** (`/public/climate`) — Weather station charts, station info, EDI dataset link
2. **Especies** (`/public/species`) — Species lists by taxa, conservation status, occurrence data
3. **Reforestación** (`/public/reforestation`) — Tree planting stats, survival rates, area restored
4. **Cámaras Trampa Destacadas** (`/public/camera-trap-highlights`) — Curated best wildlife photos
5. **Publicaciones** (`/public/publications`) — Research papers, reports, data citations

## Open Questions

- Should the public landing page eventually live at a separate subdomain (e.g., `data.fcat-ecuador.org`)? For now, stays on `portal.fcat-ecuador.org/public`.
- How much of the internal climate chart code can be directly reused vs. needs a public-facing variant? (Need to check if current charts depend on auth context.)
- For dashboards without an EDI dataset yet (e.g., species lists), should we still offer a simple download, or wait until EDI publication?

## Next Steps

Run `/workflows:plan` to create an implementation plan, starting with the climate dashboard as the first concrete deliverable.
