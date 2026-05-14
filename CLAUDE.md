# FCAT Portal — Project Conventions

## Overview

Internal web application for FCAT staff and collaborators. Domain: `portal.fcat-ecuador.org`. Primarily TypeScript (Next.js) with a camera trap data processing pipeline. The UI is in Spanish (e.g., 'Instalaciones', 'Historial de Procesamiento', 'Herramientas'). Always use Spanish for user-facing strings unless told otherwise.

## Environment

- **Node version**: 22 (required for `better-sqlite3` native module compatibility)
- **Database**: SQLite at `data/portal.db`, WAL mode, singleton connection
- **ML Python venv**: Auto-installed via `uv` at Docker startup into `data/ml-venv/`. Persists across container restarts. Delete `data/ml-venv/` to force reinstall.
- **Dev auth**: Set `DEV_USER_EMAIL` env var — no oauth2-proxy needed locally
- **Super admin**: `SUPER_ADMIN_EMAILS` env var (comma-separated)

## Architecture

- **Auth**: oauth2-proxy → `X-Forwarded-Email` header → middleware → `getCurrentUser()` DB lookup
- **Proxy**: `src/proxy.ts` (Next.js 16 convention, was middleware.ts). Node.js runtime. Header forwarding only — NO DB imports.
- **Nav**: Async Server Component. NOT a Client Component. NOT a React Context provider.
- **Server Actions**: MUST call `requirePermission()` for all operations. No client-side-only hiding.
- **ML pipeline**: No mock fallback. ML works via `ML_PYTHON_PATH` or it fails with a clear error.

## Conventions

- **Language**: Spanish UI strings (hardcoded, no i18n library). English routes (`/camera-trap/`, `/admin/`).
- **Types**: Use `ActionResult<T>` discriminated union for all action return types.
- **FormData**: No `as string` casts on `FormData.get()` — always type-check properly.
- **DB singleton**: Module-level variable (not `globalThis` only in dev).
- **Permissions**: `requirePermission(projectId, minRole)` for read/write actions. `requireAdmin()` for admin actions.
- **System events instrumentation**: Any server action, background job, cron, or admin-facing mutation should consider calling `recordEvent()` (from `@/lib/system-events`). Default **yes** for: terminal transitions on `processing_jobs` (use `buildJobCompletionEvent(job)` after the DB update), destructive user actions, admin/permission changes, bulk data uploads, cron job completions, external sync runs. Default **no** for: high-frequency per-row reads/writes (verification clicks, autosaves, status-message ticks) — emit one event at the end of the batch/loop instead. New job types must extend `JOB_LABELS` and `AUDIO_JOB_TYPES` in `src/lib/system-events.ts`; the coverage-guard unit test will fail otherwise.

## Commands

```bash
npm run dev          # Start dev server
npm test             # Run Vitest in watch mode
npm run test:run     # Run Vitest once
npm run test:e2e     # Run Playwright E2E tests
npm run test:all     # Run all tests (Vitest + Playwright)
npm run build        # Production build
npm run lint         # ESLint
```

## Docker

```bash
docker compose up                          # Dev mode with hot reload
docker compose -f docker-compose.yml up --build  # Production build
./deploy.sh                                 # Deploy to DigitalOcean
```

ML Python venv is auto-installed via `uv` on first startup into `data/ml-venv/`.
The venv persists across container restarts. Delete `data/ml-venv/` to force reinstall.
ML becomes available ~2-5 min after first boot (runs in background via `docker-entrypoint.sh`).

When working in this project's Docker environment, always verify that file paths resolve correctly inside the container (not just locally), and test builds with `docker compose build` before committing. Be aware that symlinks, named volumes, and standalone builds behave differently than local dev.

## Database

- Schema in `src/db/schema.ts`
- Connection in `src/db/index.ts`
- Push schema: `node scripts/push-schema.mjs`
- Seed dev data: `npx tsx scripts/seed-dev.ts`

### Backups

Hourly automated backups via host cron + SQLite's online backup API. Backups live in `data/backups/` (persisted on host via Docker volume).

```bash
# Manual backup (inside container or via docker compose exec)
node scripts/backup-db.mjs

# From host
docker compose exec -T portal node scripts/backup-db.mjs

# Restore (run from project root on host)
./scripts/restore-db.sh              # Interactive — lists backups to choose from
./scripts/restore-db.sh latest       # Restore most recent backup
./scripts/restore-db.sh portal-2026-02-12T14-00-00.db  # Restore specific backup
```

