---
title: Social Activities Dashboard (Monitoreo Programático)
type: feat
date: 2026-02-21
brainstorm: docs/brainstorms/2026-02-21-social-activities-dashboard-brainstorm.md
---

# feat: Social Activities Dashboard (Monitoreo Programático)

## Overview

Build a dashboard at `/monitoreo/social-activities` for FCAT project managers to track social activities (workshops, trainings, meetings, courses) recorded via the ODK form "Actividades Sociales FCAT" (ODK project 11). Single-page layout with filter bar, KPI metrics, charts, activity table with photo viewer, and CSV export. Follows the established GIZ tree-planting dashboard pattern.

## Problem Statement / Motivation

FCAT staff record social activities via ODK Collect but have no way to visualize or analyze this data. The project manager needs to answer questions like: "How many workshops have we done this quarter?", "How many people have we reached?", "Which development areas are most active?", and "What's the gender breakdown of participants?". Currently this requires manually downloading ODK data and analyzing in a spreadsheet.

## Proposed Solution

A new "Monitoreo Programático" section in the portal sidebar, starting with a single "Actividades Sociales" dashboard page. The dashboard follows the proven GIZ pattern:

1. Server page with permission check → server action fetches from ODK → client shell renders filters, metrics, charts, and table
2. New `monitoreo` project in the permissions system for independent access control
3. Photo viewer modal for participant lists and event photos via the existing photo proxy

## Technical Approach

### ODK Form Structure (verified from raw API)

The form `actividades_sociales_fcat` in ODK project 11 has:
- **Top-level fields:** `fecha`, `tipo_evento`, `area_desarrollo`, `tema_evento`, `institucion_organizadora`, `nombre_capacitadores`, `lugar_evento`, `tipo_participantes`, `comunidades_instituciones`, `proyecto_fcat`, `nombre_encuestador`, `foto_lista_participantes`, `foto_registro_2`, `pdf_registro_participantes`
- **Nested group `grupo_num_participantes`:** `num_mujeres`, `num_hombres`, `num_ninos`, `num_adolescentes`, `num_otros_participantes`, `total_participantes`
- **Nested group `grupo_fotos_evento`:** `foto_evento_1`, `foto_evento_2`, `foto_evento_3`, `foto_evento_4`

When fetched with `{ flatten: true }`, nested fields become:
- `grupo_num_participantes_num_mujeres`, `grupo_num_participantes_num_hombres`, etc.
- `grupo_fotos_evento_foto_evento_1`, `grupo_fotos_evento_foto_evento_2`, etc.

Multi-select fields (`area_desarrollo`, `tipo_participantes`, `proyecto_fcat`) return space-separated values (e.g., `"publico_local otros"`).

### Implementation Phases

#### Phase 1: Infrastructure (constants, types, permissions, photo proxy)

**1.1 Add ODK constants** — `src/lib/odk-constants.ts`

```typescript
// Monitoreo Programático Project
export const MONITOREO_PROJECT_ID = "11";
export const MONITOREO_FORM_SOCIAL_ACTIVITIES = "actividades_sociales_fcat";
```

**1.2 Add type definitions** — `src/lib/odk-types.ts`

