# Plan: Edit BioChoco site entities from the portal (name, coordinates, habitat)

> Handoff plan for an implementing agent. Self-contained — includes the relevant
> file paths, code locations, and ODK API details discovered during research.

## Context / Why

A BioChoco "site" is an ODK Central **entity** in dataset `monitoring_sites_v0_14`
(project `8`). The portal is currently **read-only** against ODK entities.

To change a site's display name (e.g. `NAC-007 - Nombre Propietario` — the `site_id`
code `NAC-007` stays fixed, only the owner/location descriptor changes), staff
must edit it **by hand in two places**: ODK Central *and* the schedule Google
Sheet's `site_name` column. Tedious and drift-prone.

**Goal:** Let BioChoco **editors** edit a site's name, coordinates, and habitat
type directly from the portal. The change is written back to the ODK entity (the
source of truth) and the Sheet's name is auto-synced so it's never hand-edited
again. The editing surface **extends the existing inline schedule editor** in the
cronograma (where dates are already edited) — not a new screen.

## Facts established during research (do not re-derive)

- **The displayed name is the entity `label`.** The transform `s.label ?? s.site_name`
  makes `label` win everywhere (`src/app/biochoco/overview/actions.ts:58`,
  and the same pattern in `resultados/actions.ts`, `habitat/actions.ts`). So
  patching `label` updates every display at once. `site_id` is the immutable
  join key and must stay read-only.
- **ODK entity update API** (verified against ODK Central docs):
  - Read current version: `GET /v1/projects/8/datasets/monitoring_sites_v0_14/entities/{uuid}`
    → returns `currentVersion.version`, `currentVersion.label`, `currentVersion.data`.
  - Update: `PATCH /v1/projects/8/datasets/monitoring_sites_v0_14/entities/{uuid}?baseVersion={n}`
    with body `{ "label": "...", "data": { "latitude": "...", "longitude": "...", "habitat_type": "..." } }`.
    `baseVersion` must equal the server's current version or the request is
    rejected (optimistic concurrency). `?force=true` bypasses the check — do NOT
    use it; we want conflict detection.
  - Unspecified `data` properties are preserved by PATCH, so `site_id` is untouched.
- **⚠️ Possible derived `geometry` property — VERIFY before coding coords.** ODK entity
  datasets often carry a `geometry` property (WKT/GeoJSON point) that ODK Central uses to
  render the entity on *its own* map. If `monitoring_sites_v0_14` has one, PATCHing only flat
  `latitude`/`longitude` leaves `geometry` stale → the very ODK/portal drift this feature
  fights, reintroduced through another column. Note: **nothing in the portal reads site
  `geometry`** (grep confirms — every BioChoco reader uses flat `s.latitude`/`s.longitude`;
  `parseWktPoint` is used only by the unrelated GIZ cacao module). So the risk is ODK
  Central's map + any external consumer, not the portal UI. **Action:** the first
  `fetchEntity` GET (Step 3) returns `currentVersion.data` — inspect it. If a `geometry`
  property exists, PATCH it in sync (WKT `POINT (lng lat)` — ODK is **lon-lat** order, see
  `parseWktPoint` at `odk-client.ts:276`); if absent, no extra work. Clearing coords must
  also clear `geometry` (both-or-neither — never lat/lng cleared with a stale point left behind).
- **The bulk OData fetch strips `__system`**, so it does NOT expose the version.
  `fetchEntities` (`src/lib/odk-client.ts:164`) maps `__id → uuid`, keeps `label`,
  copies non-`__` properties. The single-entity GET is required to read the version.
  `OdkSiteEntity` (`src/lib/odk-types.ts:218`) **already declares `uuid: string`**, so
  adding `uuid: s.uuid` to the overview transform typechecks with no type change.
- **`baseVersion` alone does NOT detect "edited since the dialog opened".** Because the
  bulk fetch has no version, the naive design reads the version via `fetchEntity` *milliseconds
  before* the PATCH — so a concurrent edit landing between page-load and save is read back as
  the current version and silently overwritten; `baseVersion` only catches the microsecond
  read→PATCH window. The established fix in this file is the **page-load snapshot**:
  `commitInlineSwap` carries an `expectedHash` from page-load (`scheduleHash`,
  `actions.ts:116,155,168`) and rejects on mismatch. Mirror it — carry the site's page-load
  field values into the dialog and compare them against `fetchEntity`'s current values before
  PATCHing (see Step 3). No version is needed at load time; the value comparison is the lock.
