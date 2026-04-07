---
title: "feat: Public Dashboards with Climate Data"
type: feat
date: 2026-03-10
brainstorm: docs/brainstorms/2026-03-09-public-dashboards-brainstorm.md
---

# Public Dashboards with Climate Data

## Overview

Build a generalized public dashboard system under `/public/` that lets FCAT share curated data with collaborators and researchers without login. The first dashboard surfaces interactive climate charts with station metadata and EDI repository links. Public pages are bilingual (Spanish/English) with a simple language toggle.

## Problem Statement

FCAT collects valuable environmental data (climate, species, reforestation) but currently all data is locked behind OAuth2 authentication. External collaborators, researchers, and the public cannot access or explore this data without an FCAT Google account. The portal needs outward-facing pages that showcase FCAT's data while directing users to EDI for formal downloads and citation.

## Proposed Solution

Leverage the existing `/public/*` auth bypass infrastructure (already configured in nginx and proxy.ts) to build code-defined, curated dashboard pages. A dashboard registry pattern makes adding new dashboards straightforward. The climate dashboard is the first implementation, reusing the existing `ClimateCharts` Recharts component with new auth-free data fetching.

## Technical Approach

### Architecture

```
/public                    → Landing page (card grid from registry)
/public/climate            → Climate dashboard (charts + station info + EDI link)
/public/share/[token]      → Existing camera trap shares (unchanged)

/api/public/climate/data   → Chart data API (no auth, hourly only, auto-aggregation)
```

**Data flow for public climate dashboard:**
1. Page loads as Server Component with initial data (SSR)
2. Client component (`PublicClimateShell`) handles interactivity (date range, chart tabs)
3. Client fetches data via `/api/public/climate/data` API route (not server actions, since those require auth)
4. API route queries `climate_readings` directly with hourly resolution, auto-aggregation
5. Reuses `ChartDataPoint` type and `ClimateCharts` rendering component from internal dashboard

**Why API route instead of server actions:**
Server actions called from unauthenticated pages would need careful handling — the existing pattern guards all actions with `requirePermission()`. A dedicated public API route is cleaner: explicit contract, rate-limited by nginx, no risk of accidentally exposing auth-gated actions.

### Key Design Decisions

1. **New tab for staff preview** — Sidebar "Público" links use `target="_blank"` so staff sees the true public layout
2. **Hourly only, auto-aggregation, charts only** — No 15min resolution, no raw mode, no data table, no CSV export on portal (use EDI)
3. **Bilingual (ES/EN)** — Simple translation object maps per page with language toggle button. No i18n library, no URL changes. Only applies to `/public/*` pages
4. **EDI for downloads/citation** — Portal is the "explore" layer; EDI is the "download and cite" layer
5. **Dashboard registry** — Config array drives both landing page cards and sidebar links

### Implementation Phases

#### Phase 1: Foundation (Dashboard Registry + Public Layout Enhancement)

**Goal:** Establish the reusable infrastructure that all public dashboards will share.

##### 1.1 Dashboard Registry

Create `src/lib/public-dashboards.ts`:

```typescript
// src/lib/public-dashboards.ts
import type { LucideIcon } from "lucide-react";

export interface PublicDashboard {
  slug: string;           // URL segment: /public/[slug]
  icon: string;           // Lucide icon name
  ediUrl?: string;        // EDI repository dataset URL
  terms?: string;         // Usage terms (e.g., "CC BY 4.0")
  translations: {
    es: { title: string; description: string; };
    en: { title: string; description: string; };
  };
}

export const PUBLIC_DASHBOARDS: PublicDashboard[] = [
  {
    slug: "climate",
    icon: "cloud-sun",
    ediUrl: undefined, // TBD: EDI package URL once published
    terms: "CC BY 4.0",
    translations: {
      es: {
        title: "Datos Climáticos",
        description: "Datos de la estación meteorológica de FCAT: temperatura, humedad, precipitación, radiación solar y viento.",
      },
      en: {
        title: "Climate Data",
        description: "FCAT weather station data: temperature, humidity, precipitation, solar radiation, and wind.",
      },
    },
  },
];
```

##### 1.2 Bilingual Support

Create `src/app/public/i18n.tsx`:

```typescript
// src/app/public/i18n.tsx
"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type Locale = "es" | "en";

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
}>({ locale: "es", setLocale: () => {} });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("es");
  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}

// Generic translation helper
export function useT<T extends Record<string, string>>(
  translations: { es: T; en: T }
): T {
  const { locale } = useLocale();
  return translations[locale];
}
```