```typescript
// Raw ODK submission (flattened)
export interface OdkSocialActivitySubmission {
  __id: string;
  fecha: string | null;
  tipo_evento: string | null;
  area_desarrollo: string | null;           // space-separated multi-select
  tema_evento: string | null;
  institucion_organizadora: string | null;
  nombre_capacitadores: string | null;
  lugar_evento: string | null;
  tipo_participantes: string | null;         // space-separated multi-select
  comunidades_instituciones: string | null;
  grupo_num_participantes_num_mujeres: number | null;
  grupo_num_participantes_num_hombres: number | null;
  grupo_num_participantes_num_ninos: number | null;
  grupo_num_participantes_num_adolescentes: number | null;
  grupo_num_participantes_num_otros_participantes: number | null;
  grupo_num_participantes_total_participantes: string | null;  // string in ODK
  foto_lista_participantes: string | null;
  foto_registro_2: string | null;
  pdf_registro_participantes: string | null;
  grupo_fotos_evento_foto_evento_1: string | null;
  grupo_fotos_evento_foto_evento_2: string | null;
  grupo_fotos_evento_foto_evento_3: string | null;
  grupo_fotos_evento_foto_evento_4: string | null;
  proyecto_fcat: string | null;              // space-separated multi-select
  nombre_encuestador: string | null;
}

// Cleaned record for UI
export interface SocialActivityRecord {
  id: string;
  fecha: string | null;
  tipoEvento: string;
  tipoEventoLabel: string;
  areasDesarrollo: string[];                 // parsed multi-select
  areasDesarrolloLabels: string[];
  temaEvento: string;
  institucionOrganizadora: string;
  nombreCapacitadores: string;
  lugarEvento: string;
  lugarEventoLabel: string;
  tipoParticipantes: string[];               // parsed multi-select
  tipoParticipantesLabels: string[];
  comunidadesInstituciones: string;
  numMujeres: number;
  numHombres: number;
  numNinos: number;
  numAdolescentes: number;
  numOtros: number;
  totalParticipantes: number;
  proyectosFcat: string[];                   // parsed multi-select
  proyectosFcatLabels: string[];
  nombreEncuestador: string;
  // Photos
  fotoListaParticipantes: string | null;
  fotoRegistro2: string | null;
  fotoEvento1: string | null;
  fotoEvento2: string | null;
  fotoEvento3: string | null;
  fotoEvento4: string | null;
  hasPhotos: boolean;
}

// Dashboard metrics
export interface SocialActivityMetrics {
  totalEventos: number;
  totalParticipantes: number;
  totalMujeres: number;
  porcentajeMujeres: number;
  comunidadesAlcanzadas: number;
  promedioParticipantes: number;
}

// Filter state
export interface SocialActivityFilterState {
  dateFrom: string;
  dateTo: string;
  tipoEvento: string[];      // multi-check
  areaDesarrollo: string[];   // multi-check
  proyectoFcat: string[];     // multi-check
  lugarEvento: string[];      // multi-check
}
```

**1.3 Add `monitoreo` to core projects** — `scripts/push-schema.mjs`

Add to `coreProjects` array:
```javascript
["monitoreo", "Monitoreo Programático", "Seguimiento de actividades sociales y programáticas de FCAT"],
```

**1.4 Update photo proxy allowlist** — `src/app/api/odk/photos/route.ts`

- Add `[MONITOREO_PROJECT_ID]: "monitoreo"` to `ODK_PROJECT_MAP`
- Add `MONITOREO_FORM_SOCIAL_ACTIVITIES` to `ALLOWED_FORMS`

**1.5 Add sidebar icon** — `src/components/sidebar-nav.tsx` + `sidebar-shell.tsx`

- Add `"clipboard-list"` to the `IconName` type union
- Add `"clipboard-list": ClipboardList` to the `ICONS` map in `sidebar-shell.tsx`
- Import `ClipboardList` from `lucide-react`

#### Phase 2: Server-Side Data Fetching

**2.1 Create server action** — `src/app/monitoreo/social-activities/actions.ts`

