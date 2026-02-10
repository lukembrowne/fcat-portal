---
title: "Fix 12 code review findings from Phase 2 GIZ/BioChoco merge"
date: 2026-02-09
category: security-issues
tags:
  - requirePermission
  - server-actions
  - data-integrity
  - input-validation
  - ActionResult
  - pagination
  - race-condition
  - optimistic-locking
  - useMemo
  - odk-central
module:
  - biochoco/tools
  - biochoco/overview
  - giz/tree-planting
  - giz/cacao-monitoring
  - lib/odk-client
  - lib/sheets-client
  - api/odk/photos
severity: critical
symptoms:
  - Server actions callable without authorization
  - Schedule data loss possible on crash during save
  - Client can inject arbitrary sync data to Sheets
  - Photo proxy allows access to any ODK project
  - Duplicate weaker ActionResult type definition
  - Entity/repeat data silently truncated at 250 records
  - Concurrent requests create duplicate auth sessions
  - Preview-confirm workflow vulnerable to TOCTOU race
verified: true
---

# Fix 12 Code Review Findings from Phase 2 Merge

## Problem

A multi-agent code review of the Phase 2 merge (030b761 — Port GIZ and BioChoco dashboards from Streamlit, 66 files, ~7000 LOC) identified 12 findings: 3 critical, 5 important, 4 nice-to-have.

## Root Cause

The dashboards were ported from Streamlit (single-user, no auth model) to Next.js server actions (multi-user, needs explicit auth). Several Streamlit assumptions carried over: no per-action auth, trusting client data, no concurrency protection.

## Solution

### P1-1: Missing requirePermission() on server actions

**Pattern:** Pages had `requirePermission()` but server actions did not. Since server actions are callable directly from the client, every exported action needs its own auth check.

```ts
// Before: only getCurrentUser() or nothing
export async function commitBulkShift(...) {
  const user = await getCurrentUser();
  if (!user) return { success: false, error: "No autenticado" };

// After: requirePermission() enforces project+role
export async function commitBulkShift(...) {
  const user = await requirePermission("biochoco", "editor");
```

Applied to all 15 server actions across 4 files: biochoco tools (10), GIZ tree-planting (1), GIZ cacao-monitoring (1), biochoco overview (1).

### P1-2: Atomic saveSchedule (write-then-clear)

**Pattern:** Two-phase Sheets API writes should put the destructive step second.

```ts
// Before: clear-then-write (crash between = total data loss)
await sheets.spreadsheets.values.clear({ ... });
await sheets.spreadsheets.values.update({ ... });

// After: write-then-clear (crash between = stale rows, recoverable)
await sheets.spreadsheets.values.update({ range: "Sheet1!A1", ... });
if (oldRowCount > newRowCount) {
  await sheets.spreadsheets.values.clear({ range: `Sheet1!A${newRowCount + 1}:...` });
}
```

### P1-3: Server-side re-verification for commitSyncOdk

**Pattern:** Never trust client-supplied data for writes. Re-derive on commit.

```ts
// Before: client sends full SyncUpdate[] with arbitrary status/dates
export async function commitSyncOdk(updates: SyncUpdate[]) { ... }

// After: client sends only deployment IDs; server re-derives from ODK
export async function commitSyncOdk(deploymentIds: string[]) {
  const allUpdates = await deriveSyncUpdates(); // server-side truth
  const updates = allUpdates.filter((u) => confirmedSet.has(u.deploymentId));
```

### P2-4: Photo proxy hardening

Added three layers of protection to `api/odk/photos/route.ts`:

1. **Allowlists** — Only known ODK project IDs and form IDs accepted
2. **Path traversal protection** — Reject params containing `/`, `\`, or `..`
3. **Project-level auth** — Map ODK project ID to internal project, check user permissions

### P2-5: Shared ActionResult discriminated union

Replaced local `interface ActionResult<T> { success: boolean; data?: T; error?: string }` with shared type from `@/lib/types.ts`. Key difference: shared type uses `success: true` literal (not `boolean`), enabling proper TypeScript narrowing.

```ts
// Before: broken narrowing
if (result.success && result.data) { ... }
else { setError(result.error ?? "fallback"); } // TS error: error not on type