Language toggle component (`src/app/public/language-toggle.tsx`): a simple button that switches between "ES" and "EN", stored in React state (no persistence needed — public visitors are one-shot).

##### 1.3 Enhanced Public Layout

Modify `src/app/public/layout.tsx`:
- Wrap children in `<LocaleProvider>`
- Add language toggle button to header
- Add lightweight nav bar showing links to dashboards from `PUBLIC_DASHBOARDS` registry (hidden on `/public/share/*` token pages)
- Keep existing FCAT logo header and footer
- Do NOT add nav to camera trap share pages — detect via pathname

##### 1.4 Sidebar "Público" Section

Modify `src/components/sidebar-nav.tsx`:
- Add new "Público" section visible to ALL authenticated users (no permission check)
- Items read from `PUBLIC_DASHBOARDS` registry
- Each link uses `target="_blank"` and includes an external-link icon indicator
- Add `"globe"` to `IconName` union in `sidebar-shell.tsx` for the section icon

**Files to create/modify:**
- Create: `src/lib/public-dashboards.ts`
- Create: `src/app/public/i18n.tsx`
- Create: `src/app/public/language-toggle.tsx`
- Modify: `src/app/public/layout.tsx`
- Modify: `src/components/sidebar-nav.tsx`
- Modify: `src/components/sidebar-shell.tsx` (add "globe" icon)

---

#### Phase 2: Public Landing Page

**Goal:** A welcoming entry point at `/public` that lists all available dashboards.

Create `src/app/public/page.tsx`:
- Server Component that reads `PUBLIC_DASHBOARDS` registry
- Renders a brief FCAT introduction paragraph (bilingual)
- Card grid of available dashboards with icon, title, description
- Each card links to `/public/[slug]`
- Responsive: 1 column mobile, 2 columns tablet, 3 columns desktop
- OG meta tags: "FCAT — Datos Públicos / Public Data"

**Landing page translations** (`src/app/public/translations.ts`):
```typescript
export const landingTranslations = {
  es: {
    heading: "Datos Públicos",
    intro: "La Fundación para la Conservación de los Andes Tropicales (FCAT) comparte datos ambientales de sus estaciones de investigación en el Chocó ecuatoriano.",
    viewDashboard: "Ver panel",
  },
  en: {
    heading: "Public Data",
    intro: "The Foundation for the Conservation of the Tropical Andes (FCAT) shares environmental data from its research stations in the Ecuadorian Chocó.",
    viewDashboard: "View dashboard",
  },
};
```

**Files to create:**
- Create: `src/app/public/page.tsx`
- Create: `src/app/public/translations.ts`

---

#### Phase 3: Public Climate API

**Goal:** An unauthenticated API route for climate chart data.

Create `src/app/api/public/climate/data/route.ts`:

- GET endpoint accepting query params: `dateStart`, `dateEnd`
- Hardcoded to `resolution: "hourly"` (no user choice)
- Auto-aggregation based on date range span (reuse logic from internal `fetchClimateChartData`):
  - ≤7 days → raw hourly
  - ≤90 days → daily
  - ≤730 days → monthly
  - >730 days → yearly
- Returns `ChartDataPoint[]` as JSON
- Input validation: date format check, max range cap (10 years), reject invalid params
- `Cache-Control: public, max-age=3600` (1 hour — climate data changes infrequently)

**Security considerations** (from learnings):
- Validate all query parameters strictly (date format regex)
- No path traversal risk (no file paths in params)
- Rate limited by existing nginx config (10r/s for `/api/public/`)
- No sensitive data exposed (climate readings are inherently public)

Also create a summary endpoint for the landing page cards:

Create `src/app/api/public/climate/summary/route.ts`:
- Returns: total reading count, date range, latest reading timestamp
- Used by landing page card to show live stats (e.g., "42,000 registros desde 2021")
- Cached aggressively: `Cache-Control: public, max-age=86400` (24 hours)

**Shared query logic:**

Extract reusable query functions from `src/app/climate/dashboard/actions.ts` into a shared file `src/lib/climate-queries.ts`:
- `queryClimateChartData(filters, aggregation)` — raw SQL query logic
- `queryClimateSummary(filters)` — aggregate stats
- `queryAvailableYears(resolution)` — distinct years
- `determineAggregation(dateStart, dateEnd)` — auto-aggregation heuristic

The internal actions.ts imports from this shared file and wraps with `requirePermission()`. The public API route imports and calls directly.

**Files to create/modify:**
- Create: `src/lib/climate-queries.ts` (extracted from actions.ts)
- Create: `src/app/api/public/climate/data/route.ts`
- Create: `src/app/api/public/climate/summary/route.ts`
- Modify: `src/app/climate/dashboard/actions.ts` (import from shared queries)

