---
date: 2026-06-22
topic: star-installations
---

# Star (Favorite) Camera-Trap Installations — Personal Work Tracking

## What We're Building

A "star" toggle on each camera-trap installation (deployment) in the deployments
table, so an annotator can mark the installations they're working on or want to
work on next and quickly find them again. Stars are **personal** and stored in
**`localStorage`** in the user's browser — no database, no server. A star is a
simple on/off flag; finding your starred set is done by **sorting/filtering the
existing table** (a star column + a "Solo destacadas" toggle), not a new page.

This is purely a personal organization aid, **orthogonal to deployment `status`**
(`unscanned → scanned → processed → verified`), which remains the shared
pipeline-stage field. Star = "this is mine / do next"; status = "where it is in
the pipeline."

## Why This Approach

The whole spec — personal, simple on/off, surfaced via the existing table — is
satisfied without any backend. The deployments table
(`src/app/camera-trap/deployments-table.tsx`) is already a Client Component that
**already persists state to `localStorage`** (collapsed project groups), so this
follows an established in-file pattern. "Per-user" is automatic because the data
lives in the user's own browser.

We deliberately did **not** reuse the existing image-level star
(`biochoco_images.starred`/`starredBy`) — that's a global last-writer flag on
images, the wrong model for private deployment tracking — and we deliberately did
**not** build a DB join table, because the only thing a DB buys here is
cross-device sync, which the user explicitly doesn't need. YAGNI wins.

**Accepted tradeoff:** stars live in one browser. They do not sync across
devices/browsers and are lost if the user clears browser data. That's acceptable
for a personal "what am I working on right now" scratchpad.

## Key Decisions

- **localStorage, browser-only.** No schema change, no `push-schema.mjs`, no
  server action, no migration, no deploy step. Frontend-only.
- **Personal & simple on/off.** No "in progress / next / done" states, no notes.
  Deployment `status` already covers pipeline stage.
- **Surface in the existing table.** A star column (clickable toggle, sortable
  starred-first via a custom `sortingFn`, with the existing stable `name`/`id`
  tiebreaker) inserted into the `ColumnDef` array (~`deployments-table.tsx:250`),
  plus a "Solo destacadas" filter toggle beside the existing status filter.
  **No new page, no sidebar link, no server round-trip.**
- **Storage shape.** A single `localStorage` key (e.g.
  `ct-starred-deployments`) holding a JSON array/set of starred deployment `id`s.
  Mirror the existing collapsed-groups persistence pattern already in this file
  (read on mount, write on toggle, guard for SSR / `window` undefined).
- **Star icon.** Reuse the lucide `Star` icon (filled vs outline) for the toggle;
  keep visual language consistent with the rest of the table.

## Open Questions (for planning)

- **Cross-tab consistency (minor):** should the table react to `storage` events so
  two open tabs stay in sync? Probably nice-to-have, not required.
- **Stale ids:** starred ids for deleted/excluded deployments simply won't match
  any row — harmless, but planning can decide whether to prune on load.
- **Default sort:** keep current default (`name` asc); starred-first is opt-in via
  the column header / filter toggle, not the default.

## Next Steps
→ `/workflows:plan` for implementation details
