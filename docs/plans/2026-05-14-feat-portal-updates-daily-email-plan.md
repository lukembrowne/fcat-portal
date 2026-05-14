---
title: Add daily portal updates email
type: feat
date: 2026-05-14
brainstorm: docs/brainstorms/2026-05-14-portal-updates-daily-email-brainstorm.md
---

# feat: Add daily portal updates email

## Overview

Add a second daily cron-driven email — separate from the existing BioChoco "data uploads" digest — that summarizes the past 24 hours of portal *analysis* activity grouped by project: camera-trap ML jobs completed, camera-trap images verified, audio jobs completed, and audio recordings/files verified. Each project section includes a mini "top verificadores" leaderboard so the people doing annotation work get visible recognition.

The route mirrors `/api/cron/nightly-refresh` and `/api/cron/research-reminders`. **No schema changes** — all data already exists in `processing_jobs`, `system_events`, `identifications.verifiedAt`, `audio_identifications.verifiedAt`.

## Problem Statement

Today, the portal sends one nightly email about *Drive uploads* (raw data ingestion). It has no email surfacing **what's happening with the data once it's in the portal** — ML processing runs, verification work by annotators, audio analysis. PIs and admins lack a daily heartbeat showing analytical progress, and annotators get no recognition for their verification work.

## Proposed Solution

A new cron route `POST /api/cron/portal-updates` that:

1. Authenticates via `verifyCronSecret(request)` (existing pattern).
2. Aggregates 24-hour activity per project across four categories.
3. Builds an HTML email with one section per project (skipping projects with zero activity), each section showing job counts and a top-3 verificadores leaderboard.
4. Sends via Resend to recipients in a new env var `PORTAL_UPDATES_EMAILS`.
5. Records a `cron_portal_updates` event in `system_events` with totals + duration.

Wired into `scripts/crontab` to fire daily at **07:00 America/New_York** (≈06:00 EC winter / 07:00 EC summer — early enough that the email is waiting at the start of the Ecuador workday).

## Technical Approach

### Architecture

```
Debian cron (scripts/crontab) ─┐
                               │ POST + Bearer CRON_SECRET
                               ▼
       /api/cron/portal-updates/route.ts
                               │
   ┌───────────────────────────┼───────────────────────────┐
   │                           │                           │
   ▼                           ▼                           ▼
src/lib/portal-updates/   src/lib/portal-updates/    Resend.emails.send
  aggregator.ts             email-template.ts             │
  ├─ getJobActivity()       └─ buildPortalUpdatesHtml()   ▼
  ├─ getCtVerifyActivity()                          PORTAL_UPDATES_EMAILS
  ├─ getAudioVerifyActivity()                       (csv recipients)
  └─ getProjectsWithAnyActivity()
                               │
                               ▼
                         recordEvent(...)
                       (cron_portal_updates)
```

### Files to Create

| Path | Purpose |
|---|---|
| `src/app/api/cron/portal-updates/route.ts` | POST handler, auth, orchestration, send |
| `src/lib/portal-updates/aggregator.ts` | Typed Drizzle queries returning per-project activity |
| `src/lib/portal-updates/email-template.ts` | `buildPortalUpdatesHtml(...)` + subject helper |
| `src/lib/portal-updates/types.ts` | `ProjectActivity`, `JobBucket`, `LeaderboardRow` types |
| `src/app/api/cron/portal-updates/route.test.ts` | Vitest: auth, empty-day, populated-day, Resend mocked |
| `src/lib/portal-updates/aggregator.test.ts` | Vitest: query correctness against in-memory SQLite |

### Files to Modify

| Path | Change |
|---|---|
| `scripts/crontab` | Add 4th entry for `portal-updates` at `0 7 * * *` Eastern |
| `.env.example` (or equivalent doc) | Document `PORTAL_UPDATES_EMAILS` |
| `CLAUDE.md` | Add a one-line bullet under a "Cron jobs" / Operations section if appropriate |
| `README.md` | (Only if it documents email/cron config — skip otherwise) |