```typescript
"use server";

import { requirePermission } from "@/lib/auth";
import { fetchSubmissions } from "@/lib/odk-client";
import { MONITOREO_PROJECT_ID, MONITOREO_FORM_SOCIAL_ACTIVITIES } from "@/lib/odk-constants";
import type { ActionResult } from "@/lib/types";
import type { OdkSocialActivitySubmission, SocialActivityRecord, SocialActivityMetrics } from "@/lib/odk-types";

// Value→Label mappings for select fields
const TIPO_EVENTO_LABELS: Record<string, string> = {
  reunion_socializacion: "Reunión socialización",
  taller: "Taller",
  curso: "Curso",
  capacitacion: "Capacitación",
  reunion: "Reunión",
  otro: "Otro",
};

const AREA_DESARROLLO_LABELS: Record<string, string> = {
  arte: "Arte",
  agroforesteria: "Agroforestería",
  agricultura: "Agricultura",
  conservacion: "Conservación",
  restauracion: "Restauración",
  social: "Social",
  ecologia: "Ecología",
  salud: "Salud",
  seguridad: "Seguridad",
  salud_ocupacional: "Salud ocupacional",
  monitoreo_biodiversidad: "Monitoreo biodiversidad",
  retiro_fcat: "Retiro FCAT",
  otro: "Otro",
};

const LUGAR_EVENTO_LABELS: Record<string, string> = {
  estacion_fcat: "Estación FCAT",
  comunidad: "Comunidad",
  laguna_cube: "Laguna de Cube",
  oficina_remach: "Oficina REMACH",
  otro: "Otro",
};

const TIPO_PARTICIPANTES_LABELS: Record<string, string> = {
  jovenes_ninos: "Jóvenes y niños",
  mujeres: "Mujeres",
  agricultores: "Agricultores locales",
  fcateros: "FCATeros",
  publico_local: "Público local",
  investigadores_extranjeros: "Investigadores extranjeros",
  otros: "Otros",
};

const PROYECTO_FCAT_LABELS: Record<string, string> = {
  club_jovenes: "Club de jóvenes",
  grupo_arte_mujeres: "Grupo arte mujeres",
  agroforesteria_cacao_giz: "Agroforestería (Cacao-GIZ)",
  restauracion: "Restauración",
  monitoreo_biodiversidad: "Monitoreo biodiversidad",
  infraestructura_estacion: "Infraestructura estación",
  cursos_campo: "Cursos de campo",
  visitas: "Visitas",
  evento_remach_mae: "Evento REMACH-MAE",
  otros: "Otros",
};

// Parse space-separated multi-select and map to labels
function parseMultiSelect(value: string | null, labelMap: Record<string, string>): { values: string[]; labels: string[] } {
  if (!value) return { values: [], labels: [] };
  const values = value.split(/\s+/).filter(Boolean);
  const labels = values.map(v => labelMap[v] ?? v);
  return { values, labels };
}

// Safe number parsing with fallback to 0
function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function transformSubmissions(raw: OdkSocialActivitySubmission[]): SocialActivityRecord[] {
  return raw.map((s) => {
    const areas = parseMultiSelect(s.area_desarrollo, AREA_DESARROLLO_LABELS);
    const participantTypes = parseMultiSelect(s.tipo_participantes, TIPO_PARTICIPANTES_LABELS);
    const projects = parseMultiSelect(s.proyecto_fcat, PROYECTO_FCAT_LABELS);

    const numMujeres = toNum(s.grupo_num_participantes_num_mujeres);
    const numHombres = toNum(s.grupo_num_participantes_num_hombres);
    const numNinos = toNum(s.grupo_num_participantes_num_ninos);
    const numAdolescentes = toNum(s.grupo_num_participantes_num_adolescentes);
    const numOtros = toNum(s.grupo_num_participantes_num_otros_participantes);

    // Parse total_participantes (string from ODK), fall back to sum of demographics
    const parsedTotal = parseInt(s.grupo_num_participantes_total_participantes ?? "", 10);
    const totalParticipantes = Number.isNaN(parsedTotal)
      ? numMujeres + numHombres + numNinos + numAdolescentes + numOtros
      : parsedTotal;

    const tipoEvento = s.tipo_evento ?? "";

    return {
      id: s.__id,
      fecha: s.fecha ?? null,
      tipoEvento,
      tipoEventoLabel: TIPO_EVENTO_LABELS[tipoEvento] ?? tipoEvento,
      areasDesarrollo: areas.values,
      areasDesarrolloLabels: areas.labels,
      temaEvento: s.tema_evento?.trim() ?? "",
      institucionOrganizadora: s.institucion_organizadora?.trim() ?? "",
      nombreCapacitadores: s.nombre_capacitadores?.trim() ?? "",
      lugarEvento: s.lugar_evento ?? "",
      lugarEventoLabel: LUGAR_EVENTO_LABELS[s.lugar_evento ?? ""] ?? (s.lugar_evento ?? ""),
      tipoParticipantes: participantTypes.values,
      tipoParticipantesLabels: participantTypes.labels,
      comunidadesInstituciones: s.comunidades_instituciones?.trim() ?? "",
      numMujeres,
      numHombres,
      numNinos,
      numAdolescentes,
      numOtros,
      totalParticipantes,
      proyectosFcat: projects.values,
      proyectosFcatLabels: projects.labels,
      nombreEncuestador: s.nombre_encuestador?.trim() ?? "",
      fotoListaParticipantes: s.foto_lista_participantes ?? null,
      fotoRegistro2: s.foto_registro_2 ?? null,
      fotoEvento1: s.grupo_fotos_evento_foto_evento_1 ?? null,
      fotoEvento2: s.grupo_fotos_evento_foto_evento_2 ?? null,
      fotoEvento3: s.grupo_fotos_evento_foto_evento_3 ?? null,
      fotoEvento4: s.grupo_fotos_evento_foto_evento_4 ?? null,
      hasPhotos: !!(
        s.foto_lista_participantes ||
        s.foto_registro_2 ||
        s.grupo_fotos_evento_foto_evento_1 ||
        s.grupo_fotos_evento_foto_evento_2 ||
        s.grupo_fotos_evento_foto_evento_3 ||
        s.grupo_fotos_evento_foto_evento_4
      ),
    };
  });
}

export async function fetchSocialActivities(): Promise<
  ActionResult<{ activities: SocialActivityRecord[]; metrics: SocialActivityMetrics }>
> {
  try {
    await requirePermission("monitoreo", "viewer");
    const raw = await fetchSubmissions<OdkSocialActivitySubmission>(
      MONITOREO_PROJECT_ID,
      MONITOREO_FORM_SOCIAL_ACTIVITIES,
      { flatten: true }
    );
    const activities = transformSubmissions(raw);

    // Compute metrics
    const totalParticipantes = activities.reduce((sum, a) => sum + a.totalParticipantes, 0);
    const totalMujeres = activities.reduce((sum, a) => sum + a.numMujeres, 0);
    const uniqueCommunities = new Set(
      activities.map(a => a.comunidadesInstituciones.toLowerCase().trim()).filter(Boolean)
    );

    const metrics: SocialActivityMetrics = {
      totalEventos: activities.length,
      totalParticipantes,
      totalMujeres,
      porcentajeMujeres: totalParticipantes > 0 ? Math.round((totalMujeres / totalParticipantes) * 100) : 0,
      comunidadesAlcanzadas: uniqueCommunities.size,
      promedioParticipantes: activities.length > 0 ? Math.round(totalParticipantes / activities.length) : 0,
    };

    return { success: true, data: { activities, metrics } };
  } catch (err) {
    console.error("Failed to fetch social activities:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
```

