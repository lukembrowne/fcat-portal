# Brainstorm: Social Activities Dashboard (Monitoreo Programático)

**Date:** 2026-02-21
**Status:** Ready for planning

## What We're Building

A dashboard page for tracking FCAT's social activities — workshops, trainings, meetings, courses — recorded via the ODK form "Actividades Sociales FCAT" (ODK project 11, form `actividades_sociales_fcat`). The dashboard helps the FCAT project manager monitor how many events are happening, how many people are being reached, and across which projects and development areas.

## Why This Approach

**Single-page dashboard with filter sidebar** — matching the proven pattern from the GIZ tree-planting and cacao-monitoring dashboards. This gives a balanced view with metrics at the top, charts in the middle, and a full activity table at the bottom. A sticky filter sidebar lets the manager slice data by date range, event type, development area, project, and location.

## ODK Form Structure

**Form:** `actividades_sociales_fcat` (Project 11, version 1.1.2)
**Current submissions:** 3 (new form, just launched)

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `fecha` | date | Event date |
| `tipo_evento` | select1 | Event type: Reunión socialización, Taller, Curso, Capacitación, Reunión, Otro |
| `area_desarrollo` | multi-select | Development area: Arte, Agroforestería, Agricultura, Conservación, Restauración, Social, Ecología, Salud, Seguridad, Salud ocupacional, Monitoreo biodiversidad, Retiro FCAT, Otro |
| `tema_evento` | text | Event topic/theme |
| `institucion_organizadora` | text | Organizing institution |
| `nombre_capacitadores` | text | Trainer/facilitator names |
| `lugar_evento` | select1 | Location: Estación FCAT, Comunidad, Laguna de Cube, Oficina REMACH, Otro |
| `tipo_participantes` | multi-select | Participant types: Jóvenes/niños, Mujeres, Agricultores, FCATeros, Público local, Investigadores extranjeros, Otros |
| `comunidades_instituciones` | text | Communities/institutions involved |
| `num_mujeres` | int | Number of women |
| `num_hombres` | int | Number of men |
| `num_ninos` | int | Number of children |
| `num_adolescentes` | int | Number of adolescents |
| `total_participantes` | calculated | Total participants |
| `proyecto_fcat` | multi-select | FCAT project: Club de jóvenes, Grupo arte mujeres, Agroforestería GIZ, Restauración, Monitoreo biodiversidad, Infraestructura estación, Cursos de campo, Visitas, Evento REMACH-MAE, Otros |
| `foto_lista_participantes` | binary | Photo of participant sign-in list |
| `foto_registro_2` | binary | Second registration photo |
| `foto_evento_1..4` | binary | Up to 4 event photos |
| `nombre_encuestador` | text | Surveyor name |

### Select Value → Label Mappings

**tipo_evento:**
- `reunion_socializacion` → Reunión socialización de proyecto
- `taller` → Taller
- `curso` → Curso
- `capacitacion` → Capacitación
- `reunion` → Reunión
- `otro` → Otro

**area_desarrollo:**
- `arte` → Arte, `agroforesteria` → Agroforestería, `agricultura` → Agricultura, `conservacion` → Conservación, `restauracion` → Restauración, `social` → Social, `ecologia` → Ecología, `salud` → Salud, `seguridad` → Seguridad, `salud_ocupacional` → Salud ocupacional, `monitoreo_biodiversidad` → Monitoreo biodiversidad, `retiro_fcat` → Retiro FCAT, `otro` → Otro

**lugar_evento:**
- `estacion_fcat` → Estación FCAT, `comunidad` → Comunidad, `laguna_cube` → Laguna de Cube, `oficina_remach` → Oficina REMACH, `otro` → Otro

**tipo_participantes:**
- `jovenes_ninos` → Jóvenes y niños, `mujeres` → Mujeres, `agricultores` → Agricultores locales, `fcateros` → FCATeros, `publico_local` → Público local, `investigadores_extranjeros` → Investigadores y estudiantes extranjeros, `otros` → Otros

**proyecto_fcat:**
- `club_jovenes` → Club de jóvenes, `grupo_arte_mujeres` → Grupo de arte mujeres, `agroforesteria_cacao_giz` → Agroforestería (Cacao-GIZ), `restauracion` → Restauración, `monitoreo_biodiversidad` → Monitoreo biodiversidad, `infraestructura_estacion` → Infraestructura y mantenimiento estación, `cursos_campo` → Cursos de campo estudiantes, `visitas` → Visitas, `evento_remach_mae` → Evento REMACH-MAE, `otros` → Otros

## Key Decisions

### Navigation & Permissions
- **New top-level sidebar group** "Monitoreo Programático" with its own icon (e.g., `clipboard-list` or `users`)
- **New project** `monitoreo` in the permissions system (add to `coreProjects` in `push-schema.mjs`)
- Route: `/monitoreo/social-activities` (English route, Spanish UI)

### Dashboard Layout (Single Page)
Follows the GIZ dashboard pattern: Server Page → Server Action → Client DashboardShell

**Filter Sidebar (sticky left):**
- Date range (from/to date pickers)
- Event type (`tipo_evento`) checkboxes
- Development area (`area_desarrollo`) checkboxes
- FCAT project (`proyecto_fcat`) checkboxes
- Location (`lugar_evento`) checkboxes

**Metrics Row (4-5 KPI cards):**
1. Total de Eventos (count)
2. Total de Participantes (sum)
3. Mujeres (% and count)
4. Comunidades Alcanzadas (unique `comunidades_instituciones` count)
5. Promedio por Evento (avg participants per event)

**Charts Section:**
1. Eventos por Mes — bar chart showing event count over time
2. Participantes por Tipo de Evento — bar chart (talleres vs reuniones vs cursos, etc.)
3. Áreas de Desarrollo — horizontal bar chart showing which areas are most active
4. Desglose Demográfico — stacked bar or donut showing mujeres/hombres/niños/adolescentes
5. Proyectos FCAT — bar chart showing activities per FCAT project

**Activity Table:**
- Columns: Fecha, Tema, Tipo, Área(s), Lugar, Participantes (total), M/H breakdown, Proyecto(s), Fotos
- Sortable, searchable, paginated
- CSV export
- Photo icon in last column opens photo viewer modal

**Photo Viewer:**
- Modal showing participant list photo(s) and up to 4 event photos
- Reuse the existing photo proxy pattern with ODK project 11 allowlisted

### Empty State
Since the form is new (only 3 submissions), the dashboard should handle empty/sparse data gracefully:
- Show "No hay actividades registradas" when no submissions exist
- Charts should handle zero data without breaking

## Open Questions

- Should we support multiple forms under "Monitoreo Programático" in the future? (e.g., other monitoring forms in project 11). For now, just the one page.
- What icon works best for the sidebar group? Options: `clipboard-list`, `users`, `heart-handshake`, `megaphone`

## Technical Notes

- ODK Project ID: `11`
- Form ID: `actividades_sociales_fcat`
- Multi-select fields return space-separated values (e.g., `"publico_local otros"`)
- The `total_participantes` field is a string (calculated in ODK), need to parse to int
- Nested group `grupo_num_participantes` needs flattening (use `flatten: true` option)
- Photos: add project 11 and form `actividades_sociales_fcat` to the photo proxy allowlist
- No GPS data in this form — no map component needed