### Implementation Phases

#### Phase 1 — Scaffolding & Types

Create the empty route + lib files with type contracts, no logic.

**Files:**

```
src/lib/portal-updates/types.ts
```

```typescript
// src/lib/portal-updates/types.ts
import type { JobType } from "@/lib/job-types";

export type LeaderboardRow = { actorEmail: string; count: number };

export type JobBucket = {
  jobType: JobType;          // e.g., "ml", "birdnet"
  label: string;             // from JOB_LABELS, e.g., "BirdNET"
  completed: number;         // count of jobs with status='completed' in window
  failed: number;            // count of jobs with status='failed' in window
};

export type ProjectActivity = {
  projectId: string;         // projects.id, e.g., "biochoco"
  projectName: string;       // projects.name, e.g., "BioChoco"
  ctJobs: JobBucket[];       // CT job types only (ml, ml_incremental, drive_sync, compression, revert_compression)
  audioJobs: JobBucket[];    // audio job types
  ctVerifiedImages: number;  // COUNT(DISTINCT images.id) verified in window
  ctTopVerificadores: LeaderboardRow[];     // top 3 by COUNT(DISTINCT images.id)
  audioVerifiedFiles: number; // COUNT(DISTINCT audio_files.id) verified in window
  audioTopVerificadores: LeaderboardRow[];  // top 3
};

export type PortalUpdatesPayload = {
  windowStart: Date;
  windowEnd: Date;
  projects: ProjectActivity[];   // already filtered to projects with non-zero activity
  totalCtJobs: number;
  totalAudioJobs: number;
  totalCtVerifiedImages: number;
  totalAudioVerifiedFiles: number;
};
```

```
src/lib/portal-updates/aggregator.ts
```

```typescript
// Stub signatures only in this phase
export async function buildPortalUpdatesPayload(
  windowStart: Date,
  windowEnd: Date,
): Promise<PortalUpdatesPayload> { /* phase 2 */ }
```

```
src/lib/portal-updates/email-template.ts
```

```typescript
export function buildPortalUpdatesSubject(payload: PortalUpdatesPayload): string;
export function buildPortalUpdatesHtml(payload: PortalUpdatesPayload): string;
```

**Acceptance:** Files compile, types exported, no runtime use yet.

---

#### Phase 2 — Aggregation queries

Implement the four query functions that build a `ProjectActivity[]`.

**Window:**
```typescript
const windowEnd = new Date();
const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
```