**Retention**: all hourly backups for 48h, one daily for 7 days, older deleted automatically.

**Cron** runs inside the Docker container via Debian's cron daemon (started by `docker-entrypoint.sh`). Crontab at `scripts/crontab`, installed to `/etc/cron.d/portal-backup`. Timestamps are US Eastern (America/New_York). To check logs: `cat data/backups/cron.log`.

**If restore fails** (portal won't start after restore), the pre-restore copy is at `data/portal.db.pre-restore`:
```bash
cp data/portal.db.pre-restore data/portal.db && docker compose start portal
```

### Corruption Prevention

- `busy_timeout = 5000` — prevents SQLITE_BUSY on concurrent writes
- All bulk operations (finance uploads, climate uploads, ML detections) use transactions
- Graceful shutdown checkpoints WAL on SIGTERM/SIGINT
- Startup integrity check + health report (DB size, WAL size, backup freshness)

When fixing database queries, always check for edge cases where records have NULL foreign keys or were created outside the normal flow (e.g., manual detections with null jobId). Run the fix against real data scenarios, not just the happy path.

## UI Development

- After implementing any UI changes, verify there are no layout regressions (empty space, overflow, alignment shifts) before considering the task complete. Test the component in its full context, not in isolation.
- After implementing any state mutation (deletion, confirmation toggle, processing completion), always ensure the relevant UI caches are invalidated and the UI updates optimistically or refreshes automatically. Check both the immediate component AND related components (e.g., tables, sidebars, history panels) that display derived data.
- **Tables are sortable by default.** Any new data table (or substantial edit to an existing one) must support per-column sorting using the shared `SortIcon` from `@/components/sort-icon`. For SSR/Server Component tables, follow the URL-param pattern in `src/app/research-applications/page.tsx` and `src/app/admin/activity/page.tsx` (`?sortBy=<col>&sortDir=asc|desc`, with a `SORTABLE_COLUMNS` map in the action). For Client Component tables, follow the local-state pattern in `src/app/finance/expenses/expense-table.tsx`. Preserve sort params across pagination and filter changes, and use a stable id tiebreaker in the `orderBy`.

## Git Workflow

- When committing changes, always check `git diff --cached` for unrelated modifications before finalizing. Use `git add -p` (patch staging) when the working tree contains changes from multiple features.

## Audio module

- Audio recordings may be `.wav` or `.flac` after the WAV→FLAC compression rollout. All downstream code (BirdNET, indices, stream route, filename parser, spectrogram) must be extension-agnostic. Compressed audio is bit-identical on decode — analyses produce identical results.
- Compressing a deployment: admin → audio page → row action ("Comprimir a FLAC") OR selection toolbar. Uses the headless `src/lib/audio-compression-core.ts` (auth-agnostic; also callable from `scripts/compress-all-audio.mjs`).
- Reverting: admin → audio page → row action ("Revertir compresión"). Restores from the pinned Drive revision (`audio_files.original_drive_revision_id`).
- Single-flight per deployment: at most one of {birdnet, acoustic_indices, audio_analysis, audio_sync, audio_compression, revert_audio_compression} can be pending/processing at a time. Enforced by `findActiveAudioJob` in `src/lib/job-locks.ts`.
- Global concurrency cap: only ONE `audio_compression` job runs at a time across all deployments. Batch-queued jobs wait their turn.
- Feature flag: `AUDIO_COMPRESSION_ENABLED=true` must be set in production. Pre-replace WAV revisions are pinned with `keepForever=true` while `AUDIO_KEEP_WAV_REVISION_FOREVER` is unset or "true".

## Gotchas

- Server/Client Component imports: Don't import server-only modules in Client Components
- `useActionState` signature: `(prevState, formData) => newState` — prevState is first arg
- FormData checkbox values: `formData.get('field')` returns `"on"` not `true`
- Drizzle singleton: Use module-level `let db` with lazy init, not `globalThis` pattern
- Proxy (was middleware): Keep header forwarding only, no DB imports
- Next.js 16 renamed `middleware.ts` → `proxy.ts` and uses Node.js runtime
- better-sqlite3 transactions are synchronous — never `db.transaction(async (tx) => ...)`. Same gotcha applies to the audio compression processor (uses sequential `await db.update(...)` calls).
