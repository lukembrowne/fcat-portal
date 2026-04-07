# Camera Trap Module Redesign Brainstorm

**Date:** 2026-04-03
**Status:** Ready for planning

## What We're Building

A redesign of the camera trap module's navigation, landing page, and workflow clarity. The current interface is a flat table of 100+ deployments across multiple projects with confusing workflow stages (scan vs. process) and no visibility into sync freshness. The goal is to make it immediately obvious what needs attention and guide users through the sync → process → review workflow.

## Why This Approach

The current flat deployments table doesn't scale to 100+ deployments. Users cycle through checking new data, processing backlogs, and reviewing results in a single session — they need the interface to answer "what do I do next?" at a glance. All projects follow the same workflow, so the UI can be uniform.

## Key Decisions

### 1. Landing page: Dashboard with grouped table
- **Top section:** Summary attention cards showing counts by status (e.g., "12 por procesar", "8 por revisar") plus sync freshness indicator ("Last sync: 2h ago")
- **Main section:** Deployments table grouped by project → status (nested grouping)
  - First level: collapsible project groups (e.g., "BioChoco (45)", "Canande (32)")
  - Second level: within each project, deployments grouped by status (Por Procesar, Por Revisar, Verificadas, etc.)
  - A fully-verified project collapses to a single summary line — no noise
  - Project filter available but all are shown by default (scoped by user permissions)
- **Rejected alternatives:**
  - Project cards as landing page: adds a click for no real decision, hides deployment-level prioritization
  - Kanban board: breaks at 100+ deployments, "Done" column drowns out actionable items
  - Flat ungrouped table: doesn't scale, no way to tell what needs attention
  - Hiding completed deployments by default: creates anxiety about what's not visible

### 2. Simplified workflow stages
- **Hide scanning entirely.** Scanning (counting images in Drive) is a technical prerequisite with no user decision — it happens silently during sync or as the first phase of processing.
- **User-visible statuses:** Nueva → Por Procesar → Procesando → Por Revisar → Verificada
- Five states a human can track. No "scanned" intermediate state visible.

### 3. Drive sync: automatic + transparent
- **Nightly automatic sync** so data is rarely stale
- **Freshness indicator** in the header ("Ultima sincronizacion: hace 2h") with stale warning
- **Change summary** after sync completes ("4 nuevas instalaciones, 230 imagenes nuevas en 3 instalaciones")
- **Manual sync button** still available for on-demand refresh
- Sync duration TBD — need to measure with current deployment count

### 4. Click-through table rows (no expandable rows)
- **Remove the expandable row.** Table rows are clickable and navigate to the deployment detail page.
- Table row shows enough to decide: name, project, status badge, image count, last activity date
- The detail page is the single source of truth for metadata, processing history, and actions
- **Simplifies the mental model:** table is for scanning/deciding, detail page is for acting

### 5. Deployment detail page: status + next action
- **Top banner:** Current workflow status with one clear CTA ("Procesar" / "Revisar 52 Detecciones" / "Verificada")
- **Metadata section:** Collapsible, below the status banner (site, GPS, dates, ODK link)
- **Processing history:** Below metadata
- No competing UI between expanded row and detail page — one place for everything

## Open Questions

- How long does a full Drive sync take with 100+ deployments? This affects whether nightly auto-sync is feasible or needs to be incremental.
- Should the attention cards at the top be clickable to filter/scroll to that status group?
- What columns should be visible in the grouped table rows? Current table has many columns — grouped view may need fewer.
- Should the nightly sync also auto-process new deployments, or just discover/scan them?
- Within a status group, what's the default sort? By date added? By image count? By project?

## Future Considerations (not in scope now)

- Nightly automated ML processing of newly synced deployments
- Deployment cards view as an alternative to table rows within groups
- Cross-project batch processing from the main table
