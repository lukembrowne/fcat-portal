---
date: 2026-05-22
topic: multi-shared-drive-fanout
---

# Multi-Shared-Drive Fan-Out for Deployment Data

## What We're Building

A capacity-based routing layer that distributes new deployment folders across multiple Google Shared Drives, avoiding the **500,000 item per Shared Drive** cap. The current `FCAT-BIOCHOCO` drive is at ~88% capacity (12% left). Projected demand — ~300 audio deployments × ~5,000 recordings each = ~1.5M audio files alone, plus camera-trap images and videos — would blow through the cap of any single drive several times over.

Scope: the shared "deployments" hierarchy keyed off `biochoco_deployments.driveFolderId`, which today holds BIOCHOCO + historical camera-trap projects + Amazon camera-trap data, all sharing the same Shared Drive.

The codebase is **already drive-agnostic**: every Drive API call uses `supportsAllDrives: true`, and each deployment carries its own `driveFolderId`. So we don't refactor the storage layer — we add a small registry + routing decision in the few places that pick a *parent* folder when creating a new deployment, plus the few places that scan for new deployments across the hierarchy.

## Why This Approach

Three alternatives were considered:

- **B: Per-deployment archive containers (`.tar`)** — would cut item count ~1000x but breaks audio streaming (Range-header range reads), BirdNET/indices pipelines, revert-compression flow, and the spectrogram UI. Deep refactor with active-pipeline pain.
- **C: Object storage (R2/B2)** for audio — clean, scales to billions, but costs $600–1500/mo for 100TB. FCAT has 100TB free via Google Workspace nonprofit. Doesn't pencil out.
- **D: Hybrid Drive + Glacier** — combines A + C complexity; restore latency would surprise future users.

**Chosen: Approach A — multi-drive registry.** Free storage stays free, change is small and contained, no active pipelines break. Approach B is documented as a future optimization if file count becomes the binding constraint again later.

## Key Decisions

- **Forward-only routing.** Existing data on FCAT-BIOCHOCO stays put. Only NEW deployments land on new drives. Rationale: cross-Shared-Drive moves are slow, risky (file IDs may change, breaks `audio_files.driveFileId` references), and unnecessary — we just need to stop *adding* to the full drive.
- **Auto-by-capacity selection.** A new `shared_drives` DB table tracks each registered drive (`drive_id`, `name`, `item_count`, `item_cap` default 500_000, `status`: active / full / archived / read-only). When creating a new deployment folder, system picks the active drive with the most headroom. Fully transparent to the field operator / ODK flow.
- **Manual provisioning + portal alert.** When the most-headroom active drive crosses 80%, portal emits a `system_event` (and ideally an email/slack notification) telling an admin to: (1) create a new Shared Drive in Google Admin, (2) grant the service account access, (3) register it in `/admin`. Avoids needing elevated Workspace API perms for the service account and keeps a human in the loop on a rare, consequential action.
- **Scope = the deployments hierarchy.** This single table (`biochoco_deployments`) is the one currently filling the BIOCHOCO drive. Other Drive-backed modules (research applications, camera-trap projects standalone tree) are *not* in scope now — they're far from capacity. Design the abstraction generically so we can apply it to them later without rework.
- **DB-derived capacity counting with periodic Drive reconciliation.** Item count = sum of `audio_files` + `biochoco_images` + `biochoco_videos` rows whose deployment's `driveFolderId` belongs to that drive, plus a flat overhead estimate per deployment (folder + 3 subfolders + `_frames/` if present). A nightly reconciliation job calls Drive API (`files.list` with `driveId`) to true-up counts and catch drift from files we don't track (e.g., manual uploads, `_frames/`).

## Architectural Sketch (for the plan phase to flesh out)

1. **New DB table `shared_drives`** with the columns above and a derived `headroom` view. Add `shared_drive_id` FK to `biochoco_deployments` (denormalized — the drive can also be resolved from `driveFolderId` by traversing parents, but the FK keeps queries fast).
2. **New env var ELIMINATED, replaced by DB.** `CAMERA_TRAP_ROOT_FOLDER_ID` and similar one-root env vars get superseded by a query against `shared_drives` where `status='active'`. The env var becomes a bootstrap seed value only.
3. **Three code paths learn about "many roots":**
   - `listDeploymentFolders()` in `drive-client.ts` → iterate over all active drives' root folder IDs, union results.
   - The "create new deployment folder" path in `biochoco/data/drive-folder-actions.ts` → pick `shared_drives.where(status='active').orderBy(itemCount asc).first` as the parent.
   - Any cron/sync that "discovers new deployments" → same iteration.
4. **Admin UI:** new section under `/admin` listing registered drives with name, headroom bar, status. Action: "Register new drive" (takes a Drive ID + display name; verifies SA can access).
5. **`system_events` integration:** record drive registration, status transitions (active → full), and the at-80% alert. Use existing `recordEvent()` per CLAUDE.md conventions.
6. **Migration:** insert one row into `shared_drives` for FCAT-BIOCHOCO with current measured item count; backfill `shared_drive_id` on all existing `biochoco_deployments` rows pointing to it.

## Open Questions (for the plan phase)

- **Reconciliation cadence:** nightly? On every deployment-create? On admin UI load? (Lean nightly + manual "refresh now" button.)
- **Alert channel:** is `system_events` enough, or do we want email / Slack? Who is the recipient list?
- **Initial pool:** at the 80% threshold today, do we provision 1 new drive or 3–5 upfront to avoid back-to-back alerts in heavy field seasons?
- **Threshold tuning:** 80% gives a 100K-item buffer (~3 deployments). Is that the right margin given how quickly a season can fill?
- **Oversized deployments:** what if a single deployment exceeds expected file count and would push the chosen drive past its cap mid-upload? Fail loudly, or rebalance to a different drive? (Lean: fail loudly with a clear error — rebalancing mid-upload is too magical.)
- **"All drives full" failure mode:** if no active drive has headroom and no new one is provisioned, do we hard-fail new deployment creation or queue? Hard-fail is loud and safe; queueing risks silent backlog.
- **ODK auto-folder-creation:** the BIOCHOCO ODK → folder flow creates folders automatically on submission. It needs to consult the registry to pick the parent — make sure it can't accidentally use a stale env var.

## Next Steps

→ `/workflows:plan` for implementation details, including the exact schema migration, file-by-file changes, and a phased rollout (e.g., ship the registry + admin UI first behind a feature flag, then flip the routing logic).