**2.2 Create server page** — `src/app/monitoreo/social-activities/page.tsx`

```typescript
import { requirePermission } from "@/lib/auth";
import { fetchSocialActivities } from "./actions";
import { DashboardShell } from "./dashboard-shell";

export default async function SocialActivitiesPage() {
  await requirePermission("monitoreo", "viewer");
  const result = await fetchSocialActivities();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Actividades Sociales</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar datos de ODK Central
          </p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <DashboardShell activities={result.data.activities} />;
}
```

**2.3 Create layout** — `src/app/monitoreo/layout.tsx`

Passthrough layout (children only), following GIZ pattern.

**2.4 Create redirect** — `src/app/monitoreo/page.tsx`

Redirect `/monitoreo` → `/monitoreo/social-activities`.

#### Phase 3: Client Dashboard UI

**3.1 Dashboard Shell** — `src/app/monitoreo/social-activities/dashboard-shell.tsx`

Client component with:
- `useState<SocialActivityFilterState>` for filter state
- `useMemo` for filtered activities based on all filter dimensions (AND logic between dimensions, OR/inclusive within multi-select dimensions)
- `useMemo` for re-computed metrics on filtered data
- Layout: Filter bar → Metrics row → Charts → Table
- Sections separated by `<Separator />`

Multi-select filter logic (inclusive/OR matching):
```typescript
// For multi-select fields: show activity if ANY of its values match ANY checked filter values
if (filters.areaDesarrollo.length > 0) {
  const hasMatch = activity.areasDesarrollo.some(a => filters.areaDesarrollo.includes(a));
  if (!hasMatch) return false;
}
```

**3.2 Filter Bar** — `src/app/monitoreo/social-activities/filter-bar.tsx`

Horizontal filter bar (not sidebar, following cacao pattern):
- Date range: from/to native date inputs
- Event type: multi-select checkboxes (via Popover or Select with multi)
- Development area: multi-select checkboxes
- FCAT project: multi-select checkboxes
- Location: multi-select checkboxes
- "Limpiar" reset button
- Record count: "Mostrando X de Y actividades"

