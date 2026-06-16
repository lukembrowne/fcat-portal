---
title: "FCAT Field Uploader — cross-platform rclone tray app for BioChoco SD-card → Drive"
type: feat
date: 2026-06-15
brainstorm: docs/brainstorms/2026-06-15-field-upload-utility-brainstorm.md
status: ready-for-review
---

# ✨ FCAT Field Uploader

A self-installing, cross-platform desktop **tray app** that wraps the `rclone` CLI to upload camera-trap images and audio recordings from the BioChoco field laptop **directly into the portal's existing Google Drive deployment folders** — replacing the failing Google Drive desktop app. Background, resumable, multi-day, checksum-verified. The portal's ingestion pipeline does **not** change; it discovers the files on its next scan exactly as today.

> Companion to the brainstorm (`docs/brainstorms/2026-06-15-field-upload-utility-brainstorm.md`), which settled WHAT to build. This plan settles HOW.

---

## Enhancement Summary

**Deepened on:** 2026-06-15 (8 parallel agents: UX research, Electron packaging, rclone internals, security, simplicity/YAGNI, spec-flow edge cases, architecture, frontend-design).

### Corrections the review caught (these were wrong in the first draft — fixed below)
1. **"Write-only service account" does not exist.** There is no write-only Google Drive OAuth scope; the SA necessarily has full read/write/**delete** on every drive it's a member of. The whole credential story is reframed as *"the key will eventually leak — minimize blast radius + detect fast,"* not *"the key is protected."* See **Credential design (revised)**.
2. **"Safe no-op re-run" was overstated.** Drive assigns a **new file ID on every upload**, so the portal's `(deploymentId, driveFileId)` dedup does **not** prevent duplicates from a *different* source tree (two laptops, an SD + a local copy, or the old Drive app's differently-nested partial sync). rclone `--checksum` only protects a re-run of the *same* source by relative path. Mitigation: a pre-upload `rclone check` "este despliegue ya tiene N archivos" warning + an optional portal soft-lock. See **Duplicate-prevention**.
3. **rclone filter globs must be `**.{ext}`, not `*.{ext}`.** `*` does not cross `/`, so a bare `*.jpg` matches **zero** files inside the SD card's `DCIM/100EK113/…` nesting — a silent "uploaded nothing" bug. Use `**` + `--ignore-case` (don't enumerate `{jpg,JPG}`), and do **not** mix `--exclude` with `--include` (`--include` already implies `- **`).
4. **`--drive-stop-on-upload-limit` exits code 7 — the *same* code as a genuinely fatal error.** "Defer to tomorrow" must disambiguate by inspecting the error string (`core/stats.lastError`), not the exit code alone.
5. **Drop `--immutable`.** It hard-errors the whole run if a source file changes mid-copy (e.g. the card is still being written), and it is not a security control. Use `--min-age 1m` to skip in-progress writes instead.

### Key improvements folded in
- **Credential is no longer baked into the distributed binary** — fetched from the portal at first run, stored via Electron `safeStorage`, and injected into rclone **disk-free** via `RCLONE_DRIVE_SERVICE_ACCOUNT_CREDENTIALS` + `RCLONE_CONFIG_*` env vars (no `rclone.conf`, no SA `.json` ever on disk).
- **The portal endpoint earns its keep** (the simplicity review wanted to cut it; security + architecture justify keeping it): it brokers the credential, returns the **routing config** (subfolder names + extension lists sourced from exported `drive-client.ts` constants, killing the hard-coded-drift seam), resolves the multi-drive mapping, and is **refreshed at job-start** (cache is offline-fallback only) to survive fan-out re-routing. Contract is versioned with a `minSupportedVersion` kill-switch.
- **Progress via `--rc` + `core/stats` polling** (typed JSON: counts, eta, speed, `retryError`/`fatalError`) instead of scraping `--stats-one-line` stdout.
- **Full Spanish UI design spec** (the "estación de campo" instrument aesthetic) + centralized `strings.es.ts` microcopy — see **Appendix A: UI/UX design spec**.
- **Per-arch DMGs** (not a universal `.app`) to avoid the `@electron/universal` binary-merge collision and the afterPack-doesn't-fire gotcha; **`zip` target mandatory** or auto-update silently breaks; **rclone signed via electron-builder `binaries[]`**; **pin + checksum/GPG-verify** the rclone binary before signing (supply chain).
- **A three-state error model** (auth-error vs source-gone vs integrity-failure — none of which shows the red "verification failed"), and an **expanded Phase 1 E2E** (half-synced folder, ñ/accented names, `.flac`/`.xlsx`/large `.mov` MD5, SD-eject mid-transfer, depth-5 recursion cap).

### Build progress (2026-06-15)
- ✅ **Phase 2 (portal endpoints) — shipped, PR [#11](https://github.com/lukembrowne/fcat-portal/pull/11)** on branch `feat/field-upload-endpoint`: `GET /api/field-upload/v1/deployments` (mapping + routing config from the new shared `drive-routing.ts`) **and** `GET /api/field-upload/v1/credential` (first-run SA-key hand-off). Timing-safe `FIELD_UPLOAD_TOKEN`, project allow-list, per-IP rate limits, versioned + `minSupportedVersion`. 30 unit tests pass; lint clean; the `drive-client.ts` constant-extraction refactor is behavior-preserving (147 existing tests pass). Appendix B token-mint remains the optional stronger alternative.
- ✅ **Phase 1 harness — shipped** in the standalone repo `/Users/luke/apps/fcat-field-uploader` (`scripts/upload-deployment.mjs`): runnable today once a SA + Drive membership exist. Encodes the rclone invariants (`**`/`--ignore-case`, copy-until-clean, code-7 disambiguation, `check` gate, disk-free cred). Electron skeleton (lifecycle/tray/power, credential, portal client, orchestration, all Spanish strings) scaffolded; **renderer UI is the main remaining build** (Appendix A).

### Open decision still to confirm
- **Scope of v1.** The simplicity review argues for a ~50–60% smaller "minimum lovable v1" (single window instead of tray; defer auto-update, Windows, and notarize-to-no-warning). The full plan below is the *target*; **Appendix C** records exactly what a lean v1 cuts so you can choose. Framework remains **Electron** (recommended) vs Tauri.

---

## Overview

The field team copies SD cards (deployment known from a **labeled bag**) onto a MacBook and relies on the Google Drive desktop app to sync into pre-made deployment folders. The Drive app stalls loading folders and silently never finishes, so uploads are badly behind. We replace only the transport layer with a purpose-built tool: **one drop, one click, walk away, come back to a checksum-verified ✅.**

It is a **new standalone application** (recommend a **separate repo**, not the monorepo — independent release cadence + isolated signing/SA secrets; the HTTP contract is the seam), not a change to the Next.js portal — plus one small **read-only** portal endpoint that brokers the credential and returns the deployment→drive/folder mapping + routing config.

```mermaid
flowchart LR
  SD[SD card in labeled bag] -->|copy / point at| L[Local folder on field laptop]
  L --> U[FCAT Field Uploader tray app]
  U -->|"refresh-at-job-start: mapping + routing + cred (cache = offline fallback)"| API[Portal: /api/field-upload/v1/deployments]
  U -->|spawns, --rc progress| RC[bundled rclone, env-injected SA cred]
  RC -->|rclone copy, direct to Drive| GD[(Google Shared Drive\ndeployment/camaras_trampas|grabadores_de_audio|ibutton)]
  RC -->|rclone check --one-way| GD
  GD -->|nightly recursive scan, unchanged| P[Portal ingestion pipeline]
  API -. read-only metadata only, no file transit .- P
```

---

## Problem Statement

- **Symptom:** Google Drive desktop app hangs on "loading folders"; sync never completes; the team can't tell whether anything uploaded. Uploads are weeks behind.
- **Root cause:** The Drive desktop app is an unreliable transport for tens of GB / thousands of files. It is also opaque — no trustworthy "done" signal.
- **Constraints (locked in brainstorm):**
  - Field team is **non-technical** → must be **self-installing** (double-click, zero config), **one drop + one click**.
  - Uploads happen at a base/office with **decent internet** (bandwidth is not the core problem; transport reliability + verification are).
  - Deployments are **~40 GB / ~10,000 files**, left to upload over **multiple days**.
  - Team wants **count + checksum verification** to trust completion.
  - **Cross-platform**: macOS now, Windows-ready (laptops may change).

---

## Proposed Solution

A tray app (recommended: **Electron**) that bundles a code-signed `rclone` binary and **fetches a dedicated, revocable Google service-account credential from the portal at first run** (no long-lived key in the distributed binary). Flow:

1. **Pick source + deployment.** User points the app at a folder (the SD card mount or a local copy). The app shows the deployment list (fetched once from the portal endpoint, then cached) and **auto-matches the dropped folder's name** to a deployment, or lets them pick from a list.
2. **Confirm.** App shows `Deployment NAC-005-A · 9,842 images · 312 audio · 1 iButton → subir`. One click (**Subir**).
3. **Route by extension.** Files route into `camaras_trampas` / `grabadores_de_audio` / `ibutton` purely by file extension — the team never sees subfolder names.
4. **Upload in the background.** `rclone copy --checksum` runs as a supervised subprocess; tray icon shows progress + ETA; survives network drops and resumes on wake; re-invoked in a loop until it exits clean.
5. **Verify.** `rclone check --one-way` confirms every source file exists on Drive with matching MD5 (write the diff with `--combined -` / `--missing-on-dst -` to populate the failure list). Only then: **"✅ 10,155 archivos verificados en Drive."** Failures show a red state with the missing list and a retry button.

### Why rclone (validated by research)
- `rclone copy` **never deletes** the destination (unlike `sync`) → safe add-only archive.
- **Resume = idempotent re-run.** rclone re-lists the destination, skips already-uploaded files (size+modtime, or hash with `--checksum`), transfers only the remainder. No corrupt partials are committed (Drive commits a file only when fully uploaded). Strategy: loop `copy` until exit `0` with `0` transfers (or use `--error-on-no-transfer` → exit 9 to detect "nothing left").
- **Checksums are trustworthy:** normal Drive files expose server-side MD5, so `--checksum` / `rclone check` verify without re-downloading. (Binary media — `.jpg/.mp4/.wav/.flac/.xlsx` — always get a Drive MD5; a stray Google-native file would be size-only-checked, but none are expected here. Confirm in Phase 1.)
- rclone sets `supportsAllDrives`/`includeItemsFromAllDrives` internally when `team_drive` is configured — the silent-empty-result gotcha is handled for us.
- ⚠️ **Idempotency caveat (corrected):** rclone's skip is by **relative path + hash against its own destination listing**. Re-running the **same source** is safe. But a **different source tree** for the same deployment (a second laptop, an SD + a local copy, or the old Drive app's flat layout vs the new tool's `DCIM/…` nesting) uploads the *same content at different relative paths* → Drive stores duplicates with new file IDs → the portal imports them as distinct records. See **Duplicate-prevention** below.

---

## User Experience & Spanish Localization (first-class requirement)

The whole tool must feel effortless for a non-technical, Spanish-speaking field team. This is not polish layered on at the end — it is an acceptance gate.

- **100% Spanish UI** — every label, button, status line, error, notification, tray menu, and the installer/quick-start. No English strings anywhere user-visible. Centralize strings in one file (e.g. `strings.es.ts`) so wording is reviewable by FCAT staff. (Routes/log files may stay English.)
- **Guided, can't-get-lost flow** — a linear 3-step path: **1) Elegir carpeta → 2) Confirmar despliegue → 3) Subir.** Big buttons, plain language, one primary action per screen. No jargon ("checksum" → "verificación", "deployment" → "despliegue", "upload" → "subir").
- **Always show what's happening** — determinate progress bar with `X de Y archivos`, human ETA (`~2 h 15 min restante`), current phase in Spanish ("Subiendo fotos…", "Verificando…"), throughput, and a tray icon state at a glance. Mirror the portal's processing-job UX conventions (`floating-job-progress.tsx`, `progress-tracker.tsx`).
- **Unmissable, trustworthy completion** — a large green **"✅ Listo — 10,155 archivos verificados en Drive"** with the per-type counts. Optionally a system notification so they can walk away and get pinged.
- **Friendly, actionable errors** — never a stack trace or error code. Each failure is a plain-Spanish sentence + what to do next + a retry button. Examples: "Sin conexión a internet — reintentará automáticamente.", "La carpeta de este despliegue aún no existe — créala en el portal primero.", "Verificación incompleta: 3 archivos no llegaron. Toca Reintentar."
- **Forgiving by design** — safe to close/reopen mid-job (it resumes), safe to re-run a finished upload (no-op), confirmation before uploading shows exactly what/where so a mis-pick is caught before it happens.
- **Self-explanatory first run** — a one-screen welcome in Spanish; zero settings to configure. Bundled Spanish quick-start (with screenshots) for the laptop.

## Technical Approach

### Architecture

| Layer | Choice | Notes |
|---|---|---|
| Shell/UI | **Electron** (recommended) | Reuses team TS skills; mature signing/notarization; `electron-updater`; `extraResources` to bundle rclone outside asar; first-class `Tray`. **Alternative: Tauri v2** (smaller footprint, but Rust + a known `externalBin`-vs-notarization sharp edge). **← key decision to confirm.** |
| Transport | **bundled `rclone`** | One static binary per OS, re-signed with our Developer ID (macOS Hardened Runtime). |
| Progress | **`--rc` + poll `core/stats`** (typed JSON: `transfers`/`totalTransfers`, `bytes`/`totalBytes`, `eta`, `speed`, `retryError`/`fatalError`); run the copy as an `_async` job and poll `job/status` for the terminal verdict | More robust than scraping `--stats-one-line` stdout. Bind `--rc-addr 127.0.0.1:<port>` loopback-only. Keep `--use-json-log` to a logfile for debugging only. |
| Credential | dedicated SA, **fetched from the portal at first run**, encrypted at rest with Electron **`safeStorage`** (persist the ciphertext yourself in `userData`, 0600) | Injected into rclone **disk-free** via `RCLONE_DRIVE_SERVICE_ACCOUNT_CREDENTIALS` (inline JSON) + `RCLONE_CONFIG_GDRIVE_*` env on `spawn` — no `rclone.conf`, no SA `.json` on disk. `safeStorage` is an *encryptor, not a store*; call it after `app.whenReady()`. **Not** `keytar` (archived). |
| Deployment mapping + routing config | new **read-only** portal endpoint (below), **refreshed at job-start**, cache = offline fallback only | Resolves which Shared Drive + folder IDs a deployment uses (multi-drive fan-out) **and** returns the subfolder-name + extension-routing config (from exported `drive-client.ts` constants) so the app doesn't hard-code drift-prone duplicates. |
| Power | `powerSaveBlocker('prevent-app-suspension')` while a job runs; LaunchAgent for reboot survival | "Survives sleep" is an OS+rclone problem, not a framework feature — design for pause/resume. |

### rclone configuration (per deployment, per file-type)

Point rclone's root at the **exact destination subfolder ID** (from the portal endpoint) so there's no path/name ambiguity and no risk of creating a stray duplicate folder:

No `rclone.conf` and no SA file on disk — the remote is defined entirely by environment variables on each `spawn`, with the credential injected inline from `safeStorage`-decrypted memory:

```bash
# set on the rclone child process env (see Credential row); nothing written to disk
RCLONE_DRIVE_SERVICE_ACCOUNT_CREDENTIALS='<inline SA JSON, in-memory>'
RCLONE_CONFIG_GDRIVE_TYPE=drive
RCLONE_CONFIG_GDRIVE_SCOPE=drive
RCLONE_CONFIG_GDRIVE_TEAM_DRIVE=0ABCDEF...        # = shared_drives.drive_id for THIS deployment's drive
RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID=<uploadCameraFolderId | uploadAudioFolderId | uploadIbuttonFolderId>
```

**Upload command — one pass per file-type group, looped until clean.** Each group points `root_folder_id` at its own subfolder and includes only that group's extensions. **`**` is mandatory** (a bare `*.jpg` will not match `DCIM/100EK113/IMG_0001.JPG`), and `--ignore-case` covers `.JPG`/`.jpg` without enumerating cases. Do **not** add `--exclude` — `--include` already implies `- **`.

```bash
# camera group (images + video → camaras_trampas); audio/ibutton groups identical with their ext set + subfolder
rclone copy "<src>" gdrive_camera: \
  --ignore-case \
  --include "**.{jpg,jpeg,png,gif,bmp,webp,tiff,tif,mp4,avi,mov}" \
  --checksum \
  --min-age 1m \
  --drive-chunk-size 64M \
  --retries 10 --low-level-retries 20 \
  --drive-stop-on-upload-limit \
  --rc --rc-addr 127.0.0.1:<port> --rc-no-auth \
  --use-json-log --log-level INFO
```
- `--min-age 1m` skips files modified in the last minute → avoids uploading a card that's still being copied (replaces the dropped `--immutable`, which would hard-error the whole run on any mid-copy change).
- `--drive-stop-on-upload-limit` makes the **750 GB / 24 h per-SA cap** a *fatal* error → **exit code 7**. ⚠️ Code 7 is shared with genuine fatal errors (account suspended), so classify "defer to tomorrow" by matching the upload-limit message in `core/stats.lastError`, not by exit code alone.
- Start with rclone defaults for `--transfers`/`--checkers`/`--tpslimit`/`--drive-chunk-size`; **tune against observed throttling in Phase 1** rather than hard-coding guesses. Peak RAM ≈ `transfers × drive-chunk-size`. Add `--tpslimit 10` only if 403s appear.
- Nested SD structure (e.g. `DCIM/100EK113/…`) is **preserved** under the subfolder — fine, because portal discovery (`listMediaRecursive`) is recursive **up to depth 5**; confirm worst-case card nesting stays within that from the deployment-subfolder root (Phase 1).
- "No reconocidos (omitidos)": enumerate the card (`rclone lsf -R --files-only`) and diff against the union of the three include sets so skipped files are *reported*, never silently dropped.

**Verification gate (after a clean copy of all groups):**
```bash
rclone check "<src>" gdrive: --one-way --combined - --log-level INFO
# check hashes by default (--checksum is redundant on check). --one-way: every source file must exist on dest.
# Exit 0 → ✅. Non-zero → red state; parse the "+ path" (missing-on-dst) and "* path" (differ) lines into the
# Spanish "Faltan:" list; Reintentar = re-loop copy then re-check. Never show ✅ unless check exits 0.
```

### Exact portal constants to hard-code (verbatim from `src/lib/drive-client.ts`)
- Subfolders (`:43-47`): `camaras_trampas`, `grabadores_de_audio`, `ibutton`.
- Images (`:391-393`): `.jpg .jpeg .png .gif .bmp .webp .tiff .tif`
- Video (`:395`): `.mp4 .avi .mov` → both images+video go to `camaras_trampas`.
- Audio (`:397-399`): `.wav .mp3 .flac .wac .w4v .ogg .aac` → `grabadores_de_audio` (handle `.wav` and `.flac` as equals).
- iButton (`:401`): `.xlsx` → `ibutton`.
- Files matching **no** known extension → reported as "no reconocidos (omitidos)" so nothing is silently dropped.

### New portal endpoint (the only portal-side change — read-only, no pipeline impact)

`GET /api/field-upload/v1/deployments?projectId=fcat-biochoco` (machine bearer-token auth). The simplicity review argued to cut this and scan Drive directly; security + architecture justify keeping it because it **brokers the credential, kills the hard-coded-constant drift seam, and resolves the multi-drive mapping authoritatively**. Versioned path + `minSupportedVersion` so an obsolete app (which holds a real credential) can be force-upgraded.

```jsonc
{
  "minSupportedVersion": "1.0.0",
  "routing": {                                  // ← from EXPORTED drive-client.ts constants, not hard-coded in the app
    "subfolders": { "camera": "camaras_trampas", "audio": "grabadores_de_audio", "ibutton": "ibutton" },
    "extensions": {
      "camera":  [".jpg",".jpeg",".png",".gif",".bmp",".webp",".tiff",".tif",".mp4",".avi",".mov"],
      "audio":   [".wav",".mp3",".flac",".wac",".w4v",".ogg",".aac"],
      "ibutton": [".xlsx"]
    }
  },
  "deployments": [
    {
      "deploymentId": "NAC-005-A",
      "displayName": "NAC-005-A — Nangaritza",
      "driveId": "0ABCDEF...",                  // shared_drives.drive_id (the drive THIS deployment lives on)
      "uploadCameraFolderId": "1aB...",         // biochoco_deployments.uploadCameraFolderId (a portal-side cache)
      "uploadAudioFolderId":  "1cD...",
      "uploadIbuttonFolderId":"1eF...",
      "uploadCountsCheckedAt": "2026-06-14T03:15:00Z"   // freshness signal for the folder-ID cache
    }
  ]
}
```
- **Source the `routing` block from the *exported* `drive-client.ts` symbols** (`AUDIO_EXTENSIONS` already exported; also export `IMAGE_EXTENSIONS`/`VIDEO_EXTENSIONS`/`DATA_TYPE_FOLDERS`) so the endpoint and the ingestion pipeline read the *same* constants — an extension added portal-side ships to the app with no release. `drive-client.ts` is `server-only`; the route handler imports it server-side and serializes the Sets to arrays. The app parses **forward-compatibly** (ignore unknown keys).
- **Refresh at job-start, cache as offline fallback only.** Folder IDs are themselves a portal-side cache (`uploadCountsCheckedAt`), and multi-drive fan-out can re-route a deployment after a stale fetch → the app must re-resolve `driveId` + folder IDs immediately before each upload. Keep the **"block if NULL folder ID, never name-create"** invariant absolute (per-type: if the source has audio but `uploadAudioFolderId` is null, block only that type with a specific message).
- **Files never transit the droplet** — the endpoint serves only small JSON. **First-run-offline gap:** the app needs one online fetch before it can pick a deployment; pre-seed the cache during install or have the admin do one online launch before handover (Phase 5 checklist).
- **Security hardening** (mirror existing portal patterns): reuse the timing-safe Bearer check from `src/lib/cron-auth.ts` (`verifyCronSecret`) with a **dedicated `FIELD_UPLOAD_TOKEN`** (not `CRON_SECRET`); validate `projectId` against a **hard-coded camera-trap project allowlist** (reject others with 400 — the token must never enumerate finance/other-project drives); **rate-limit** (429); read-only; log every hit. Document that `requirePermission()` deliberately does **not** apply (machine auth with no `X-Forwarded-Email`, exactly like the cron routes). Do **not** copy the cron routes' `X-Forwarded-For` rejection — this endpoint must be reachable through oauth2-proxy from the field laptop.

### Duplicate-prevention (correctness — the dataset can silently double)

Because Drive mints a new file ID per upload (see the idempotency caveat), guard against double-ingestion:
1. **Pre-upload check.** Before copying, run `rclone check --one-way` (or `rclone size`) against the destination and, if it already holds files, surface **"Este despliegue ya tiene N archivos en Drive — ¿continuar?"** so the operator can stop. This catches the second-laptop and old-Drive-app-partial cases before they create duplicates.
2. **Preserve the source tree, never flatten** (locked invariant). Distinct paths (`DCIM/100EK113/IMG_0001.JPG`) are fine — the portal dedups by Drive file ID and preserves `relativePath`. Flattening would collide same-basename files across card subfolders.
3. **Optional portal soft-lock/heartbeat** (fast-follow): a tiny companion endpoint records "upload in progress/completed for deployment X" so a second laptop sees **"Este despliegue ya se está subiendo desde otra computadora."** Best-effort; never gates the field workflow.
4. **First run over an old-Drive-app folder will differ in nesting** (old app uploaded flat) → may create duplicates; Phase 1 must test this against a real half-synced deployment and document the admin de-dup procedure.

---

## Implementation Phases

### Phase 1 — rclone core, proven on a real deployment (no GUI)
- Stand up a **dedicated, separate** SA (not the portal's SA); full `auth/drive` scope (no write-only scope exists); **zero** IAM role bindings, **no domain-wide delegation**; add as **Content Manager member** of every BioChoco Shared Drive (not folder-sharing — `403 requires shared drive membership` otherwise). Capture a screenshot of the empty IAM bindings as a gate.
- **Pin the rclone version** and verify its upstream `SHA256SUMS` (+ GPG) before vendoring; commit the expected checksum.
- Scripted per-group `copy` (loop-until-clean, `**` globs + `--ignore-case`) + `check --one-way --combined -` against a real ~40 GB deployment.
- **Expanded success criteria (per spec-flow review):** full deployment uploads, resumes after a forced kill, `check` exits 0, portal discovers on next scan. **Also test:** (a) a **half-synced / already-has-files** deployment (duplicate behavior + de-dup procedure), (b) **ñ/accented + very long filenames** (macOS NFD vs Drive NFC — confirm `check` doesn't false-fail; set normalization flags if needed), (c) `.flac` / `.xlsx` / a large `.mov` all expose Drive MD5 so `check` can reach green, (d) **SD-eject mid-transfer** → pause not infinite spin, (e) worst-case nesting stays within the portal's **depth-5** recursion cap from the subfolder root. Tune throughput flags against observed throttling.

### Phase 2 — portal endpoint (credential broker + routing config + mapping)
- Export the routing constants from `drive-client.ts`; add `GET /api/field-upload/v1/deployments` returning `{minSupportedVersion, routing, deployments[]}` (timing-safe `FIELD_UPLOAD_TOKEN`, hard-coded camera-trap project allowlist, rate-limited 429, read-only, hits logged).
- Add the **first-run credential-fetch** path (returns the SA blob once to an authenticated app) — or, if adopting the stronger short-lived-token design (Appendix B), the token-mint endpoint instead.
- **Success criteria:** returns correct `driveId` + 3 folder IDs + routing config; refuses unknown projects (400); handles NULL folder IDs; rejects bad/missing token (timing-safe); rate-limits.

### Phase 3 — Electron tray app (macOS first)
- Tray + hidden-window menubar pattern (`Tray` template image; `show:false, frame:false, skipTaskbar:true`; hide-on-close via `before-quit`/`win.on('close')`; `app.dock.hide()`); **single-instance lock** at top of main.
- Supervise rclone via **`--rc` + `core/stats`/`job/status` polling** → determinate progress, `X de Y`, ETA, phase status (Spanish), tray status. Spawn from **main** process; kill children on `before-quit` (SIGTERM→SIGKILL). Build the full Spanish UI from **Appendix A**, strings in `strings.es.ts`.
- **Three-state error model** (none of which shows the red "verification failed"): **auth-error** (401/403 → "Credenciales caducadas — contacta al administrador", pause), **source-gone** (SD ejected → "La tarjeta SD se desconectó", pause + resume), **integrity-failure** (`check` non-zero → red "Faltan N" + Reintentar). Plus empty/zero-recognized-files → disable Subir; mixed/whole-tree confirm ("Se subirán TODOS los archivos…"); grown-source re-point → "subir lo nuevo".
- Credential: fetch at first run → `safeStorage` encrypt → persist ciphertext in `userData` (0600) → decrypt to memory → inject via env on spawn. Power assertion (`prevent-app-suspension`) only during a job; `powerMonitor` resume → re-kick rclone.
- **Success criteria:** non-technical dry-run — a tester with no instructions completes drop→click→verified ✅ on a multi-GB deployment, including a mid-run laptop sleep that resumes and an SD-eject that pauses+recovers.

### Phase 4 — signing, packaging, distribution
- **Per-arch DMGs** (arm64 + x64), **not a universal `.app`** (avoids the `@electron/universal` rclone-merge collision + the afterPack-doesn't-fire gotcha). **`zip` target mandatory** alongside `dmg` or `latest-mac.yml` + auto-update silently vanish.
- rclone via `extraResources` (outside asar) at `bin/rclone`; resolve with `app.isPackaged` → `process.resourcesPath`; `chmod 0755` in `afterPack`.
- **macOS:** $99/yr Apple Developer; list the **nested rclone in `mac.binaries[]`** so electron-builder signs it inside-out with Developer ID + Hardened Runtime + timestamp (not `--deep`); **start with empty entitlements on rclone** (static Go binary needs none — add narrowest only if notarytool log demands); notarize via `notarize:{teamId}` + App Store Connect API key; staples automatically.
- **Windows (later):** FCAT is Ecuador-based → Azure Trusted Signing (US/Canada-only) likely ineligible. Ship **unsigned with a documented one-time "More info → Run anyway"** (first verify Smart App Control isn't blocking), or an **OV cert on a hardware/cloud HSM** (no EV — it no longer bypasses SmartScreen).
- `electron-updater` from a **public** GitHub Releases repo; **every update re-signed + notarized with the same Team ID** or Squirrel.Mac silently rejects it. Lock down releases (protected branch, 2FA, CI-built from pinned commit — this channel ships code + creds to the fleet).
- **Success criteria:** double-click install on a clean Mac with no Gatekeeper warning; auto-update delivers a re-signed/notarized version.

### Phase 5 — rollout & runbook
- Field-team one-pager (Spanish, screenshots): plug in laptop, **lid open**, drop folder, click Subir, wait for ✅. Include the **one-time online launch before handover** (seeds the deployment-list cache).
- Admin runbook: **incident response is ordered** — (1) `gcloud iam service-accounts disable` the SA (kills existing tokens ~immediately; deleting a *key* leaves ~1 h of valid tokens), (2) remove its Shared-Drive memberships, (3) rotate/delete keys, (4) audit recent Drive activity. Routine key rotation ~90 days.
- **Detection (since the key will eventually leak):** enable Google Cloud **Drive API Data Access audit logs**; alert on any **delete** by this SA (a copy-only tool should never delete), token mints from **unexpected IP/geo** (field laptops are Ecuador), and access to **drives outside BioChoco**. Note in the shared-drive provisioning runbook that this SA's membership list *is* its blast radius.

---

## Alternative Approaches Considered
- **Browser upload page in the portal (Approach B):** rejected — browsers can't reliably hold a multi-day, 40 GB, 10k-file unattended transfer (sleep, tab/OS restarts), and the robust direct-to-Drive resumable version is *more* engineering than the app while leaning on portal/droplet uptime (and the droplet already had a disk-full outage).
- **Pure background watch-folder daemon (Approach C):** good engine, but "drop into the correctly-named local folder" reintroduces the wrong-folder error and silent-failure invisibility — today's exact pain. Its resilient-background idea is folded into the tray app; its weaker per-upload confirmation is not.
- **Tauri instead of Electron:** smaller binary, but Rust + the `externalBin` sidecar/notarization sharp edge; kept as the documented alternative.
- **Short-lived creds from a backend instead of a baked-in SA:** the first draft dismissed this as over-engineering. The security review **re-ranked it toward "recommended"** once it established the baked key is full read/write/delete: the portal already holds the SA server-side and could mint ~1 h Drive access tokens, collapsing the leak blast radius. The catch for *this* workload is that a single 40 GB `copy` runs longer than a 1 h token lives and SA access tokens can't self-refresh — so it needs a token-refresh loop around rclone re-invocations. **Decision:** v1 ships the *fetch-key-at-first-run* design (no key in the distributed binary, multi-day-friendly); the short-lived-token design is documented in **Appendix B** as the stronger fast-follow if blast radius proves unacceptable.

---

## Acceptance Criteria

### Functional
- [ ] A non-technical user completes **drop → pick/auto-match deployment → one click → verified ✅** with no config.
- [ ] Files route to `camaras_trampas` / `grabadores_de_audio` / `ibutton` purely by extension; unrecognized files are reported, never silently dropped.
- [ ] Upload survives a network drop and a laptop sleep, **auto-resuming** without re-uploading already-verified files.
- [ ] Completion shows count **and** checksum verification; a verification failure shows a red state with the diff list and a retry, and never shows ✅.
- [ ] Re-running the **same source** is a safe no-op (rclone skips by path+hash). Re-pointing at a **different** source for the same deployment surfaces the **"este despliegue ya tiene N archivos"** warning before it can create duplicates.
- [ ] A deployment with a NULL/missing Drive folder ID (per type) is **blocked with a clear Spanish error**, not uploaded into a stray folder.
- [ ] The app **refreshes** the deployment/drive mapping at job-start (cache is offline-fallback only) and parses the endpoint forward-compatibly.
- [ ] Three distinct non-✅ states for auth-expired / source-gone / integrity-failure, each with its own Spanish message + recovery.
- [ ] Portal discovers uploaded files on its normal scan with **zero pipeline changes**.

### Non-Functional
- [ ] macOS app installs via double-click with **no Gatekeeper warning** (signed + notarized, incl. nested rclone binary).
- [ ] Per-arch DMGs; `zip` target present (auto-update intact); rclone version pinned + checksum-verified before signing.
- [ ] Peak RAM bounded; stays under Drive rate limits (no sustained 403 storms).
- [ ] SA is **separate** from the portal SA, full `auth/drive` scope, **zero extra IAM**, **no DWD**, member of only the BioChoco drives; credential fetched at first run and stored via `safeStorage`, never written to disk as plaintext (no `rclone.conf`/SA file).
- [ ] Drive Data Access audit logs enabled; alerting on deletes / foreign-geo token mints / out-of-scope drive access.
- [ ] All UI strings in **Spanish**.
- [ ] Auto-update delivers re-signed/notarized versions.

### Quality Gates
- [ ] End-to-end test on a real ~40 GB deployment incl. forced mid-transfer kill + resume + passing `check`.
- [ ] Documented SA rotation/revocation/monitoring runbook.
- [ ] Field-team Spanish quick-start with screenshots.

---

## Dependencies & Risks

| Risk | Mitigation |
|---|---|
| **"Close the lid and leave for days" is unreliable** (Apple Silicon sleeps on lid-close regardless of caffeinate) | Field instruction: **plugged in, lid open**. App holds a power assertion while running and **auto-resumes on wake** so an accidental sleep is non-fatal — just slower. |
| **Multi-Shared-Drive fan-out** — a deployment can be on any of several drives | Portal endpoint returns the deployment's exact `driveId` + folder IDs; app caches it. SA must be a member of **all** BioChoco drives. |
| **Credential leak is a matter of *when*, and the key is full read/write/delete** (no write-only scope exists; baked secrets are extractable) | Don't bake the key in the binary — fetch at first run, `safeStorage` + disk-free env injection; **separate** SA, full `drive` scope but **zero IAM/DWD**, member of only BioChoco drives (= blast radius); detection (Data Access audit logs, alert on deletes/foreign-geo); ordered revocation (disable SA → remove memberships → rotate). Evaluate the stronger **short-lived-token** design (Appendix B). |
| **Silent dataset doubling** (Drive mints new file IDs; dedup-by-ID doesn't catch a different source tree / second laptop / old-app partial) | Pre-upload `rclone check` "ya tiene N archivos" warning; never flatten; optional portal soft-lock; Phase-1 test against a half-synced folder. |
| **`**` glob omission → silent "uploaded nothing"** | Filters MUST be `**.{ext}` (crosses `DCIM/…` nesting) + `--ignore-case`; never mix `--exclude` with `--include`; Phase-1 asserts non-zero file count. |
| **750 GB / 24 h per-SA cap** → exit code 7 shared with fatal | `--drive-stop-on-upload-limit`; classify "defer to tomorrow" by matching the limit message in `core/stats.lastError`, not exit code alone. |
| **Card still being written when Subir is clicked** | `--min-age 1m` skips files modified in the last minute (replaces `--immutable`, which would hard-error the run). |
| **Windows signing** (FCAT Ecuador → Azure Trusted Signing likely ineligible) | Documented one-time "Run anyway" for the small trusted fleet, or OV cert on hardware token. Defer until Windows is actually needed. |
| **Laptop disk** must hold the deployment if copied off the SD first | Allow pointing the app **directly at the SD mount**; pre-flight free-disk check before any local copy (reuse the disk-bounded pattern from the 2026-05-25 incident learnings). |
| **First field run with no internet + empty cache** | Pre-seed the deployment-list cache at install / one admin online launch before handover; clear Spanish message if cache empty + offline. |
| **2026 Google "expansive access" change (Feb 2026)** | Re-verify SA can list/write the Shared Drive after that policy date as part of Phase 1. |

---

## References & Research

### Internal
- Brainstorm: `docs/brainstorms/2026-06-15-field-upload-utility-brainstorm.md`
- SA load + auth client + scope: `src/lib/drive-client.ts:52-68`
- Subfolder names + extension sets + routing matrix: `src/lib/drive-client.ts:43-47, 391-407`
- Deployment folder IDs + `shared_drive_id` source: `src/app/biochoco/data/actions.ts`; schema `src/db/schema.ts:177-179, 197, 622-627`
- Recursive discovery (why nested SD structure is fine): `listMediaRecursive` `src/lib/drive-client.ts:505-585`
- SA-must-be-Content-Manager-member: `docs/operations/shared-drive-provisioning-runbook.md:32, 108-126`
- `supportsAllDrives` silent-empty gotcha: `docs/solutions/integration-issues/google-drive-recursive-file-counting-20260224.md:128-129`
- gaxios v7 retry-reason gotcha (only if we ever hand-roll Drive API calls): CLAUDE.md memory `gotcha_gaxios_v7_retry_reason`
- Disk-bounded chunked pattern: `docs/plans/ml-chunked-download-spec.md`; incident `incident_disk_full_biochoco_download.md`
- Processing-job UX conventions to mirror (progress/ETA/status): `floating-job-progress.tsx`, `progress-tracker.tsx`
- `compound-engineering:rclone` skill (config/orchestration help during build)

### External (2026)
- rclone Drive backend (service_account, team_drive, root_folder_id, chunk-size, pacer): https://rclone.org/drive/
- rclone copy vs sync / flags / exit codes / resumability: https://rclone.org/commands/rclone_copy/ · https://rclone.org/flags/ · https://rclone.org/docs/
- rclone check (integrity gate): https://rclone.org/commands/rclone_check/
- rclone remote control (live progress): https://rclone.org/rc/
- Electron Tray / auto-update / power-save-blocker: https://electronjs.org/docs/latest/tutorial/tray · https://electron.build/docs/auto-update · https://electronjs.org/docs/latest/api/power-save-blocker
- Tauri v2 tray / sidecar / updater (alternative): https://v2.tauri.app/learn/system-tray/ · https://v2.tauri.app/develop/sidecar/ · https://v2.tauri.app/plugin/updater/
- macOS notarization: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Windows SmartScreen / Azure Trusted Signing: https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation · https://learn.microsoft.com/azure/artifact-signing/overview
- SA key best practices / rotation (Google Mar-2026 advisory): https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys · https://cloud.google.com/iam/docs/key-rotation
- rclone filtering (`**`/`--ignore-case`/`--filter-from`): https://rclone.org/filtering/ · rclone rc (`core/stats`, `_async`, `job/status`): https://rclone.org/rc/ · exit codes: https://rclone.org/docs/
- electron-builder contents/`extraResources`, code-signing (mac `binaries[]`), notarization, auto-update: https://www.electron.build/docs/contents · https://www.electron.build/docs/features/code-signing/code-signing-mac/ · https://www.electron.build/docs/features/auto-update
- Electron `safeStorage` / `Tray` / `powerSaveBlocker` / single-instance: https://www.electronjs.org/docs/latest/api/safe-storage · https://www.electronjs.org/docs/latest/api/tray · https://www.electronjs.org/docs/latest/api/power-save-blocker
- Drive OAuth scopes (no write-only scope): https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Reuse internally: timing-safe Bearer `src/lib/cron-auth.ts` (`verifyCronSecret`); allowlist + per-project pattern `src/app/api/odk/photos/route.ts`; machine-auth route precedent `src/app/api/cron/reconcile-shared-drives/route.ts`; `recordEvent()` `src/lib/system-events.ts`

---

## Appendix A — UI/UX design spec (Spanish, "estación de campo")

Full design proposal produced by the frontend-design pass; lift directly into implementation.

**Aesthetic:** field-station instrumentation — calm, matte, paper-and-ink, one decisive green that appears **only when verified** (working = blue, waiting = amber, needs-person = clay red). Not a SaaS dashboard; legible at arm's length in bad light. Avoids generic AI aesthetics (no Inter, no purple gradients, no glass cards).

**Design system:**
- **Type:** Fraunces (display/headings) + **Atkinson Hyperlegible** (body/UI/counts, tabular figures) — both bundled offline. Base 18px; nothing interactive < 18px. Scale: display 44 / h2 30 / lead 22 / body 18 / small 15; mono count 56.
- **Color:** `--paper #F4F1EA`, `--card #FFF`, `--ink #1C1B19`; `--verde-700 #1E5E3A` (verified/go) with a 3px darker bottom-edge on buttons (physical feel); `--azul-600 #1F6F8B` (working); `--ambar-600 #B5781A` (waiting); `--rojo-600 #A8341F` (error). All text ≥ 7:1 contrast. State is always **color + icon + word** (color-blind/bad-light safe).
- **Layout:** fixed **520 × 640** menubar-popover window (non-resizable — removes layout-bug class). Persistent left **step rail** `1 Carpeta · 2 Despliegue · 3 Subir` (the can't-get-lost device). Targets ≥ 56px; primary CTA 72px, one per screen. 8px grid.
- **Signature element:** a 220px circular **estado dial** (instrument gauge) on upload/done screens + the step rail. Verified = a **check-in-a-seal** ("comprobado contra Drive"), not a plain tick.
- **Icons:** custom 2px-stroke, 6 glyphs only (carpeta, cámara, onda/audio, termómetro/iButton, sello-verificado, atención).
- **Motion:** restrained — 200ms rail-following slides, 150ms count-up tweens, 400ms dial sweep, one-time seal draw-on at completion (no confetti). Respect `prefers-reduced-motion`.

**Screens (wireframed in the design pass):** First-run welcome → 1 Elegir carpeta (dropzone) → 2 Confirmar despliegue (deployment + per-type counts + "no reconocidos (se omiten)" + restated-count Subir button) → 3 Subiendo (dial + redundant bar + ETA + "puedes cerrar la ventana… mantén el equipo enchufado y con la tapa abierta") → Listo ✅ (verde seal + per-type ✓ + system notification) → Verificación incompleta (clay seal + "Faltan:" scrollable list + Reintentar + Copiar reporte). **Tray:** template-image glyph + colored status dot (idle/subiendo/esperando/listo/error); live status line + Pausar/Abrir/Salir menu; `Salir` mid-job confirms "continuará la próxima vez". Single-flight: a running job replaces "Subir un despliegue…" with "Abrir ventana".

**Microcopy:** centralize every string in `strings.es.ts` (full key→string table delivered by the design pass — `welcome.cta`="Empezar", `phase.verify`="Verificando…", `verify.sub`="Comprobando que todo llegó a Drive…", `done.title`="Listo ✅", `wait.noInternet`="Sin conexión a internet. Reintentará solo cuando vuelva la señal. No tienes que hacer nada.", `wait.dailyCap`="Límite diario de Google alcanzado. Continuará mañana automáticamente.", `error.body`="{n} archivos no llegaron a Drive. Esto suele pasar por una caída de internet.", etc.). Use tú/vos register, never "usted"; never an error code.

---

## Appendix B — Stronger credential option: short-lived tokens (fast-follow)

If the full read/write/delete blast radius of an on-laptop key proves unacceptable:
- The field app authenticates to the portal (its `FIELD_UPLOAD_TOKEN`) and requests a **short-lived (~1 h) Google Drive OAuth access token**, which the portal mints from the SA it already holds server-side. No long-lived Drive key ever touches the laptop; a leak self-expires; revocation is central.
- rclone uses it via `RCLONE_DRIVE_TOKEN` / `--drive-token`. **Multi-day caveat:** SA access tokens can't self-refresh, and a 40 GB `copy` outlives 1 h — so the app's loop-until-clean wrapper must **re-mint before each `copy` re-invocation** and accept that a single invocation may die ~1 h in and resume on the next (idempotent). Acceptable but choppier than the fetch-key design.
- Worth it when: the tool leaves fully-trusted staff, the SA touches more/higher-sensitivity drives, or org policy blocks SA-key creation.

---

## Appendix C — "Minimum lovable v1" scope (simplicity review)

The simplicity review estimates ~50–60% less work for the same core "drop → click → verified ✅" outcome. If schedule-constrained, ship this first and treat the rest as v2:

**Cut/defer for v1:** Windows entirely; `electron-updater` (hand-deliver new builds to the small fleet); notarize-to-no-Gatekeeper-warning (document a one-time right-click→Open); the tray/background daemon + LaunchAgent (a **single foreground window**, kept open with lid up, still resumes via rclone if closed); the portal soft-lock/heartbeat; the completion system-event; flag micro-tuning.

**Keep even in v1 (cheap + load-bearing):** rclone `copy`(`**`+`--ignore-case`)→`check --one-way` gate; per-extension routing into the three subfolders; the **fetch-at-first-run credential + `safeStorage`** (security-meaningful, low effort — do *not* downgrade to a plaintext file); the endpoint as credential-broker + routing-config + mapping (it's what removes drift and the on-disk key); 100% Spanish UI from `strings.es.ts`; the pre-upload "ya tiene N archivos" duplicate guard; SA scoping + revocation runbook.

**Note the divergence:** the simplicity review would also cut the endpoint (scan Drive directly). This plan **keeps it** because security (credential brokering) and architecture (routing-config anti-drift, authoritative multi-drive mapping) outweigh the saving — but a v1 that direct-scans Drive with a fetched key + hard-codes constants is a legitimate smaller alternative if you accept the extension-drift risk and a plaintext-key-on-disk posture.
