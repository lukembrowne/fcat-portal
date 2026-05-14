---
title: feat — Unified system activity log
type: feat
date: 2026-05-13
brainstorm: docs/brainstorms/2026-05-13-unified-system-activity-log-brainstorm.md
review_notes: |
  Revised 2026-05-13 after parallel review by DHH/Kieran/Simplicity reviewers.
  Cuts applied: correlationId column, actorType column, activity_log table drop,
  activity_log row backfill, processingJobs lifecycle backfill, the setJobStatus
  wrapper and 40-site runner rewrite (entire Phase 3 deferred), and four of six
  indexes. Phase 1 now ships with two real cron writers, not an empty page.
  Estimate moved from ~3.5 days to ~1.5 days.
---

# feat: Unified System Activity Log

## Overview

A new `system_events` table and an admin-only page at `/admin/activity` that surfaces the events nobody can see today: cron runs, admin actions, finance/climate uploads, ODK syncs. The existing `activity_log` writers (~12 sites in camera-trap, audio, biochoco) are redirected to `recordEvent(...)`, the new write path. **The old `activity_log` table is left in place** — it has no UI readers, hourly backups protect the data, and dropping it is pure churn.

**Job lifecycle is explicitly out of scope.** The "Trabajos de ML" page already shows started/processing/completed/failed status across ML, BirdNET, audio compression, and audio sync. The activity page links to it rather than duplicating rows. If demand for in-line job events emerges, that's a future plan with its own design.

The Pino log stream at `/admin/logs` is untouched. It remains the deep-debug surface for raw stdout/stderr.

## Problem Statement

Three blind spots today:
1. **Cron runs** (hourly backup, nightly BioChoco refresh, daily reminders, monthly digest) write to log files only. "Did the nightly run actually happen Tuesday?" requires grepping `cron.log`.
2. **Admin actions** (user added/removed, role changes, project create/delete) are not logged anywhere. `src/app/admin/actions.ts:47–393` has zero `activityLog.insert(...)` calls.
3. **Finance/climate uploads, ODK syncs** — no audit record.

A secondary problem: the `activity_log` table is write-only with no UI. Anyone wanting to consult the existing 12 logged actions has to run SQL. Giving these events a home page is most of the user-visible value.

## Proposed Solution

A new `system_events` table, slimmer than the previous draft. Single helper `recordEvent(...)` for writes. A page that does paginated filtered reads. Three new phases of work covering the three blind spots above. No table migrations, no runner rewrites, no backfills.

## Technical Approach

### Schema (`src/db/schema.ts`)

Insert immediately after the existing `activityLog` definition (currently line 492):

```ts
// src/db/schema.ts
export const EVENT_SOURCES = [
  "admin",
  "audio",
  "biochoco-tools",
  "biochoco-resultados",
  "camera-trap",
  "climate",
  "cron",
  "finance",
  "odk",
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_SEVERITIES = ["info", "success", "warn", "error"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const systemEvents = sqliteTable(
  "system_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: integer("occurred_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    severity: text("severity", { enum: EVENT_SEVERITIES })
      .notNull()
      .default("info"),
    actorEmail: text("actor_email"), // null → system/cron event
    projectId: text("project_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    summary: text("summary").notNull(),
    durationMs: integer("duration_ms"),
    details: text("details"), // JSON
  },
  (t) => ({
    occurredAtIdx: index("system_events_occurred_at_idx").on(t.occurredAt),
    sourceIdx: index("system_events_source_idx").on(t.source),
    eventTypeIdx: index("system_events_event_type_idx").on(t.eventType),
  }),
);
```

**What changed from the first draft and why:**
- **Cut `correlationId`** — unused in v1, add via `ALTER TABLE` when needed.
- **Cut `actorType`** — derivable from `actorEmail IS NULL`.
- **Cut `jobId`** — Phase 3 (job lifecycle) deferred; the column had no callers. If a phase emits an event about a specific job, set `targetType='job'` and `targetId=<jobId>`.
- **Renamed `module` → `source`** — `module` is JS-keyword-y and trips autocomplete; `source` answers "where did this event come from?" directly.
- **Three indexes, not six** — `occurredAt DESC` for default page, `source` and `eventType` for the most common filters. Add more after observing actual slow queries.
- **`as const` string-literal unions** for `EVENT_SOURCES` and `EVENT_SEVERITIES` — the TypeScript wins catch source-string typos across many writers.

