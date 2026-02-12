# FCAT Portal — Project Conventions

## Overview

Internal web application for FCAT staff and collaborators. Replaces Streamlit dashboards at `internal.dashboards.fcat-ecuador.org`. Domain: `portal.fcat-ecuador.org`.

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

## Database

- Schema in `src/db/schema.ts`
- Connection in `src/db/index.ts`
- Push schema: `node scripts/push-schema.mjs`
- Seed dev data: `npx tsx scripts/seed-dev.ts`

## Gotchas

- Server/Client Component imports: Don't import server-only modules in Client Components
- `useActionState` signature: `(prevState, formData) => newState` — prevState is first arg
- FormData checkbox values: `formData.get('field')` returns `"on"` not `true`
- Drizzle singleton: Use module-level `let db` with lazy init, not `globalThis` pattern
- Proxy (was middleware): Keep header forwarding only, no DB imports
- Next.js 16 renamed `middleware.ts` → `proxy.ts` and uses Node.js runtime