Unique values derived from `records` via `useMemo`.

**3.3 Metrics Row** — `src/app/monitoreo/social-activities/metrics-row.tsx`

5 KPI cards in a responsive grid:

| Card | Icon | Value | Notes |
|------|------|-------|-------|
| Total de Eventos | `CalendarDays` | count | Blue |
| Total de Participantes | `Users` | sum | Emerald |
| Mujeres | `UserRound` | count (X%) | Purple |
| Comunidades Alcanzadas | `Building2` | unique count | Amber |
| Promedio por Evento | `TrendingUp` | avg | Rose |

**3.4 Charts** — `src/app/monitoreo/social-activities/activity-charts.tsx`

Recharts with Tabs:

| Tab | Chart Type | Data |
|-----|-----------|------|
| Eventos por Mes | BarChart (vertical) | Count of activities grouped by YYYY-MM |
| Por Tipo de Evento | BarChart (horizontal) | Count by tipo_evento label |
| Áreas de Desarrollo | BarChart (horizontal) | Count by each area (exploded from multi-select) |
| Desglose Demográfico | BarChart (stacked) | Sum of mujeres/hombres/niños/adolescentes |
| Por Proyecto FCAT | BarChart (horizontal) | Count by each proyecto (exploded from multi-select) |

Use `var(--chart-1)` through `var(--chart-5)` CSS variables. Handle empty data with "Sin datos" message. Dynamic height for horizontal charts: `Math.max(250, items.length * 32)`.

**3.5 Activity Table** — `src/app/monitoreo/social-activities/activity-table.tsx`

TanStack React Table with:

| Column | Field | Notes |
|--------|-------|-------|
| Fecha | `fecha` | Sortable, formatted date |
| Tema | `temaEvento` | Searchable, truncated with title tooltip |
| Tipo | `tipoEventoLabel` | Sortable |
| Área(s) | `areasDesarrolloLabels` | Comma-joined badges or text |
| Lugar | `lugarEventoLabel` | Sortable |
| Participantes | `totalParticipantes` | Sortable, right-aligned |
| M/H | `numMujeres`/`numHombres` | Format: "5M / 3H" |
| Proyecto(s) | `proyectosFcatLabels` | Comma-joined, truncated |
| Fotos | `hasPhotos` | Camera icon button, opens photo viewer |

Features:
- Global search input
- Column sorting
- Pagination (page size 50)
- CSV export button (Spanish headers, human-readable multi-select labels, filtered dataset)
- CSV includes BOM marker for Excel compatibility

**3.6 Photo Viewer** — `src/app/monitoreo/social-activities/photo-viewer.tsx`

Dialog modal showing up to 6 photos:
- Section 1: "Registro de Participantes" — `fotoListaParticipantes`, `fotoRegistro2`
- Section 2: "Fotos del Evento" — `fotoEvento1` through `fotoEvento4`
- Each photo: `<img>` with error state, download button via `PhotoDownloadButton`
- Photo URL: `/api/odk/photos?projectId=11&formId=actividades_sociales_fcat&id={instanceId}&file={filename}`
- Empty slots show "Sin foto" placeholder

**3.7 Loading Skeleton** — `src/app/monitoreo/social-activities/loading.tsx`

Skeleton layout matching the dashboard structure: title → filter bar → 5 metric cards → chart area → table area.

#### Phase 4: Navigation Integration

**4.1 Add sidebar entry** — `src/components/sidebar-nav.tsx`

```typescript
// In the projectItems section, after BioChocó
const hasMonitoreo = hasProjectAccess(user, "monitoreo");
if (hasMonitoreo) {
  projectItems.push({
    label: "Monitoreo Programático",
    icon: "clipboard-list",
    children: [
      { label: "Actividades Sociales", href: "/monitoreo/social-activities" },
    ],
  });
}
```

Place under "Proyectos" section, after existing project groups.

## Acceptance Criteria

### Functional Requirements
- [x] Dashboard loads and displays all submissions from ODK form `actividades_sociales_fcat`
- [x] Metrics row shows: total events, total participants, women count/%, communities reached, avg per event
- [x] All 5 chart tabs render correctly with filtered data
- [x] Filter bar filters by date range, event type, development area, FCAT project, location
- [x] Multi-select filters use inclusive (OR) matching within each dimension, AND between dimensions
- [x] Activity table is sortable, searchable, and paginated
- [x] CSV export downloads the filtered dataset with Spanish headers and human-readable labels
- [x] Photo viewer modal shows participant list and event photos from ODK
- [x] Empty state renders gracefully when no submissions exist
- [x] Error state renders when ODK Central is unreachable