Add corresponding `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` entries to `scripts/push-schema.mjs`.

### Helper API (`src/lib/system-events.ts`)

```ts
// src/lib/system-events.ts
import { db } from "@/db";
import { systemEvents, type EventSeverity, type EventSource } from "@/db/schema";
import { logger } from "@/lib/log";

export type RecordEventInput = {
  source: EventSource;          // typed — catches typos
  eventType: string;            // free string; conventions documented in code comments
  summary: string;              // short human string; shown verbatim in the row
  severity?: EventSeverity;     // default "info"
  actorEmail?: string | null;   // null = system / cron event
  projectId?: string | null;
  targetType?: string | null;
  targetId?: string | number | null;
  durationMs?: number | null;
  details?: Record<string, unknown> | null;
  occurredAt?: Date;            // if omitted, DB default `unixepoch()` fires
};

export async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    await db.insert(systemEvents).values({
      source: input.source,
      eventType: input.eventType,
      summary: input.summary,
      severity: input.severity ?? "info",
      actorEmail: input.actorEmail ?? null,
      projectId: input.projectId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId == null ? null : String(input.targetId),
      durationMs: input.durationMs ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
      // occurredAt deliberately omitted — let the DB default fire when caller doesn't pass one
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  } catch (err) {
    // Never throw — a dropped event must not break the caller's flow.
    logger.warn({ err, input }, "recordEvent_failed");
  }
}
```

