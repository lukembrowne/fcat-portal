import "server-only";
import { db } from "@/db";
import {
  systemEvents,
  type EventSeverity,
  type EventSource,
} from "@/db/schema";
import { log } from "@/lib/log";

/**
 * Unified activity log writer. Every significant event in the portal — cron
 * runs, admin actions, destructive user actions, ingestion uploads, etc. —
 * flows through this helper into the `system_events` table, which backs the
 * `/admin/activity` page.
 *
 * Never throws. A failed insert is logged at `warn` and discarded so the
 * caller's primary flow is never broken by an event-recording problem.
 *
 * When `occurredAt` is omitted, the SQL DEFAULT `unixepoch()` fires
 * server-side.
 */
export type RecordEventInput = {
  source: EventSource;
  eventType: string;
  summary: string;
  severity?: EventSeverity;
  actorEmail?: string | null;
  projectId?: string | null;
  targetType?: string | null;
  targetId?: string | number | null;
  durationMs?: number | null;
  details?: Record<string, unknown> | null;
  occurredAt?: Date;
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
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  } catch (err) {
    log.warn({ err, input }, "recordEvent_failed");
  }
}