(JS `Date` ↔ SQLite `unixepoch` integer is handled by Drizzle's `mode: "timestamp"`.)

**Job query (one per project, both CT and audio in one pass):**

```typescript
// processingJobs.deploymentId may be NULL (per CLAUDE.md note).
// Resolve project via deployments.projectId; rows with NULL deployment go to "Otros" or are skipped.

const rows = await db
  .select({
    projectId: deployments.projectId,
    jobType: processingJobs.jobType,
    status: processingJobs.status,
    n: count(),
  })
  .from(processingJobs)
  .leftJoin(deployments, eq(processingJobs.deploymentId, deployments.id))
  .where(
    and(
      gte(processingJobs.completedAt, windowStart),
      inArray(processingJobs.status, ["completed", "failed"]),
    ),
  )
  .groupBy(deployments.projectId, processingJobs.jobType, processingJobs.status)
  .all();
```

Bucket each row into CT vs audio using `AUDIO_JOB_TYPES` from `@/lib/system-events`.

**CT verified-images query:**

```typescript
// identifications -> detections -> images -> deployments -> projects
const rows = await db
  .select({
    projectId: deployments.projectId,
    verifiedBy: identifications.verifiedBy,
    distinctImages: countDistinct(images.id),
  })
  .from(identifications)
  .innerJoin(detections, eq(identifications.detectionId, detections.id))
  .innerJoin(images, eq(detections.imageId, images.id))
  .innerJoin(deployments, eq(images.deploymentId, deployments.id))
  .where(
    and(
      gte(identifications.verifiedAt, windowStart),
      eq(identifications.verificationStatus, "verified"),
      isNotNull(identifications.verifiedBy),
    ),
  )
  .groupBy(deployments.projectId, identifications.verifiedBy)
  .all();
```

Then in JS: per project, sum `distinctImages` across verifiedBy for the project total, and pick top 3 verifiedBy by that count for the leaderboard.

> ⚠️ **Note on "distinct images per user":** the SQL above gives `COUNT(DISTINCT image_id)` *per (project, verifiedBy)* — that's correct for the leaderboard. The project total (`ctVerifiedImages`) **cannot** be computed by summing those rows (an image with two verifications by different users would double-count). Run a **second query** without the `verifiedBy` group:
>
> ```typescript
> // Project total: distinct images, regardless of who verified
> .groupBy(deployments.projectId)
> ```

**Audio verified-files query:** Mirror of the CT query, replacing:
- `identifications` → `audioIdentifications`
- `detections` → `audioDetections` (join on `audioIdentifications.audioDetectionId`)
- `images` → `audioFiles` (join on `audioDetections.audioFileId`)
- `images.deploymentId` → `audioFiles.deploymentId`
- `images.id` → `audioFiles.id`

Same two-query pattern (one for leaderboard, one for distinct file total).

**Project enumeration & filtering:**

```typescript
const allProjects = await db.select().from(projects).all();
const activeProjects = allProjects
  .map((p) => assembleProjectActivity(p, jobsByProject, ctVerifyByProject, audioVerifyByProject))
  .filter((p) =>
    p.ctJobs.length > 0
    || p.audioJobs.length > 0
    || p.ctVerifiedImages > 0
    || p.audioVerifiedFiles > 0
  );
```

**Acceptance:**
- `buildPortalUpdatesPayload(start, end)` returns a populated `PortalUpdatesPayload`
- Distinct counts are exact (covered by `aggregator.test.ts`)
- Leaderboards limited to top 3, sorted descending by count, with stable secondary sort by `actorEmail` for determinism

---

#### Phase 3 — Email template

Pure function, no I/O. Mirrors visual style of `nightly-refresh` `buildEmailHtml()` (inline CSS, simple tables).

**`buildPortalUpdatesSubject(payload)`** →
- With activity: `"FCAT Portal — Actividad diaria YYYY-MM-DD"` (use `windowEnd` for date stamp)
- Empty: `"FCAT Portal — Sin actividad nueva (YYYY-MM-DD)"`

**`buildPortalUpdatesHtml(payload)`** structure:

```
<header>
  <h1>Actividad del Portal</h1>
  <p>Resumen de las últimas 24 horas — {windowStart} a {windowEnd}</p>
  <p><strong>Totales:</strong> {totalCtJobs} trabajos cámara trampa · {totalAudioJobs} trabajos audio ·
     {totalCtVerifiedImages} imágenes verificadas · {totalAudioVerifiedFiles} grabaciones verificadas</p>
</header>

<!-- Empty-day branch -->
{projects.length === 0 ? <p>No hubo actividad nueva en este período.</p> : ...}

<!-- Per-project section -->
{projects.map(p => `
  <section>
    <h2>{p.projectName}</h2>

    {p.ctJobs.length > 0 && (
      <h3>Cámaras trampa — Trabajos completados</h3>
      <ul>{p.ctJobs.map(j => <li>{j.label}: {j.completed} completados{j.failed > 0 && `, ${j.failed} fallidos`}</li>)}</ul>
    )}

    {p.ctVerifiedImages > 0 && (
      <h3>Cámaras trampa — Verificación</h3>
      <p>{p.ctVerifiedImages} imágenes verificadas</p>
      <ul>{p.ctTopVerificadores.map(r => <li>{r.actorEmail}: {r.count}</li>)}</ul>
    )}

    {p.audioJobs.length > 0 && (
      <h3>Audio — Trabajos completados</h3>
      <ul>{p.audioJobs.map(j => <li>{j.label}: {j.completed} completados{j.failed > 0 && `, ${j.failed} fallidos`}</li>)}</ul>
    )}

    {p.audioVerifiedFiles > 0 && (
      <h3>Audio — Verificación</h3>
      <p>{p.audioVerifiedFiles} grabaciones verificadas</p>
      <ul>{p.audioTopVerificadores.map(r => <li>{r.actorEmail}: {r.count}</li>)}</ul>
    )}
  </section>
`)}

<footer>
  <p style="color:#888;font-size:12px">portal.fcat-ecuador.org</p>
</footer>
```

All Spanish strings, no emoji unless explicitly requested. Inline styles for email-client compatibility (mirror nightly-refresh).

**Acceptance:**
- Snapshot test stable
- Renders correctly in Gmail web (manual verification step)
- HTML body < 200KB even with all projects active

---

#### Phase 4 — Route handler & wiring

```
src/app/api/cron/portal-updates/route.ts
```

```typescript
import { db } from "@/db";
import { verifyCronSecret } from "@/lib/cron-auth";
import { Resend } from "resend";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import { buildPortalUpdatesPayload } from "@/lib/portal-updates/aggregator";
import {
  buildPortalUpdatesHtml,
  buildPortalUpdatesSubject,
} from "@/lib/portal-updates/email-template";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  try {
    const payload = await buildPortalUpdatesPayload(windowStart, windowEnd);
    const recipients = (process.env.PORTAL_UPDATES_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (recipients.length === 0) {
      log.warn("[portal-updates] PORTAL_UPDATES_EMAILS not configured; skipping send");
      await recordEvent({
        source: "cron",
        eventType: "cron_portal_updates",
        severity: "warn",
        summary: "No hay destinatarios configurados — email no enviado",
        durationMs: Date.now() - startTime,
        details: { totals: payloadTotals(payload), reason: "no_recipients" },
      });
      return Response.json({ ok: false, reason: "no_recipients" }, { status: 200 });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY not configured");

    const resend = new Resend(apiKey);
    const fromEmail = process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org";

    const { error } = await resend.emails.send({
      from: fromEmail,
      to: recipients,
      subject: buildPortalUpdatesSubject(payload),
      html: buildPortalUpdatesHtml(payload),
    });

    if (error) {
      log.error({ error }, "[portal-updates] Resend send failed");
      await recordEvent({
        source: "cron",
        eventType: "cron_portal_updates",
        severity: "warn",
        summary: `Resend rechazó el envío: ${error.message ?? "unknown"}`,
        durationMs: Date.now() - startTime,
        details: { totals: payloadTotals(payload), resendError: String(error) },
      });
      return Response.json({ ok: false, error: String(error) }, { status: 200 });
    }

    await recordEvent({
      source: "cron",
      eventType: "cron_portal_updates",
      severity: "success",
      summary: summarize(payload),
      durationMs: Date.now() - startTime,
      details: { totals: payloadTotals(payload), recipientCount: recipients.length },
    });

    return Response.json({
      ok: true,
      totals: payloadTotals(payload),
      elapsed: `${Date.now() - startTime}ms`,
    });
  } catch (err) {
    log.error({ err }, "[portal-updates] Failed");
    await recordEvent({
      source: "cron",
      eventType: "cron_portal_updates",
      severity: "error",
      summary: `Error generando email: ${(err as Error).message}`,
      durationMs: Date.now() - startTime,
      details: { error: String(err) },
    });
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

function payloadTotals(p: PortalUpdatesPayload) {
  return {
    ctJobs: p.totalCtJobs,
    audioJobs: p.totalAudioJobs,
    ctVerifiedImages: p.totalCtVerifiedImages,
    audioVerifiedFiles: p.totalAudioVerifiedFiles,
    activeProjects: p.projects.length,
  };
}

function summarize(p: PortalUpdatesPayload): string {
  if (p.projects.length === 0) return "Sin actividad nueva en las últimas 24 horas";
  return `Email enviado: ${p.totalCtJobs + p.totalAudioJobs} trabajos, ${p.totalCtVerifiedImages + p.totalAudioVerifiedFiles} verificaciones`;
}
```

**Crontab entry** to add to `scripts/crontab` (after the research-reminders line):

```cron
# Daily portal-updates email — 7 AM Eastern (~6-7 AM Ecuador, before workday starts)
0 7 * * * root . /etc/cron.d/portal-env && /usr/bin/curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" --max-time 120 http://localhost:3000/api/cron/portal-updates >> /app/data/backups/cron.log 2>&1
```

(120s timeout is plenty — only DB queries + one Resend send, no Drive sync.)

**Env var documentation:** add to whichever file is canonical (`.env.example`, deployment README, or both). Suggested entry:

```bash
# Comma-separated list of recipients for the daily portal-updates email.
# Independent from NIGHTLY_REPORT_EMAILS (the BioChoco data-uploads digest).
PORTAL_UPDATES_EMAILS=alice@fcat-ecuador.org,bob@fcat-ecuador.org
```

---

#### Phase 5 — Tests

**`src/lib/portal-updates/aggregator.test.ts`** — Vitest, in-memory SQLite (follow whatever pattern is used elsewhere; check `src/app/audio/*.test.ts` or `src/db/*.test.ts` for a working setup):

- Setup: create projects, deployments, images, detections, identifications, audio analogues, processing_jobs.
- Test: window correctly filters by `verifiedAt` / `completedAt`.
- Test: `COUNT(DISTINCT images.id)` excludes double-verified images.
- Test: leaderboard sorts descending, ties broken by email asc, top 3 only.
- Test: project filtering removes zero-activity projects.
- Test: NULL `verifiedBy` rows excluded from leaderboard.
- Test: `processingJobs.deploymentId IS NULL` rows handled (either skipped or bucketed — pick and document).
- Test: cancelled/pending jobs excluded.

**`src/app/api/cron/portal-updates/route.test.ts`** — Vitest:

- 401 without bearer token.
- 401 with wrong bearer token.
- 200 + warn event when `PORTAL_UPDATES_EMAILS` empty.
- 500 + error event when `RESEND_API_KEY` missing.
- 200 + success event on happy path; mock `Resend` and assert `to`, `subject`, `html` were called correctly.
- 200 + warn event when Resend returns `{ error }` (don't throw).
- Empty-day path: payload has no projects, email still sends with "Sin actividad" subject.

**Mocking pattern:** mirror existing tests in repo. Resend mock should be a `vi.mock("resend", () => ...)` at top level — but **be careful of the `vi.mock` hoisting gotcha** in `MEMORY.md` (vitest hoists `vi.mock` calls from any imported file, including helpers). Keep `vi.mock("resend")` *inside the test file*, not in a shared helper.

**Acceptance:**
- All tests pass under `npm run test:run`
- No flake from time-of-day (use injected `windowStart`/`windowEnd` rather than `Date.now()` inside aggregator)

---

#### Phase 6 — Manual verification (pre-deploy)

```bash
# 1. Start dev server with env vars
DEV_USER_EMAIL=lukembrowne@gmail.com \
CRON_SECRET=devsecret \
RESEND_API_KEY=... \
RESEND_FROM_EMAIL=portal@fcat-ecuador.org \
PORTAL_UPDATES_EMAILS=lukembrowne@gmail.com \
docker compose up

# 2. Trigger manually
curl -i -X POST -H "Authorization: Bearer devsecret" \
  http://localhost:3000/api/cron/portal-updates

# 3. Check the email visually in Gmail web (rendering in real client matters).

# 4. Verify the system_events row appears in /admin/activity
#    (filter source=cron, eventType=cron_portal_updates).

# 5. Re-run with PORTAL_UPDATES_EMAILS unset → expect ok:false, no_recipients
#    and a warn-severity event in /admin/activity.

# 6. Inside container: check that the crontab entry is installed.
docker compose exec portal cat /etc/cron.d/portal-backup
```

After staging verification, commit and `./deploy.sh`. On the server, set `PORTAL_UPDATES_EMAILS` in the production `.env` (or wherever envs are managed) **before the cron fires**.

## Acceptance Criteria

### Functional

- [x] `POST /api/cron/portal-updates` returns 401 without `Authorization: Bearer $CRON_SECRET`
- [x] On a happy-path day, an HTML email is sent via Resend to every address in `PORTAL_UPDATES_EMAILS`
- [x] Email subject: `FCAT Portal — Actividad diaria YYYY-MM-DD` (or `… Sin actividad nueva` on empty days)
- [x] Email body has one section per project that had any activity in the window; zero-activity projects are omitted
- [x] Each project section shows: CT jobs by type (completed + failed), CT distinct images verified, audio jobs by type, audio distinct files verified, top 3 verificadores per category
- [x] `system_events` row created with `source='cron'`, `eventType='cron_portal_updates'`, severity reflecting outcome, totals in `details`
- [x] Crontab entry fires at 07:00 America/New_York daily

### Non-Functional

- [x] Route completes in < 30s on prod-sized DB (cron budget is 120s — well under) — aggregator queries are indexed on `verifiedAt` / `completedAt` paths
- [x] No schema changes required (zero migrations)
- [ ] Email HTML renders cleanly in Gmail web + Apple Mail (deferred to manual verification post-deploy)

### Quality Gates

- [x] Unit tests for aggregator pass (distinct counts, leaderboard sort, filtering) — 11/11
- [x] Integration tests for route pass (auth, empty-day, populated-day, Resend failure) — 8/8
- [x] No regressions in existing test suite (`npm run test:run`) — 1594/1594
- [x] Lint clean (`npm run lint`) — new files have 0 errors / 0 warnings
- [x] Type-check clean (`npm run build`) — production build succeeds

## Alternative Approaches Considered

1. **Extend `nightly-refresh/route.ts`** — coupled failure mode; rejected in brainstorm.
2. **Snapshot table mirror of `uploadCountSnapshots`** — adds resilience to missed runs but doubles the schema surface for v1; deferred until we observe missed runs.
3. **Query `system_events` for jobs instead of `processing_jobs`** — `system_events` only captures completions since instrumentation went live (May 2026), so historical comparisons would be incomplete. Querying `processing_jobs.completedAt` directly is the source of truth.
4. **Per-project recipient lists** — flagged as future work; v1 uses one CSV.
5. **Emit a per-verification `recordEvent()`** — explicitly avoided per CLAUDE.md ("Default **no** for: high-frequency per-row reads/writes (verification clicks)"). Aggregating from `verifiedAt` columns is the right call.

## Dependencies & Risks

**No external deps.** All within existing stack (Drizzle, Resend, Vitest, Debian cron).

**Risks:**

| Risk | Mitigation |
|---|---|
| Distinct-image total double-counts when same image verified by two users | Run *separate* aggregate query without `verifiedBy` in GROUP BY — see Phase 2 note |
| `processing_jobs.deploymentId IS NULL` rows produce orphan project rows | Decide: skip (recommended for v1) or bucket as "Sin proyecto" — document in code comment |
| Empty `PORTAL_UPDATES_EMAILS` silently skips send | Emit warn-severity `system_events` row + log; visible in `/admin/activity` |
| Resend fails mid-send | Caught, recorded as warn event, route returns 200 ok:false (don't fail the cron) |
| Vitest mock hoisting from helpers | Keep `vi.mock("resend")` in the test file itself, not in helpers (see `MEMORY.md` gotcha) |
| Spam to recipients during dev | Default `PORTAL_UPDATES_EMAILS` empty in dev/staging — only set in prod |
| Cron clock-drift double-firing → duplicate emails | Acceptable for v1; revisit if observed |

## Open Questions

1. **"Verified" vs "verified + corrected":** The brainstorm specified `verificationStatus = 'verified'`. Should "corrected" identifications also count as "verification work done"? Recommended: include both in v1 leaderboard (annotators do real work for corrections too) — but flag for user confirmation.
2. **Empty-day behavior:** Plan currently sends a "Sin actividad" email. Alternative: skip send + still record event. Recommended: send (proof of life beats inbox cleanliness).
3. **Project total for "distinct images" when one image has multiple verifiers:** Plan addresses with two queries. Confirm this matches expectations.
4. **Cap on listed job rows per project:** Top 20 + "+ N más" or unbounded? Default: unbounded (job-type bucketing keeps it short anyway — typically < 10 rows).
5. **Optional Phase 7:** Surface a "View on portal" deeplink per section that prefilters `/admin/activity` by date+source+project. Nice-to-have; defer unless requested.

## Success Metrics

- **Cron health:** `cron_portal_updates` events present in `/admin/activity` every day with `severity != error`.
- **Engagement signal:** verification-leaderboard recipients can name their own counts in the most recent email (informal; we won't instrument open-rates).
- **Zero schema churn:** v1 ships without a migration.

## Future Considerations

- Per-project recipient lists (table-driven, opt-in)
- Weekly rollup variant (Monday morning, 7-day window)
- Add finance / climate / iButton activity once those modules grow
- Self-service unsubscribe via a `portal_updates_subscribers` table

## References & Research

### Brainstorm

- `docs/brainstorms/2026-05-14-portal-updates-daily-email-brainstorm.md` — decisions log

### Internal references (file:line)

- `src/lib/cron-auth.ts:9` — `verifyCronSecret(request)`
- `src/app/api/cron/nightly-refresh/route.ts:96` — auth + Resend send pattern to mirror
- `src/app/api/cron/research-reminders/route.ts` — second cron+email reference
- `src/lib/system-events.ts:24` — `recordEvent()` signature
- `src/lib/system-events.ts:74` — `AUDIO_JOB_TYPES` set
- `src/lib/system-events.ts:83` — `JOB_LABELS` map
- `src/db/schema.ts:212` — `processingJobs` columns (deploymentId nullable; `completedAt`)
- `src/db/schema.ts:373` — `identifications.verifiedAt/By/Status`
- `src/db/schema.ts:872` — `audioIdentifications.verifiedAt/By/Status`
- `src/db/schema.ts:514` — `systemEvents` (already indexed on `occurred_at`)
- `src/app/admin/activity/actions.ts:65` — `listEvents()` query pattern reference
- `scripts/crontab:11` — research-reminders entry (closest analogue)
- `scripts/push-schema.mjs:992` — `coreProjects` seed list

### CLAUDE.md guidance applied

- Spanish UI strings throughout the email
- `recordEvent()` usage at terminal points (success/warn/error) per instrumentation policy
- Avoid per-row `recordEvent()` for verifications (explicit anti-pattern)
- `ActionResult<T>` not used here — this is a cron Response.json, not a server action
- better-sqlite3 transactions are sync — N/A (this route is read-only)

### Memory gotchas applied

- Vitest `vi.mock` hoisting — keep mocks in test file, not helpers
- Drizzle `sql` template + undefined — N/A (no inserts)

### Related work

- Recent: `e2ad24b` (job-lifecycle instrumentation), `64f4ca3` (`buildJobCompletionEvent` helper) — establish the `system_events` ecosystem this email depends on
- Brainstorm `docs/brainstorms/2026-05-13-unified-system-activity-log-brainstorm.md` — the `/admin/activity` foundation