---

#### Phase 4: Public Climate Dashboard

**Goal:** Interactive climate charts at `/public/climate` with station info and EDI link.

##### 4.1 Page Structure

Create `src/app/public/climate/page.tsx` (Server Component):
- Generates OG metadata (title, description — bilingual based on default locale ES)
- Fetches initial chart data server-side (default: last 365 days, hourly, auto-aggregated)
- Fetches station summary (total readings, date range)
- Renders `PublicClimateShell` client component with initial data

##### 4.2 Public Climate Shell

Create `src/app/public/climate/public-climate-shell.tsx` (Client Component):
- Simplified version of internal `DashboardShell`
- **Includes:** Date range filter (year selector or "all"), chart tabs, station info, EDI section
- **Excludes:** Resolution picker (hardcoded hourly), raw aggregation option, data table, CSV export, editing
- Fetches updated data from `/api/public/climate/data` when filters change
- Uses `useLocale()` for bilingual labels

##### 4.3 Chart Reuse

The existing `ClimateCharts` component at `src/app/climate/dashboard/climate-charts.tsx` accepts `data: ChartDataPoint[]` as props — it's a pure rendering component. It can be imported directly into the public shell.

However, it uses Spanish-only labels (axis titles, tooltips, tab names). Two options:
- **(a)** Make `ClimateCharts` accept a translations prop and update both internal and public usage
- **(b)** Create a thin `PublicClimateCharts` wrapper that passes translated labels

**Recommended: (a)** — Add an optional `labels` prop to `ClimateCharts`. Default to Spanish (no change for internal usage). Public shell passes the locale-appropriate labels. This avoids duplicating the chart component.

##### 4.4 Station Info & EDI Section

Create `src/app/public/climate/station-info.tsx` (Client Component):
- Station metadata: location description (no exact coordinates), elevation, instruments
- Data coverage: date range, total readings, update frequency
- **"Acceder a los datos / Access the data"** section:
  - EDI repository link (when available) with formatted citation
  - Usage terms (CC BY 4.0 or project-specific)
  - Contact info for data inquiries
- Derived from existing `AboutContent` component but simplified and bilingual

##### 4.5 Translations

Create `src/app/public/climate/translations.ts`:
```typescript
export const climateTranslations = {
  es: {
    title: "Datos Climáticos",
    subtitle: "Estación meteorológica FCAT — Chocó ecuatoriano",
    dateRange: "Rango de fechas",
    allData: "Todos los datos",
    station: "Información de la estación",
    accessData: "Acceder a los datos",
    citation: "Cómo citar",
    terms: "Términos de uso",
    // Chart labels
    temperature: "Temperatura (°C)",
    humidity: "Humedad (%)",
    precipitation: "Precipitación (mm)",
    solar: "Radiación Solar (W/m²)",
    wind: "Viento",
    pressure: "Presión (hPa)",
    avg: "Promedio", max: "Máximo", min: "Mínimo",
    // ...
  },
  en: {
    title: "Climate Data",
    subtitle: "FCAT Weather Station — Ecuadorian Chocó",
    dateRange: "Date range",
    allData: "All data",
    station: "Station information",
    accessData: "Access the data",
    citation: "How to cite",
    terms: "Terms of use",
    temperature: "Temperature (°C)",
    humidity: "Humidity (%)",
    precipitation: "Precipitation (mm)",
    solar: "Solar Radiation (W/m²)",
    wind: "Wind",
    pressure: "Pressure (hPa)",
    avg: "Average", max: "Maximum", min: "Minimum",
    // ...
  },
};
```

**Files to create/modify:**
- Create: `src/app/public/climate/page.tsx`
- Create: `src/app/public/climate/public-climate-shell.tsx`
- Create: `src/app/public/climate/station-info.tsx`
- Create: `src/app/public/climate/translations.ts`
- Modify: `src/app/climate/dashboard/climate-charts.tsx` (add optional `labels` prop)

---

#### Phase 5: Polish & Testing

##### 5.1 Error States
- `/public/climate` with zero readings → "No hay datos disponibles / No data available" message
- `/public/nonexistent` → Next.js 404 with public layout styling
- API errors → Graceful fallback in chart area ("Error al cargar datos / Error loading data")
- Rate limit exceeded (429 from nginx) → User sees a friendly message

##### 5.2 OG Meta Tags
- Per-dashboard `generateMetadata()` with title, description, OG tags
- No dynamic OG image in v1 (use static FCAT logo, same pattern as camera trap shares)