### Security Requirements
- [x] Page calls `requirePermission("monitoreo", "viewer")`
- [x] Server action calls `requirePermission("monitoreo", "viewer")`
- [x] Photo proxy allowlists project 11 and form `actividades_sociales_fcat`
- [x] Photo proxy maps ODK project 11 → internal project `monitoreo` for permission checks

### Quality Gates
- [x] All UI strings in Spanish
- [x] Routes in English (`/monitoreo/social-activities`)
- [x] Types use `ActionResult<T>` discriminated union
- [x] No `as string` casts on nullable fields
- [x] `toNum()` helper used for all numeric field parsing (never raw `parseInt` without NaN guard)
- [x] Loading skeleton matches dashboard layout
- [x] Dashboard tested with sidebar open (narrowest content width) — no horizontal overflow

## File Checklist

### New Files (12)
- [x] `src/app/monitoreo/layout.tsx` — passthrough layout
- [x] `src/app/monitoreo/page.tsx` — redirect to social-activities
- [x] `src/app/monitoreo/social-activities/page.tsx` — server page
- [x] `src/app/monitoreo/social-activities/actions.ts` — server action with data fetching
- [x] `src/app/monitoreo/social-activities/labels.ts` — value→label mappings (extracted from actions.ts for "use server" compatibility)
- [x] `src/app/monitoreo/social-activities/dashboard-shell.tsx` — client shell with filters/state
- [x] `src/app/monitoreo/social-activities/filter-bar.tsx` — filter bar component
- [x] `src/app/monitoreo/social-activities/metrics-row.tsx` — KPI cards
- [x] `src/app/monitoreo/social-activities/activity-charts.tsx` — Recharts visualizations
- [x] `src/app/monitoreo/social-activities/activity-table.tsx` — TanStack table + CSV
- [x] `src/app/monitoreo/social-activities/photo-viewer.tsx` — photo modal
- [x] `src/app/monitoreo/social-activities/loading.tsx` — skeleton loading

### Modified Files (6)
- [x] `src/lib/odk-constants.ts` — add MONITOREO_PROJECT_ID, MONITOREO_FORM_SOCIAL_ACTIVITIES
- [x] `src/lib/odk-types.ts` — add OdkSocialActivitySubmission, SocialActivityRecord, SocialActivityMetrics, SocialActivityFilterState
- [x] `src/components/sidebar-nav.tsx` — add Monitoreo Programático nav group
- [x] `src/components/sidebar-shell.tsx` — add clipboard-list icon to ICONS map
- [x] `src/app/api/odk/photos/route.ts` — add project 11 to allowlist
- [x] `scripts/push-schema.mjs` — add "monitoreo" to coreProjects

## Dependencies & Risks

- **ODK Central availability:** Dashboard fails gracefully with error card if ODK is down
- **Form structure changes:** If the ODK form is restructured (fields move between groups), flattened field names will change. Use the nullish coalescing chain pattern for critical fields.
- **Low data volume:** With only 3 submissions, charts will look sparse initially. This is expected and acceptable — the dashboard is being built to scale with the form as it's adopted.
- **Performance:** All data is fetched client-side. At <500 submissions this is fine. If it grows beyond that, consider server-side pagination.

## References

- **Brainstorm:** `docs/brainstorms/2026-02-21-social-activities-dashboard-brainstorm.md`
- **Pattern template:** `src/app/giz/tree-planting/` (server page → action → dashboard shell)
- **Photo viewer pattern:** `src/app/giz/tree-planting/photo-viewer.tsx`
- **Table pattern:** `src/app/giz/tree-planting/tree-table.tsx`
- **Chart pattern:** `src/app/giz/tree-planting/tree-charts.tsx`
- **ODK client:** `src/lib/odk-client.ts`
- **Institutional learnings:** `docs/solutions/integration-issues/odk-nested-json-flattening.md`, `docs/solutions/security-issues/phase2-code-review-12-findings.md`, `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`