**Notes:**
- Fire-and-forget safety: `recordEvent` logs at `warn`, not `error` (Kieran's correction — a dropped event isn't an error from the caller's perspective).
- `occurredAt` default cleanly delegates to the DB when omitted (Kieran flagged the prior conflict).
- `?? null` everywhere — Drizzle drops `undefined` (MEMORY.md).
- `targetId` normalized to text.

### Page UI (`src/app/admin/activity/`)

```
src/app/admin/activity/
├── page.tsx            # Server Component; requireAdmin(); first page + filter form
└── actions.ts          # listEvents server action (filtered, paginated)
```

That's it. Two files. No `row-detail.tsx`, no `filters.tsx` client component:
- Filter form is a plain `<form method="GET">` that updates URL query params (Spanish strings, project convention). Filters: `source`, `eventType`, `severity`, `actorEmail`, date range, free-text on `summary`.
- Pagination: `OFFSET/LIMIT` page size 50, with prev/next links. Cursor pagination is overkill at this scale.
- Each row's `details` JSON expands inline via a native `<details>` element — no React component needed.
- Server action returns rows as POJOs with ISO-string timestamps (Server→Client serialization gotcha — `MEMORY.md`).
- Job-related events (when an admin action targets a job, etc.) deep-link to `/camera-trap/results` for full lifecycle context.

### Implementation Phases

#### Phase 1: Schema + helper + page, shipped with real writers (½ day)

The page must show real rows on first deploy. To guarantee that, Phase 1 includes wiring the two highest-value writers immediately.

**Deliverables:**
- `systemEvents` schema in `src/db/schema.ts` + migration entries in `scripts/push-schema.mjs`.
- `recordEvent` helper in `src/lib/system-events.ts`.
- `/admin/activity` page (server component, GET-form filters, OFFSET/LIMIT, `<details>` JSON, Spanish strings, `requireAdmin()` gate, nav link in admin sidebar).
- Wire `recordEvent` into **two cron writers** so day-one rows exist:
  - `src/app/api/cron/nightly-refresh/route.ts` — emit `cron_nightly_refresh` with duration, status, project-level counts.
  - `scripts/backup-db.mjs` — emit `cron_db_backup` with duration, backup filename, file size. (Script already imports `better-sqlite3` and can import `recordEvent` from `src/lib/system-events.ts` directly.)
- Unit test: `recordEvent` swallows errors, normalizes `undefined → null`, persists timestamps correctly.

**Success criteria:**
- After `docker compose up`, the page renders. The backup cron runs within an hour and a row appears. The nightly refresh runs (or is triggered manually) and a second row appears.

#### Phase 2: Redirect existing `activity_log` writers (½ day)

**Deliverables:**
- Replace every `db.insert(activityLog).values(...)` with `recordEvent(...)`:
  - `src/app/biochoco/tools/actions.ts` (4 sites: schedule_shift, schedule_swap, schedule_add_site, schedule_sync_odk)
  - `src/app/biochoco/resultados/actions.ts` (2 sites: create_site_share_link, revoke_site_share_link)
  - `src/app/camera-trap/actions.ts` (~11 sites — verify with `rg activityLog src/app/camera-trap/`)
  - `src/app/audio/actions.ts` (1 site: audio_compression phase result)
- Each replacement gets the right `source` and a `summary` string in Spanish.
- **`activity_log` table is NOT dropped.** It stops receiving new writes; existing rows remain. The schema file keeps its definition. Revisit after 6 months of unused-by-writers existence.

**Success criteria:**
- `rg "db\.insert\(activityLog\)" src/` returns zero results.
- Existing actions that were previously logged continue producing observable events — now on the activity page instead of going to a no-UI table.

#### Phase 3: Cover the actual gaps (½ day)

**Deliverables:**
- **Admin actions** (`src/app/admin/actions.ts`): emit `recordEvent` from `addUser`, `removeUser`, `setPermission`, `removePermission`, `createCameraTrapProject`, `updateCameraTrapProject`, `deleteCameraTrapProject`, `setCameraTrapProjectAccess`. Permission changes include old → new role in `details`.
- **Remaining cron routes:**
  - `src/app/api/cron/research-reminders/route.ts` — `cron_research_reminders` with email count.
  - `src/app/api/cron/committee-monthly-digest/route.ts` — `cron_committee_digest`.
- **Finance uploads** (`src/app/finance/data/actions.ts` and siblings): one event per upload with filename + row count.
- **Climate uploads** (`src/app/climate/upload/actions.ts` and siblings): same.
- **ODK sync entry point** (locate in biochoco-tools or a cron route): emit `odk_sync` with form-level counts.

**Success criteria:**
- Admin permission/project changes show up live on `/admin/activity` with old → new visible in the expanded JSON.
- All four cron schedules produce one row per run.
- Finance and climate uploads produce one row per upload.

### Explicitly out of scope (deferred to a separate plan, if/when needed)

- **Job lifecycle events.** Started/completed/failed transitions are already visible on "Trabajos de ML" at `/camera-trap/results`. The activity page links to it. Adding redundant rows would have required centralizing 40+ runner sites behind a wrapper — high risk for marginal gain. If a real need emerges (e.g., wanting failed jobs in the same severity filter as other errors), revisit.
- **Backfilling existing `activity_log` rows into `system_events`.** Forward-only is fine.
- **Dropping the `activity_log` table.** Leave it. Re-evaluate in 6 months.
- **Auto-promoting Pino `warn`/`error` log lines** to events. Too noisy without severity-class filtering.
- **SSE / streaming updates.** Refresh button + GET-form filters are sufficient.
- **Saved-filter URL params beyond the basic GET-form behavior.** Already free from using `<form method="GET">`.
- **CSV export, webhooks, retention cron, per-project editor view.** All YAGNI for v1.

## Alternative Approaches Considered

| Approach | Verdict |
|----------|---------|
| **Extend `activity_log` in place** (add `severity` + `durationMs`, build the page on top of it) | Simplest. Rejected because `as const` typed sources catch typo drift across the ~12 existing writers + new ones; refactoring the table column-by-column risks ALTER-TABLE gotchas (documented). New table is cleaner for the same total work. |
| **Read-time UNION of `activity_log` + `processingJobs`** | Gnarly query, gnarlier pagination, and most of the user value (cron + admin coverage) requires new writes anyway. (Brainstorm Approach A — rejected there too.) |
| **Centralize job transitions via a `setJobStatus` wrapper across 40 runner sites** | Original plan included this. Cut after review: job lifecycle is already visible on a different page; the rewrite is high-risk for redundant data. Available as a future plan. |
| **Migrate + drop `activity_log`** | Original plan included this. Cut after review: zero readers, hourly backups, pure churn. |

## Acceptance Criteria

### Functional

- [ ] `system_events` table exists; `push-schema.mjs` creates it on fresh and existing DBs.
- [ ] `recordEvent(...)` helper exists, is the single write path, and never throws.
- [ ] `/admin/activity` page renders for admins; filters work; pagination works; row JSON expands.
- [ ] Every existing `activity_log` writer is redirected to `recordEvent`.
- [ ] All four cron schedules emit one event per run.
- [ ] Admin user/permission/project actions emit events (old → new in `details` for role changes).
- [ ] Finance and climate uploads emit events.
- [ ] ODK sync emits events.

### Non-Functional

- [ ] Page renders Spanish UI strings.
- [ ] Server→Client transform converts Date → ISO string.
- [ ] First page <100ms on 100k rows (covered by the `occurredAt` index).
- [ ] `recordEvent` failures log at `warn`, never propagate.
- [ ] Source strings are constrained by the `EVENT_SOURCES` typed union — typos fail at compile time.

### Quality Gates

- [ ] Unit test: `recordEvent` minimum-input + all-fields-set + error-swallow paths.
- [ ] Manual smoke: trigger backup cron, trigger nightly refresh manually, delete a deployment, change a permission — all four show up on the page.

## Success Metrics

- "Did the nightly refresh run last Tuesday?" answerable in seconds via filter, not minutes via `grep cron.log`.
- 100% of cron schedules + 100% of admin destructive actions covered by events at the end of Phase 3.

## Dependencies & Risks

| Risk | Mitigation |
|------|-----------|
| `recordEvent` accidentally throws and breaks a caller | `try/catch + logger.warn`. Add a unit test that forces a DB error and asserts the caller still completes. |
| Source string typos in `recordEvent` calls | `EVENT_SOURCES` as a typed `as const` union — compile error if misspelled. |
| Drizzle `sql` template drops `undefined` | Helper uses `?? null` everywhere. Add a test that calls with every optional undefined. |
| Server→Client Date serialization | Server action transforms to POJOs with ISO strings before return. |
| `scripts/backup-db.mjs` can't cleanly import `recordEvent` | The script already uses `better-sqlite3`; it imports from `src/db/`. Confirm during Phase 1; fallback is an HTTP call to a `/api/cron/record-event` endpoint, but expected unnecessary. |
| Future need for job lifecycle / `correlationId` / `actorType` | All recoverable via `ALTER TABLE` later. Schema is designed to grow, not to predict. |

## Open Questions (low-priority)

1. **`eventType` conventions.** Free string for now. If naming drifts (e.g., `delete_deployment` vs `deployment_deleted`), tighten via a typed constant set in a follow-up. Not blocking.
2. **`details` JSON validation.** Currently trusted. If a malformed row makes debugging hard, add a runtime `JSON.parse` smoke test in the helper or a CHECK constraint in a later migration.
3. **24h "new events" badge on the admin nav.** Defer. Adds a count query on every render.

## Resource Requirements

~1.5 engineer-days total across three phases. No new dependencies. Fully additive (new table, no schema changes to existing tables).

## Documentation Plan

- Add a brief paragraph to `CLAUDE.md` ("any new background work should emit events via `recordEvent`").
- Add Spanish strings to whatever wording file or pattern other admin pages use (matches `/admin/logs`).

## References

### Internal references

- Schema: `src/db/schema.ts:212` (`processingJobs`), `src/db/schema.ts:481` (`activityLog`). New `systemEvents` goes at line ~493.
- Existing log viewer: `src/app/admin/logs/page.tsx`, `src/app/admin/logs/logs-viewer-client.tsx`.
- `activityLog` writers to redirect:
  - `src/app/biochoco/tools/actions.ts` (4 sites)
  - `src/app/biochoco/resultados/actions.ts` (2 sites)
  - `src/app/camera-trap/actions.ts` (~11 sites — verify with `rg`)
  - `src/app/audio/actions.ts` (1 site)
- Admin actions to instrument: `src/app/admin/actions.ts:47–393`.
- Cron routes: `src/app/api/cron/nightly-refresh/route.ts`, `.../research-reminders/route.ts`, `.../committee-monthly-digest/route.ts`.
- Cron script: `scripts/backup-db.mjs`.
- Pino logger: `src/lib/log.ts`.
- Schema-push entry point: `scripts/push-schema.mjs`.

### Brainstorm + review trail

- `docs/brainstorms/2026-05-13-unified-system-activity-log-brainstorm.md` — original design dialogue.
- Reviewer feedback applied: cut `correlationId`, `actorType`, `jobId`, `setJobStatus` wrapper, table drop, backfills, four indexes. Renamed `module → source`. Phase 1 now ships with two real writers.

### Conventions

- `CLAUDE.md` — Spanish UI strings, `requireAdmin` for admin pages, no Date objects across Server→Client boundary.
- `MEMORY.md` — Drizzle `?? null` discipline; better-sqlite3 sync transactions (irrelevant for single inserts); Server→Client serialization gotcha.
