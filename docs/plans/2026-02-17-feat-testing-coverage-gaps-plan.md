---
title: Address Critical Testing Coverage Gaps
type: feat
date: 2026-02-17
---

# Address Critical Testing Coverage Gaps

## Overview

The test suite has 128 passing tests across 9 files, but coverage is narrow. Only 5 of 17 lib modules have tests. Zero server actions (120+ functions across 20 files) and zero API routes (5 files) have dedicated tests. The tests that exist are well-written — the problem is breadth, not quality.

This plan prioritizes by **risk to users and data**, not by line count.

## Current State

| Category | Files | Tests | Coverage |
|---|---|---|---|
| Auth & permissions | 2 | 23 | Good |
| Pure utility functions | 5 | 80 | Good |
| Server actions | 20 | 0 | None |
| API routes | 5 | 0 | None |
| External API clients | 3 | 1 (drive) | Poor |
| ML pipeline | 1 | 0 | None |
| E2E | 2 | 9 | Smoke only |

## Established Testing Conventions

From existing tests, follow these patterns:

- **Pure functions**: Direct import, no mocks. Use `makeRow()`-style factories for complex objects.
- **Server modules**: `vi.mock()` for `next/headers`, `next/navigation`, `server-only`, `@/db`, `@/db/schema`, `drizzle-orm`. Dynamic `await import()` after mocks.
- **Integration**: In-memory SQLite via `better-sqlite3` + Drizzle, `foreign_keys = ON`, fresh DB per test.
- **External APIs**: Mock the SDK (`googleapis`, etc.) at module level, `vi.stubEnv()` for credentials.
- **File naming**: `*.test.ts` for Vitest, `*.spec.ts` for Playwright.
- **Location**: All tests in `tests/unit/` or `tests/integration/`, mirroring `src/` structure (e.g., `tests/unit/lib/`, `tests/unit/app/finance/`).
- **Language**: Spanish UI strings in assertion messages (matching the app).

## Institutional Learnings That Inform Tests

From `docs/solutions/`:
1. **Every server action MUST call `requirePermission()`** — tests must verify this.
2. **API routes need 3 layers**: allowlisted IDs, path traversal protection, project-level auth.
3. **Write-then-clear pattern** for Sheets — destructive op must be second.
4. **Server must re-derive data** from authoritative source, not trust client input.
5. **Token singleton promise** prevents duplicate auth sessions on concurrent requests.
6. **Optimistic locking via hash** — preview-confirm workflows verify hash before commit.

---

## Phase 1: Server Action Permission Guards (Highest Priority)

**Why first**: A missing `requirePermission()` call is a security hole. This is the #1 risk.

**Approach**: Create a lightweight test pattern that verifies every exported server action calls `requirePermission()` or `requireAdmin()` before doing anything else. NOT testing full business logic — just the permission gate.

**Pattern**:
```ts
// Mock getCurrentUser to return null → should redirect
// Mock getCurrentUser to return user without permission → should redirect
// Mock getCurrentUser to return user with permission → should NOT redirect
```

### Files to test

#### `src/app/camera-trap/actions.ts` → `src/app/camera-trap/__tests__/actions-permissions.test.ts`
- ~57 exported functions, all should require `camera-trap` project permission
- Group by required role: viewer (read ops), editor (write ops), admin (delete ops)

#### `src/app/admin/actions.ts` → `src/app/admin/__tests__/actions-permissions.test.ts`
- ~7 exported functions, all should require `requireAdmin()`

#### `src/app/biochoco/tools/actions.ts` → `src/app/biochoco/tools/__tests__/actions-permissions.test.ts`
- Schedule editing functions, should require `biochoco` editor

#### `src/app/biochoco/habitat/actions.ts`, `overview/actions.ts`, `data/actions.ts`
- Read-heavy actions, should require `biochoco` viewer minimum

#### `src/app/finance/*/actions.ts`
- Upload/commit functions should require editor; read functions require viewer

#### `src/app/climate/actions.ts`
- Upload/commit requires editor; chart/summary queries require viewer

