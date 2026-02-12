# FCAT Portal — Project Conventions

## Overview

Internal web application for FCAT staff and collaborators. Replaces Streamlit dashboards at `internal.dashboards.fcat-ecuador.org`. Domain: `portal.fcat-ecuador.org`.

## Environment

- **Node version**: 22 (required for `better-sqlite3` native module compatibility)
- **Database**: SQLite at `data/portal.db`, WAL mode, singleton connection
- **ML Python venv**: Lives on the HOST, not in Docker. Mounted as read-only volume. If the host is rebuilt, ML silently breaks.
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

CRITICAL: ML Python venv is mounted from the host as a read-only volume.
It is NOT included in the Docker image. If the host is rebuilt without
reinstalling the venv, the ML pipeline will silently fail.

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

**Cron** runs inside the Docker container via Alpine's crond (started by `docker-entrypoint.sh`). Crontab at `scripts/crontab`, installed to `/etc/crontabs/nextjs`. To check logs: `cat data/backups/cron.log`.

**If restore fails** (portal won't start after restore), the pre-restore copy is at `data/portal.db.pre-restore`:
```bash
cp data/portal.db.pre-restore data/portal.db && docker compose start portal
```

### Corruption Prevention

- `busy_timeout = 5000` — prevents SQLITE_BUSY on concurrent writes
- All bulk operations (finance uploads, climate uploads, ML detections) use transactions
- Graceful shutdown checkpoints WAL on SIGTERM/SIGINT
- Startup integrity check + health report (DB size, WAL size, backup freshness)

## Gotchas

- Server/Client Component imports: Don't import server-only modules in Client Components
- `useActionState` signature: `(prevState, formData) => newState` — prevState is first arg
- FormData checkbox values: `formData.get('field')` returns `"on"` not `true`
- Drizzle singleton: Use module-level `let db` with lazy init, not `globalThis` pattern
- Proxy (was middleware): Keep header forwarding only, no DB imports
- Next.js 16 renamed `middleware.ts` → `proxy.ts` and uses Node.js runtime
