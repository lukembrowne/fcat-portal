# Camera Trap Workflow UX Improvement

**Date:** 2026-03-02
**Status:** Brainstorm complete — ready for planning

## What We're Building

A redesigned camera trap deployments table that replaces the current "click row → expand → find action" workflow with context-aware inline actions. Each deployment row shows a smart primary action button based on its current state, plus an overflow menu for secondary actions. The scan step becomes invisible — auto-triggered when the user clicks "Procesar" on an unscanned deployment.

### Core Changes

1. **Smart primary action button per row** — Shows the logical next step based on deployment state:
   - `Sin escanear` → "Procesar" (auto-scans first, then opens processing config)
   - `Escaneada` / `Lista para procesar` → "Procesar"
   - `Procesando...` → Progress indicator (non-interactive)
   - `Procesada` → "Ver Resultados"
   - `Error` → "Reintentar"

2. **Status badges become action-oriented** — Replace dry status labels with forward-looking chips:
   - "Sin escanear" → "Nueva" or "Lista para procesar"
   - "Escaneada" → "Lista para procesar"
   - "Procesada" → "Completada" with count summary

3. **Overflow menu (`···`)** for secondary actions:
   - Buscar Imágenes (manual scan)
   - Comprimir / Deshacer Compresión
   - Vincular ODK
   - Editar Metadatos
   - Eliminar

4. **Auto-scan on process** — Clicking "Procesar" on an unscanned deployment triggers scan automatically, then transitions to processing setup. No separate scan step in the normal workflow.

## Why This Approach

**User pain points addressed:**
- **Discoverability**: Primary actions are visible without expanding a row
- **Workflow confusion**: Users don't need to know about scanning as a separate step
- **Action density**: 2-3 key actions visible per row without overwhelming the UI
- **Status clarity**: Badges tell you what to do next, not just what happened

**Rejected alternatives:**
- **Kanban/pipeline view**: More visual but doesn't scale well for 50+ deployments and loses the data-density advantage of a table. Better for small teams with few active deployments.
- **Wizard/guided workflow**: Too rigid for experienced users who want to jump between steps. Good for onboarding but adds friction for daily use.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scan step visibility | Auto-scan on process, manual scan in overflow | Users shouldn't need to think about scanning |
| Action surfacing | Inline primary button + overflow menu | Balances discoverability with clean UI |
| Status labels | Action-oriented ("Lista para procesar") | Tells users what to do next, not just current state |
| Action density | 2-3 visible per row | Enough to be useful without cluttering the table |
| Expanded row | Keep for metadata/details, remove actions from it | Actions move to row-level, details stay in expanded view |

## Open Questions

1. **Should the expanded row still exist?** Could show metadata, ODK match details, and processing history — but actions would live at the row level now.
2. **Batch operations** — Should there be checkboxes for bulk "Procesar" or "Comprimir"? Currently ODK match has a "match all" button but individual processing doesn't have batch mode.
3. **Auto-scan failure handling** — If auto-scan fails before processing, show an error toast and offer manual retry? Or fall back to showing the scan button?
4. **Mobile/narrow viewport** — How do the inline actions collapse on smaller screens? Overflow menu only?

## Visual Sketch

```
┌─────────────────────────────────────────────────────────────────────┐
│ Nombre          │ Sitio    │ Imgs │ Estado              │ Acciones │
├─────────────────┼──────────┼──────┼─────────────────────┼──────────┤
│ GIZ-014_V1      │ Sitio A  │ 342  │ 🟢 Completada       │ [Ver] ···│
│ REF-002_V1      │ —        │ 156  │ 🔵 Lista p/procesar │ [Proc] ··│
│ BIO-007_V1      │ Sitio C  │ —    │ ⚪ Nueva            │ [Proc] ··│
│ CHO-001_V1      │ Sitio D  │ 891  │ 🟡 Procesando 45%  │ ░░░▓▓   │
│ REF-005_V1      │ Sitio E  │ 200  │ 🔴 Error            │ [Retry]··│
└─────────────────┴──────────┴──────┴─────────────────────┴──────────┘

··· overflow menu:
┌──────────────────────┐
│ Buscar Imágenes      │
│ Comprimir            │
│ Vincular ODK         │
│ Editar Metadatos     │
│ ──────────────────── │
│ Eliminar             │
└──────────────────────┘
```

## Next Steps

Run `/workflows:plan` to create an implementation plan covering:
- Table column restructuring
- Smart action button component
- Auto-scan-before-process logic
- Overflow menu with conditional items
- Status badge redesign