- **`fetchEntities` currently only takes `{ revalidate?: number }`** (line 167) — it does
  NOT yet accept `tags`, and it threads `next: { revalidate: options?.revalidate ?? 300 }`
  into `odkFetch`. To support `updateTag`, the options type must gain `tags?: string[]`
  and pass it through. `fetchEntities` is **dataset-agnostic** (also reads submissions-era
  datasets), so the `"biochoco-sites"` tag must be supplied by the *callers*, never
  hardcoded inside `fetchEntities`.
- **`loadSiteHabitatMap` (`src/lib/habitat-lookup.ts:22`) is wrapped in React `cache()`** —
  that's *per-request* memoization, NOT a persistent module cache. There is nothing to
  manually "clear" and no `clearSiteHabitatCache()` is possible. Its only cross-request
  staleness comes from the underlying `fetchEntities` call (Next Data Cache, `revalidate: 300`).
  To refresh habitat immediately after an edit, that call must carry the
  `"biochoco-sites"` tag so `updateTag` invalidates it.
- **Site fields are per-site in ODK**, shared across all of that site's
  deployments/visits. Editing them from one schedule row affects the whole site —
  the UI must say so.
- **The Sheet `site_name` is display-only.** No business logic (validate/swap/
  shift/matching in `src/lib/schedule-utils.ts`) reads it — only display and
  change-record labels. Auto-syncing it from ODK is safe.
- **`deployments.siteName` (SQLite, `src/db/schema.ts`) is a separate cache**,
  populated from ODK form submissions — NOT touched by this work.
- Constants live in `src/lib/odk-constants.ts`: `BIOCHOCO_PROJECT_ID = "8"`,
  `BIOCHOCO_DATASET_SITES = "monitoring_sites_v0_14"`.
- ODK auth/transport: reuse `odkFetch` in `src/lib/odk-client.ts` (Bearer token,
  55-min cache, 401 single-retry). Do NOT hand-roll auth.

## Implementation

### 1. ODK client — add entity read + write (`src/lib/odk-client.ts`)
Reuse `odkFetch`. Add:
- `fetchEntity(projectId, datasetName, uuid)` → `GET .../entities/{uuid}` with
  `cache: "no-store"` (you need the *live* version for concurrency — the 300s-cached
  `fetchEntities` would hand back a stale `baseVersion`); return the parsed
  `{ currentVersion: { version, label, data } }`. On non-OK throw like the sibling
  helpers (`ODK entity fetch failed: ${status}`), but **attach `status` to the error**
  (`Object.assign(new Error(...), { status: res.status })`) so the action can map `404`
  (entity deleted since page-load) to its own Spanish message.
- `updateEntity(projectId, datasetName, uuid, patch: { label?: string; data?: Record<string,string> }, baseVersion: number)`
  → `PATCH .../entities/{uuid}?baseVersion={baseVersion}`, JSON body. On non-OK throw
  like the sibling helpers but **attach `status`** (same `Object.assign` trick). Do **not**
  invent a localized error string or a magic `ENTITY_VERSION_CONFLICT` sentinel here —
  `odk-client` is generic transport; the *action* owns the Spanish (see Step 3.5, mirroring
  how `commitInlineSwap` throws its Spanish conflict string inline). The numeric `status` is
  the only signal the action needs to distinguish a 409.
- Extend the `fetchEntities` options type from `{ revalidate?: number }` to
  `{ revalidate?: number; tags?: string[] }` and thread it into the existing `next` object:
  `next: { revalidate: options?.revalidate ?? 300, tags: options?.tags }`. Do **not**
  hardcode any tag inside `fetchEntities` — it serves multiple datasets. Then pass
  `{ tags: ["biochoco-sites"] }` from the **two** site-reading callers:
  - `actions.ts:24` — `fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, { tags: ["biochoco-sites"] })`
  - `habitat-lookup.ts:24` — same, so the habitat map refreshes when sites change.
  This is what makes `updateTag("biochoco-sites")` in the edit action actually reach
  both the overview sites list and the habitat map.

### 2. Carry the entity uuid into overview data
- `src/app/biochoco/overview/types.ts`: add `uuid: string` to `SiteInfo`.
- `src/app/biochoco/overview/actions.ts:56` (the `sites` transform): add
  `uuid: s.uuid`. `fetchEntities` already exposes `uuid`.
- No new fields needed for the page-load conflict baseline: `SiteInfo` already carries the
  page-load `siteName` / `lat` / `lng` / `habitatType`. The dialog passes these (the values
  shown when the editor opened) to `updateSiteEntity` as the `expected` baseline (Step 3.4).