#### `src/app/giz/*/actions.ts`
- Read-only actions, require viewer

### Shared test helper

Create `tests/helpers/action-permission-helper.ts`:
- A reusable `setupActionMocks()` function that sets up the standard `next/headers`, `next/navigation`, `server-only`, `@/db` mocks
- A `testRequiresPermission(actionFn, projectId, minRole)` helper that tests unauthorized → redirect, authorized → no redirect
- Avoids copy-pasting the same 40 lines of mock setup into every test file

### Acceptance Criteria
- [x] Every exported `"use server"` function has a permission guard test
- [x] Tests verify redirect on missing/insufficient permission
- [x] Tests verify no redirect on sufficient permission
- [x] Shared helper avoids mock duplication

---

## Phase 2: API Route Security Tests

**Why second**: API routes are publicly reachable HTTP endpoints. Permission bypass = data leak.

### `src/app/api/odk/photos/route.ts` → `tests/integration/api-odk-photos.test.ts`
- Test allowlisted project/form IDs accepted
- Test non-allowlisted IDs rejected (403)
- Test path traversal (`../`, `\`, `..%2F`) rejected
- Test missing auth header returns 401
- Test user without project permission returns 403
- Test valid request proxies to ODK and returns image

### `src/app/api/ct-images/[id]/route.ts` → `tests/integration/api-ct-images.test.ts`
- Test auth required
- Test image ID validation
- Test cache headers on response

### `src/app/api/active-jobs/route.ts` → `tests/unit/api-active-jobs.test.ts`
- Test returns only user's jobs (permission filtering)

### `src/app/api/progress/route.ts`
- SSE endpoint — harder to test. Defer to Phase 5 or E2E.

### `src/app/api/images/[...path]/route.ts`
- Filesystem image serving — test path traversal protection

### Pattern for API route tests

Use Vitest with manual `Request` objects (not a test HTTP client) since Next.js route handlers accept `Request` and return `Response`:

```ts
import { GET } from "@/app/api/odk/photos/route";

it("rejects unauthenticated requests", async () => {
  const req = new Request("http://localhost/api/odk/photos?...");
  const res = await GET(req);
  expect(res.status).toBe(401);
});
```

### Acceptance Criteria
- [x] All 5 API routes have auth tests
- [x] Path traversal protection verified on routes accepting user-supplied paths
- [x] Allowlist enforcement verified on ODK photo route

---

## Phase 3: Camera Trap Core Business Logic

**Why third**: This is the most complex feature with the most code. The verification workflow (verify/reject/correct species assignments) is the core business logic that users depend on daily.

### `src/app/camera-trap/__tests__/actions-verification.test.ts`
Test the verification workflow functions with mocked DB:
- `verifyIdentification()` — marks detection as verified, updates stats
- `rejectIdentification()` — marks as rejected
- `correctIdentification()` — changes species, marks as verified
- `bulkVerify()` — batch verification
- `bulkVerifyByThreshold()` — threshold-based auto-verify
- `assignSpecies()` — manual species assignment
- `createManualDetection()` — manual detection creation
- `deleteDetection()` — cascade behavior

### `src/app/camera-trap/__tests__/actions-jobs.test.ts`
Test job lifecycle:
- `createProcessingJob()` — creates job with correct initial state
- `processJob()` — state transitions (pending → processing → complete/failed)
- `cancelJob()` — can only cancel pending/processing jobs
- `deleteJob()` — cascade deletes detections/identifications

### `src/app/camera-trap/__tests__/actions-deployments.test.ts`
Test deployment CRUD:
- `updateDeploymentMetadata()` — field updates
- `bulkUpdateMetadata()` — batch updates
- `deleteDeployments()` — cascade behavior

### Acceptance Criteria
- [x] Verification workflow has tests for verify/reject/correct paths
- [x] Job state machine transitions tested
- [x] Cascade deletes verified
- [x] Bulk operations tested with edge cases (empty arrays, duplicates)

---

## Phase 4: External API Clients

**Why fourth**: These are integration boundaries where bugs are hardest to debug.

### `src/lib/__tests__/odk-client.test.ts`
Mock `fetch` calls to ODK Central:
- `fetchEntities()` — pagination, empty results, API errors
- `fetchSubmissions()` — filtering, pagination
- `fetchAttachment()` — binary response, 404 handling
- Token refresh — singleton promise prevents duplicate auth requests
- Network errors — timeout, 500, connection refused

### `src/lib/__tests__/sheets-client.test.ts`
Mock `googleapis` Sheets API:
- `loadSchedule()` — parse sheet data into ScheduleRow objects
- `saveSchedule()` — write-then-clear ordering verified
- `updateScheduleRows()` — partial updates
- Error handling — API quota errors, expired credentials
- Verify write-then-clear: write must happen before clear (institutional learning)

### `src/lib/__tests__/ml-runner.test.ts`
Mock Python subprocess execution:
- `runObjectDetection()` — spawns correct Python command, parses output
- `runSpeciesClassification()` — same
- Error handling — Python not found, script crash, malformed output
- Timeout handling for long-running jobs

### Acceptance Criteria
- [x] ODK client tests cover pagination, errors, and token refresh
- [x] Sheets client tests verify write-then-clear ordering
- [x] ML runner tests cover success, failure, and timeout paths

---

## Phase 5: Error Path & Edge Case Tests

**Why fifth**: Once happy paths are covered, harden with failure scenarios.

### Auth edge cases in `tests/unit/auth.test.ts`
- Concurrent `getCurrentUser()` calls (race condition on lastSeenAt update)
- Malformed email header (spaces, special characters)
- DB connection failure during user lookup

### Camera trap edge cases
- Species deletion when species is assigned to detections
- Job cancellation during active ML processing
- Image annotation with invalid bounding box coordinates
- Deployment deletion with in-progress jobs

### Finance edge cases
- Upload with malformed CSV data
- Budget calculations with zero/negative values
- Transaction classification with unknown account codes

### Climate edge cases
- Upload with duplicate timestamps
- Parser with corrupted TOA5 headers
- Data outside valid ranges (temperature > 100C, etc.)

### Acceptance Criteria
- [ ] Each module has at least 2-3 error path tests
- [ ] Tests verify error messages are user-friendly (Spanish)
- [ ] No uncaught exceptions on invalid input

---

## Phase 6: E2E Expansion (Lower Priority)

**Why last**: Unit/integration tests catch most bugs. E2E tests are for workflow validation.

### Camera trap annotation workflow (`tests/e2e/camera-trap-annotation.spec.ts`)
- Navigate to deployment → view images → annotate → verify
- Test keyboard shortcuts for annotation

### Non-admin user scenarios (`tests/e2e/permissions-viewer.spec.ts`)
- Viewer can see results but not edit
- Editor can annotate but not delete deployments
- Currently only super_admin is tested

### Finance upload workflow (`tests/e2e/finance-upload.spec.ts`)
- Upload Libro Mayor → preview → commit

### Acceptance Criteria
- [ ] Core annotation workflow covered end-to-end
- [ ] At least one non-admin user scenario tested
- [ ] Upload → preview → commit pattern tested for one module

---

## Out of Scope

- **Component tests** (React Testing Library): The app is server-component heavy with minimal client interactivity. E2E tests cover this better.
- **Snapshot tests**: Fragile and low value for this codebase.
- **Performance tests**: Important but a separate initiative.
- **CI/CD setup**: No GitHub Actions exist yet. Worth doing but separate from test writing.

## Implementation Notes

- **Estimated effort**: Phase 1-2 are the highest-value, lowest-effort work. Each can be done in a session. Phase 3-4 are medium effort. Phase 5-6 are ongoing.
- **No new dependencies needed**: All patterns use existing Vitest + better-sqlite3 + vi.mock.
- **Shared helper in Phase 1** pays off immediately across all action test files.
- **Run `npm run test:run` after each phase** to verify no regressions.
