# Shared Drive Provisioning Runbook

When a registered Shared Drive approaches Google's **500,000-item cap**, provision a
new one and register it in the portal. This is a rare, consequential action kept
deliberately manual (a human in the loop), because the service account does not
have Workspace-admin rights to create Shared Drives via API.

## When to act

The nightly reconciliation (`/api/cron/reconcile-shared-drives`, 3:15 AM ET) emits
`system_events` (visible at **/admin/activity**, source = Shared Drives) and the
capacity bars at **/admin/shared-drives** turn color:

| Threshold | Event (`event_type`) | Severity | Action |
|---|---|---|---|
| **75%** (soft) | `drive_threshold_soft` | warning | Plan to provision; no rush. Re-nags daily. |
| **85%** (hard) | `drive_threshold_hard` | error | Provision **now**. The selector refuses new reservations on this drive. Re-nags daily. |
| **95%** (stop) | `drive_full_readonly` | error | The drive auto-flips to `read-only`. New deployments must have somewhere else to land. |

Provisioning lead time is days, so treat the **75%** soft alert as the real trigger.
Keep at least one `active` drive with headroom at all times. A good rule of thumb:
provision the next drive when the current one hits **50%**.

## Steps (target: < 15 minutes)

### 1. Create the Shared Drive (Google Workspace Admin)

1. In Google Drive, create a new Shared Drive named on the existing convention,
   e.g. **`FCAT-BIOCHOCO-2`**, **`FCAT-BIOCHOCO-3`**, …
2. Add **two members** with the **Content Manager** role (not Viewer/Commenter —
   the FLAC compression pipeline writes file *revisions*, which needs write access):
   - the portal **service account** (the `client_email` from
     `GOOGLE_SERVICE_ACCOUNT_KEY`) — needed for capacity counting + processing; and
   - **`monitoreo@fcat-ecuador.org`** — the account the **field team uploads with**.
     Without it, field uploads to deployments on this drive will fail.

### 2. Get the Shared Drive ID

Open the new Shared Drive in a browser. The URL is
`https://drive.google.com/drive/folders/0A…` — the `0A…` segment is the **Drive ID**.

### 3. Register it in the portal

1. Go to **/admin/shared-drives** → **Registrar drive**.
2. Paste the `0A…` Drive ID → **Verificar**.
   - The portal calls `drives.get` and shows the drive's **name + creation date**.
     This confirms the service account can see it and you pasted the right ID.
   - If it errors, the SA membership (step 1.2) didn't take — re-check the role.
3. **Select the project** this drive serves (required). One drive serves exactly one
   project; routing + discovery are scoped to it, so the drive only ever holds and is
   scanned for that project's deployments. A large project (BioChoco) can have several
   drives; provision another and assign it to the same project when it fills.
4. (Optional) Set a deployment **root folder** if new deployments should live in a
   subfolder rather than the drive root. Leave blank to use the drive root (correct
   for a fresh drive dedicated to one project).
5. Click **Registrar**. The portal inserts the row as `registering`, runs an initial
   full item count, then flips it to `active` (or `unreachable` if Drive access fails).

> A registered drive's project can be re-assigned inline from the table (the project
> dropdown in the Acciones column) — useful if `bootstrap-shared-drives.ts` left a
> drive unassigned because its root folder didn't match a project root.

### 4. Flip the feature flags (first time only)

The fan-out is gated by two env flags (both default `false`). Flip them
independently, **discovery first**:

1. `SHARED_DRIVE_DISCOVERY_ENABLED=true` — discovery scans now union across the
   **project's** registered drives. Deploy, monitor camera-trap sync for 24h (should
   be a no-op until the new drive holds deployments).
2. Mark the near-full drive `read-only` in **/admin/shared-drives** so the new drive
   is the only `active` one **for that project** (other projects are unaffected).
3. `SHARED_DRIVE_ROUTING_ENABLED=true` — new deployment folders now route by
   capacity. Deploy.

After the first rollout, subsequent drives only need steps 1–3 (register + mark the
old one read-only); the flags stay on.

### 5. Verify

- New deployments land on the new drive: **/admin/shared-drives** count climbs; the
  old drive's count stays flat.
- No `deployment_folder_create_no_capacity` / `no_active_drives` errors in
  **/admin/activity**.
- Reads (image proxy, audio streaming, ML, training exports) keep working for
  deployments on every drive — they resolve by file ID via `supportsAllDrives`.

## Rollback

Routing rollback is safe — every deployment carries its own `driveFolderId` that the
Drive API resolves regardless of which drive it lives on.

1. `SHARED_DRIVE_ROUTING_ENABLED=false`, redeploy.
2. Mark the old drive `active` again at **/admin/shared-drives**.
3. Leave `SHARED_DRIVE_DISCOVERY_ENABLED=true` so deployments already created on the
   new drive are still discovered by sync.

## Manual reconciliation

Click **Reconciliar ahora** on **/admin/shared-drives** to true up counts immediately
(single-flight: it reuses an in-flight reconcile). Or from the host:

```bash
docker compose exec -T portal curl -fsS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/reconcile-shared-drives
```

## Prerequisite: service-account Shared Drive membership

> **Required before bootstrapping or registering any drive — including the existing
> `FCAT-BIOCHOCO`.** The portal historically had only *folder-level* access to the
> BIOCHOCO tree (every legacy call is parent-folder scoped: `'<folderId>' in parents`).
> The capacity layer is the first thing that needs **Shared Drive membership**:
> `drives.get`, `files.list?corpora=drive`, and `changes.list` all fail with
> *"requires shared drive membership"* / *"Shared drive not found"* for a non-member,
> even one with full folder access.

For **each** Shared Drive (the existing one and every new one), a Workspace admin or
drive Manager must add the service account (`client_email` from
`GOOGLE_SERVICE_ACCOUNT_KEY`) as a **Content Manager member** of the drive itself —
not merely share a folder into it. Verify with:

```bash
docker compose exec portal npx tsx scripts/bootstrap-shared-drives.ts --dry-run
```

A non-member fails fast with a membership hint; a member prints per-drive counts.

## Bootstrapping the registry (one-time)

After deploying the schema (and granting membership above), populate the registry
from existing data:

```bash
docker compose exec portal npx tsx scripts/bootstrap-shared-drives.ts --dry-run  # preview
docker compose exec portal npx tsx scripts/bootstrap-shared-drives.ts            # apply
```

It discovers every Shared Drive currently backing deployments, counts each, and
backfills `biochoco_deployments.shared_drive_id`. Idempotent and re-runnable.

## Capacity accounting notes

- **`reconciled_count`** is Drive API ground truth (nightly `changes.list` delta;
  weekly Sunday full `files.list` count). The DB-derived file sum is *not* used for
  routing — it under-counts frames, trash, and manual uploads.
- **`pending_reservations_count`** is in-flight folder reservations
  (`DEPLOYMENT_QUOTA` = 40,000 each), trued up by reconcile.
- Trashed files still count toward the cap until purged (~30 days), so
  `reconciled_count` **includes them** (matches Google's item-cap warning). The
  delta only decrements on a permanent `removed`; a trash is net-zero. The
  purgeable subset is tracked in `trashed_count` and shown on the admin page —
  emptying a drive's Trash reclaims that capacity. `trashed_count` and the
  trash-inclusive total are only re-measured on the **weekly Sunday full count**.