### 3. New server action — `updateSiteEntity` (`src/app/biochoco/overview/actions.ts`)
Mirror the existing `wrapAction` / `recordEvent` / `revalidatePath` style in this
file (see `commitDateEdit`). **Return type:** `ActionResult<{ warnings: string[] }>` —
same shape `commitDateEdit` uses, so the dialog's existing `warnings` block renders it
(see Step 5). Input — include the page-load `expected` baseline for conflict detection:
```ts
{ siteId: string; uuid: string;
  name: string; latitude: string; longitude: string; habitatType: string;
  expected: { name: string; latitude: string; longitude: string; habitatType: string } }
```
Steps:
1. `await requirePermission("biochoco", "editor")`.
2. **Validate inputs (server-side, before any network call)** — the `label` is the
   display source of truth and the coords feed `parseFloat` in the transform, so bad
   input would corrupt every view:
   - `name.trim()` must be non-empty → else Spanish `"El nombre no puede estar vacío."`.
   - `latitude` / `longitude`: if non-empty, must `Number.isFinite(parseFloat(...))` and be
     in range (lat −90..90, lng −180..180) → else `"Coordenadas inválidas."`. Empty is
     allowed (clearing coords) **but must be both-or-neither** — one empty + one filled →
     `"Coordenadas inválidas."`. Clearing coords also clears `geometry` (Step 3.5).
   - `habitatType` must be `""` or a key of `HABITAT_NAMES` → else `"Hábitat inválido."`.
