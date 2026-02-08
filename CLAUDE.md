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
- **Middleware**: Edge runtime ONLY — NO DB imports. Header forwarding only.
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
npm run build        # Production build
npm run lint         # ESLint
```

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
- Middleware is Edge runtime: Cannot import `better-sqlite3` or any Node.js-only modules