##### 5.3 Responsive Design
- Charts: `ResponsiveContainer` already handles width adaptation
- Chart tabs: horizontal scroll on mobile if needed
- Date filter: stack vertically on mobile
- Landing page cards: 1→2→3 column responsive grid
- Test at 320px, 768px, and 1280px widths

##### 5.4 Performance
- API responses cached 1 hour (`Cache-Control: public, max-age=3600`)
- Summary endpoint cached 24 hours
- Charts render client-side after initial SSR data load
- No waterfall: initial data passed from Server Component to Client Component as props

##### 5.5 Tests
- Unit tests for `climate-queries.ts` (shared query logic)
- API route tests for `/api/public/climate/data` (param validation, response shape)
- Integration test: public climate page renders without auth
- E2E test: visit `/public`, click climate card, see charts

**Files to create:**
- Create: `src/app/public/climate/__tests__/` (unit + integration tests)
- Create: `src/app/api/public/climate/__tests__/` (API route tests)

---

## File Summary

### New Files (14)

| File | Purpose |
|------|---------|
| `src/lib/public-dashboards.ts` | Dashboard registry config |
| `src/lib/climate-queries.ts` | Shared climate DB query logic (extracted) |
| `src/app/public/i18n.tsx` | Locale context + useT hook |
| `src/app/public/language-toggle.tsx` | ES/EN toggle button |
| `src/app/public/page.tsx` | Public landing page |
| `src/app/public/translations.ts` | Landing page translations |
| `src/app/public/climate/page.tsx` | Climate dashboard page |
| `src/app/public/climate/public-climate-shell.tsx` | Interactive chart shell |
| `src/app/public/climate/station-info.tsx` | Station metadata + EDI link |
| `src/app/public/climate/translations.ts` | Climate page translations |
| `src/app/api/public/climate/data/route.ts` | Chart data API |
| `src/app/api/public/climate/summary/route.ts` | Summary stats API |
| `src/app/public/climate/__tests__/` | Tests |
| `src/app/api/public/climate/__tests__/` | API tests |

### Modified Files (5)

| File | Change |
|------|--------|
| `src/app/public/layout.tsx` | Add LocaleProvider, language toggle, dashboard nav |
| `src/components/sidebar-nav.tsx` | Add "Público" section with target="_blank" links |
| `src/components/sidebar-shell.tsx` | Add "globe" to IconName + ICONS map |
| `src/app/climate/dashboard/climate-charts.tsx` | Add optional `labels` prop for i18n |
| `src/app/climate/dashboard/actions.ts` | Extract queries to shared `climate-queries.ts` |

## Acceptance Criteria

- [ ] `/public` shows landing page with climate dashboard card (no auth required)
- [ ] `/public/climate` shows interactive climate charts (no auth required)
- [ ] Language toggle switches all public page text between Spanish and English
- [ ] Date range filter updates charts via public API
- [ ] Charts display temperature, humidity, precipitation, solar, wind, pressure tabs
- [ ] Station info section shows metadata and EDI link placeholder
- [ ] Sidebar shows "Público" section for all authenticated users
- [ ] Sidebar "Público" links open in new tab
- [ ] Public API validates input params and returns proper errors
- [ ] Public API responses include Cache-Control headers
- [ ] Pages render correctly on mobile (320px width)
- [ ] OG meta tags present for social media sharing
- [ ] `npm run build` succeeds with no type errors
- [ ] Tests pass for shared query logic and public API routes

## Dependencies & Risks

- **EDI URL not yet available** — The EDI link section will show a placeholder until the dataset is published. No blocker.
- **Chart component coupling** — Adding `labels` prop to `ClimateCharts` touches the internal dashboard. Must verify no regressions.
- **Query extraction refactor** — Moving query logic from `actions.ts` to `climate-queries.ts` is a refactor of working code. Run existing climate tests after extraction.
- **Public layout modification** — Adding nav to the public layout affects existing camera trap share pages. Must exclude share pages from dashboard nav.

## References

- Brainstorm: `docs/brainstorms/2026-03-09-public-dashboards-brainstorm.md`
- Existing public layout: `src/app/public/layout.tsx`
- Climate chart component: `src/app/climate/dashboard/climate-charts.tsx`
- Climate data actions: `src/app/climate/dashboard/actions.ts`
- Climate schema: `src/db/schema.ts:534-605`
- Sidebar nav: `src/components/sidebar-nav.tsx`
- Proxy auth bypass: `src/proxy.ts:36-39`
- Security learnings: `docs/solutions/security-issues/phase2-code-review-12-findings.md`
- EDI Repository: https://edirepository.org/