3. `fetchEntity(...)` using the entity **`uuid`** (the `__id`, NOT `siteId` which is
   `site_id ?? label`) → read `currentVersion.version` + current values. On the caught
   error, if `err.status === 404` → Spanish `"El sitio ya no existe. Recarga la página."`.
   **On this first GET, also inspect `currentVersion.data` for a `geometry` property** and
   decide the geometry handling per the Facts note (sync WKT, or confirm it's absent).
4. **Page-load conflict check (the real lock):** compare the live `currentVersion`
   values (`label`, `data.latitude`, `data.longitude`, `data.habitat_type`) against the
   `expected` baseline from the input. If any differs, someone edited since the dialog
   opened → throw the Spanish string inline:
   `"El sitio fue actualizado por otra persona. Recarga e intenta de nuevo."`
   `wrapAction` passes Spanish through untouched (no localizer branch needed — same as
   `commitInlineSwap`'s inline throw).
5. `updateEntity(..., { label: name, data: { latitude, longitude, habitat_type: habitatType, ...geometry? } }, currentVersion.version)`.
   - If coords changed and the dataset has `geometry`: include the rebuilt WKT (or `""` when
     clearing). Lon-lat order.
   - Catch: if `err.status === 409` (the narrow read→PATCH race the snapshot can't cover)
     throw the **same** Spanish conflict string inline. Other errors propagate to `wrapAction`.
6. **Auto-sync the Sheet name (best-effort, AFTER the ODK PATCH succeeds):** `loadSchedule()`,
   filter rows where `row.siteId === siteId`, then
   `updateScheduleRows(rows.map(r => ({ deploymentId: r.deploymentId, fields: { siteName: name } })))`.
   ODK is the source of truth and is already committed by this point, so wrap this in its
   own try/catch. **The Sheet write must REPORT, not silently swallow:**
   - If it throws → push `"Guardado en ODK, pero la hoja no se pudo actualizar."` onto
     `warnings` (do **not** fail the action).
   - ⚠️ `updateScheduleRows` writes by `headers.indexOf("site_name")` and *silently
     continues* if the column is missing (`sheets-client.ts:209`) — a no-op that looks like
     success. So **pre-check** `loadSchedule`'s headers (or have the write return a written
     count) and if no `site_name` column exists, push a warning instead of trusting it.
   The reconciler (now out of scope, see §Out of scope) is no longer the safety net — the
   warning is.
7. `recordEvent({ source: "biochoco-overview", eventType: "site_entity_edit", projectId: "biochoco", targetType: "site", targetId: siteId, actorEmail: user.email, summary: ..., details: { before, after } })`.
   NOTE: plain `eventType` string — NOT a `processing_jobs` job type, so no
   `JOB_LABELS` / coverage-guard changes are needed. (`source: "biochoco-overview"` is an
   existing `EventSource` union member — `commitDateEdit` uses it.)
8. `updateTag("biochoco-sites")` + `revalidatePath("/biochoco")`, then return
   `{ success: true, data: { warnings } }`. **No habitat cache-clear call** —
   `loadSiteHabitatMap` is `React.cache()` (per-request); tagging its `fetchEntities` call
   (Step 1) plus this `updateTag` is what refreshes the habitat map across tabs.
   `revalidatePath` alone covers the overview route's own fetches but not the
   habitat/resultados aggregations on other segments — the tag is the robust path.

No separate preview/hash round-trip — the `expected` baseline (Step 3.4) IS the optimistic
lock, and `baseVersion` (Step 3.5) backstops the read→PATCH race.

### 4. Make `site_name` Sheet-writable (`src/lib/schedule-types.ts`)
Add `"siteName"` to the `WritableScheduleField` union (currently lines 55–64).
`REVERSE_HEADER_MAP` already maps it via `HEADER_MAP` (`src/lib/sheets-client.ts:59`),
so `updateScheduleRows` will write the `site_name` column once the type permits it.
**Keep the column** — humans read the raw Sheet (linked from `/biochoco/recursos`);
it is now always derived from ODK and never hand-edited.

Before flipping it writable, quick-grep `siteName` across `schedule-utils.ts` to confirm
nothing keys business logic off it (research says it's display-only at lines 411/468 — a
writable field something silently depends on is a 2am incident).

### 5. UI — extend the inline editor dialog
- `src/app/biochoco/overview/schedule-table.tsx`: build a `Map<siteId, SiteInfo>`
  from `data.sites` (already loaded on the overview page) and pass the matched
  `site` into the dialog as a new prop.
- `src/app/biochoco/overview/inline-schedule-editor-dialog.tsx`: add a new
  `<section>` **"Editar sitio"** alongside the existing date/swap sections. Fields:
  - **Nombre** — text `Input`, prefilled with `site.siteName` (the label).
  - **Latitud / Longitud** — `Input`, prefilled from `site.lat` / `site.lng`.
  - **Hábitat** — `Select` using `HABITAT_NAMES` from `./types`.
  - Muted note: `"Estos campos pertenecen al sitio {siteId} en ODK y afectan todas sus visitas."`
  - "Guardar sitio" button → `startTransition` → `updateSiteEntity({ ...fields, expected })`
    where `expected` is the original `site` values captured when the dialog opened (the
    conflict baseline, Step 3.4). On success `router.refresh()`; **surface
    `result.data.warnings` via the dialog's existing `warnings` block**
    (`inline-schedule-editor-dialog.tsx:294`) so an "ODK saved but Sheet didn't" warning is
    visible — not dropped. On error reuse the existing `error` state block. Disable when
    nothing changed (current fields deep-equal `expected`).

## Critical files
- `src/lib/odk-client.ts` — `fetchEntity` (+`status` on error, `no-store`), `updateEntity`
  (+`status` on error), `tags` option on `fetchEntities`.
- `src/lib/odk-types.ts` — verify whether `OdkSiteEntity` should declare `geometry` (only
  if the dataset has it; see Facts geometry note).
- `src/app/biochoco/overview/actions.ts` — `updateSiteEntity` (page-load `expected` baseline,
  404/409 inline Spanish, warnings return); `uuid` in site transform.
- `src/app/biochoco/overview/types.ts` — `SiteInfo.uuid`.
- `src/lib/schedule-types.ts` — `"siteName"` in `WritableScheduleField`.
- `src/app/biochoco/overview/inline-schedule-editor-dialog.tsx` — "Editar sitio" section +
  `site` prop; reuse the `warnings` block (line 294) for the Sheet-sync warning.
- `src/app/biochoco/overview/schedule-table.tsx` — siteId→SiteInfo map; pass `site` to dialog.
- `src/lib/habitat-lookup.ts` — pass `{ tags: ["biochoco-sites"] }` to its `fetchEntities`
  call (line 24) so `updateTag` reaches the habitat map. **No manual cache-clear** — it's
  `React.cache()`, per-request.

## Verification
1. **Unit tests** (Vitest; mirror `tests/unit/lib/odk-client.test.ts`'s route-mock harness
   `setupFetchMock`). Beyond the URL-shape happy path, the high-value tests that catch the
   real bugs:
   - `updateEntity` builds the correct PATCH URL with `?baseVersion=` **and the body is
     `{ label, data: { latitude, longitude, habitat_type, [geometry] } }`** (assert the body,
     not just the URL — a URL-only test is theater).
   - `fetchEntity` parses `currentVersion`; a non-OK GET throws an error carrying `.status`;
     a `404` GET → the action returns the "ya no existe" Spanish message.
   - The action's **page-load conflict path**: when live values differ from `expected`,
     no PATCH is sent and the Spanish conflict message is returned. Also the **409 path**:
     `updateEntity` rejects with `.status === 409` → same Spanish message.
   - **Best-effort Sheet failure still succeeds**: mock `updateEntity` OK + `updateScheduleRows`
     rejecting → action returns `success: true` with a populated `warnings` (encodes the
     deliberate ODK-first tradeoff — the highest-value test).
   - **Validation blocks the network**: blank name / out-of-range coords / one-empty-coord →
     `fetchEntity` and `updateEntity` are never called.
   - `updateScheduleRows` accepts `siteName` (type-level). Run `npm run test:run`.
2. **Manual against ODK staging** (via Docker per project convention — see CLAUDE.md):
   First confirm the schedule Sheet actually has a `site_name` column header (else the
   auto-sync warns instead of silently no-opping), and inspect the first `fetchEntity`
   response for a `geometry` property (drives the geometry decision, Facts note). Then on
   `/biochoco/overview`, open the editor for a row, change name + coordinates + habitat,
   save. Confirm: (a) the ODK Central entity shows the new `label`/`data` **and, if present,
   its `geometry` point moved on ODK Central's own map** (not just the portal); (b) the
   schedule table and the Sheet `site_name` column both show the new name; (c) coords/habitat
   update on the map/results **and the "Por hábitat" tab** after refresh (verifies the
   `updateTag` reached `loadSiteHabitatMap`); (d) **open the editor in two tabs, save in
   tab A, then save in tab B** → tab B surfaces the Spanish conflict message instead of
   silently overwriting (this exercises the page-load baseline, the real lock — a single-tab
   just-in-time read would NOT catch it); (e) a blank name and non-numeric coordinates are
   rejected with the Spanish validation message and **no PATCH is sent**; (f) if the Sheet
   write fails (e.g. missing column), the ODK edit still succeeds and the warning is visible
   in the dialog rather than the whole action erroring.
3. Confirm the `site_entity_edit` event appears on `/admin/activity`.
4. `npm run lint` + `npm run build` before committing.

## Out of scope / tradeoffs
- `site_id` (the code) stays immutable — renaming it would break the join key
  across ODK/Sheet/DB/share-links. Not supported here.
- `deployments.siteName` (SQLite cache from ODK submissions) left as-is; separate
  from the schedule Sheet.
- The Sheet keeps its `site_name` column (vs dropping it) so people reading the raw
  Sheet still see names; it is now auto-derived from ODK — satisfying "never
  maintain by hand."
- Editing the entity `label` only (not the `site_name` ODK property), since the
  display reads `label` first and the name format ("code - descriptor") isn't
  strictly guaranteed. If you later want the `site_name` property kept in sync too,
  add it to the PATCH `data`.
- **ODK-first, Sheet best-effort.** The ODK PATCH (source of truth) commits first; the
  Sheet `site_name` sync is a second, non-transactional write. If the Sheet write fails
  after a successful PATCH, the two can briefly drift — accepted deliberately: the action
  returns success **with a visible warning** rather than rolling back ODK (it can't) or
  failing the whole action (the user would think nothing saved when ODK already changed).
  The warning — not a reconciler — is the safety net.
- **Deferred: "Sincronizar ODK" `site_name` drift detection.** Detecting names edited
  *directly in ODK Central, bypassing the portal* (extending `previewSyncOdk`/`commitSyncOdk`)
  is its own feature with its own preview/commit semantics. Rare once the portal is the edit
  surface; defer to a separate ticket rather than bolt it on here. (Cut on reviewer consensus —
  DHH/Kieran/simplicity all flagged it as scope creep.)
- **Concurrency is detected via a page-load value snapshot, not just `baseVersion`.** The
  `expected` baseline carried from the dialog catches edits landing between page-load and
  save (the wide, real window); `baseVersion` only backstops the microsecond read→PATCH race.
  Both map to the same Spanish conflict message. This mirrors the existing `scheduleHash`
  optimistic lock — a just-in-time version read alone would silently overwrite concurrent edits.
- **Coordinate edits keep ODK `geometry` in sync (or coords aren't editable).** Decided at
  implementation time from the first `fetchEntity` response (see Facts note). Never leave a
  stale `geometry` point behind a changed lat/lng — that recreates ODK/portal drift in a
  different column.