// After: proper discriminated union narrowing
if (result.success) { setPreview(result.data); }
else { setError(result.error); }
```

### P2-6: Pagination for fetchEntities and fetchRepeatData

ODK Central OData endpoints return max 250 items per page. Added the same `$top/$skip` pagination loop already used in `fetchSubmissions`.

### P2-7: Token singleton promise

```ts
// Before: concurrent requests each trigger separate POST /v1/sessions
let cachedToken = null;
async function getSessionToken() {
  if (cachedToken && ...) return cachedToken.token;
  const res = await fetch(...); // N concurrent calls = N auth requests

// After: singleton promise deduplicates in-flight requests
let pendingTokenRequest: Promise<string> | null = null;
async function getSessionToken() {
  if (cachedToken && ...) return cachedToken.token;
  if (pendingTokenRequest) return pendingTokenRequest;
  pendingTokenRequest = (async () => { ... finally { pendingTokenRequest = null; } })();
  return pendingTokenRequest;
```

### P2-8: Optimistic locking via schedule hash

Preview computes a SHA-256 hash of key schedule fields, returns it to client. Commit re-reads schedule, recomputes hash, rejects if it changed.

```ts
function scheduleHash(rows: ScheduleRow[]): string {
  const content = JSON.stringify(rows.map((r) => [r.deploymentId, r.status, r.plannedDeployDate, r.plannedRetrieveDate]));
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

### P3-9 through P3-12: Enhancements

- **Dead metrics prop**: Removed unused `metrics` prop from GIZ dashboard shells (only `filteredMetrics` was used)
- **useMemo filter lists**: Wrapped `[...new Set(data.map(...))]` computations in `useMemo()`
- **ODK constants**: Created `src/lib/odk-constants.ts` centralizing project/form/dataset IDs
- **Calendar hoisting**: Pre-compute `generateWorkingCalendar()` once before loops in `shiftSchedule` and `addSiteToSchedule`

## Files Changed

22 files, 375 insertions, 197 deletions. Key files:
- `src/app/biochoco/tools/actions.ts` — auth, type, sync re-verify, optimistic locking
- `src/lib/odk-client.ts` — pagination, token singleton
- `src/lib/sheets-client.ts` — write-then-clear
- `src/app/api/odk/photos/route.ts` — allowlists, path traversal, project auth
- `src/lib/odk-constants.ts` — new file for centralized IDs

## Prevention

1. **Auth on actions**: CLAUDE.md rule: "Server Actions MUST call requirePermission()". Treat every exported `"use server"` function as a public endpoint.
2. **Multi-step API writes**: Always put the destructive operation last. If you must clear-and-rewrite, write first, clear leftovers after.
3. **Client data for writes**: Never use client-supplied data directly for mutations. Re-derive from authoritative source, use client input only as confirmation/filter.
4. **New API routes**: Check against an allowlist of valid IDs, validate for path traversal, enforce project-level permissions.
5. **Shared types**: Import `ActionResult<T>` from `@/lib/types.ts`. Never define local variants. Check `result.success` alone for proper narrowing.
6. **Pagination**: Any OData endpoint returning arrays may paginate at 250. Always use `$top/$skip` loops.
7. **Concurrency**: Use singleton promise for shared tokens. Use optimistic locking (hash at preview, verify at commit) for preview-confirm workflows.
8. **React memo**: Memoize derived lists (`useMemo`) when the source data prop is stable but the component re-renders due to other state changes.

## Related

- `docs/solutions/integration-issues/nextjs16-middleware-to-proxy-migration.md`
- CLAUDE.md conventions: requirePermission, ActionResult, proxy constraints
