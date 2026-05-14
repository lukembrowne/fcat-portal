"use server";

import { db } from "@/db";
import {
  systemEvents,
  EVENT_SOURCES,
  EVENT_SEVERITIES,
  type EventSource,
  type EventSeverity,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { and, asc, desc, eq, gte, like, lte, sql, type SQL } from "drizzle-orm";

const SORTABLE_COLUMNS = {
  occurredAt: systemEvents.occurredAt,
  severity: systemEvents.severity,
  source: systemEvents.source,
  eventType: systemEvents.eventType,
  summary: systemEvents.summary,
  actorEmail: systemEvents.actorEmail,
  durationMs: systemEvents.durationMs,
} as const;

export type SortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = "asc" | "desc";

export type EventRow = {
  id: number;
  occurredAt: string;
  eventType: string;
  source: EventSource;
  severity: EventSeverity;
  actorEmail: string | null;
  projectId: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  durationMs: number | null;
  details: string | null;
};

export type ListEventsFilters = {
  source?: string;
  eventType?: string;
  severity?: string;
  actorEmail?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  q?: string;
  page?: number;
  sortBy?: string;
  sortDir?: string;
};

export type ListEventsResult = {
  rows: EventRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
};

const PAGE_SIZE = 50;

export async function listEvents(
  filters: ListEventsFilters,
): Promise<ListEventsResult> {
  await requireAdmin();

  const page = Math.max(1, filters.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const where: (SQL | undefined)[] = [];

  if (filters.source && (EVENT_SOURCES as readonly string[]).includes(filters.source)) {
    where.push(eq(systemEvents.source, filters.source as EventSource));
  }
  if (filters.eventType) {
    where.push(eq(systemEvents.eventType, filters.eventType));
  }
  if (
    filters.severity &&
    (EVENT_SEVERITIES as readonly string[]).includes(filters.severity)
  ) {
    where.push(eq(systemEvents.severity, filters.severity as EventSeverity));
  }
  if (filters.actorEmail) {
    where.push(eq(systemEvents.actorEmail, filters.actorEmail));
  }
  if (filters.from) {
    const fromDate = new Date(`${filters.from}T00:00:00`);
    if (!Number.isNaN(fromDate.getTime())) {
      where.push(gte(systemEvents.occurredAt, fromDate));
    }
  }
  if (filters.to) {
    const toDate = new Date(`${filters.to}T23:59:59`);
    if (!Number.isNaN(toDate.getTime())) {
      where.push(lte(systemEvents.occurredAt, toDate));
    }
  }
  if (filters.q && filters.q.trim()) {
    where.push(like(systemEvents.summary, `%${filters.q.trim()}%`));
  }

  const condition = where.length > 0 ? and(...where) : undefined;

  const sortBy = filters.sortBy as SortColumn | undefined;
  const sortColumn =
    sortBy && sortBy in SORTABLE_COLUMNS
      ? SORTABLE_COLUMNS[sortBy]
      : systemEvents.occurredAt;
  const sortDir: SortDirection = filters.sortDir === "asc" ? "asc" : "desc";
  const orderFn = sortDir === "asc" ? asc : desc;
  // Stable tiebreaker on id keeps pagination deterministic.
  const idTiebreaker = sortDir === "asc" ? asc(systemEvents.id) : desc(systemEvents.id);

  const [rows, totalResult] = await Promise.all([
    db
      .select()
      .from(systemEvents)
      .where(condition)
      .orderBy(orderFn(sortColumn), idTiebreaker)
      .limit(PAGE_SIZE + 1) // +1 to peek next-page existence
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(systemEvents)
      .where(condition),
  ]);

  const hasNext = rows.length > PAGE_SIZE;
  const pageRows = hasNext ? rows.slice(0, PAGE_SIZE) : rows;

  return {
    rows: pageRows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      eventType: r.eventType,
      source: r.source,
      severity: r.severity,
      actorEmail: r.actorEmail,
      projectId: r.projectId,
      targetType: r.targetType,
      targetId: r.targetId,
      summary: r.summary,
      durationMs: r.durationMs,
      details: r.details,
    })),
    total: Number(totalResult[0]?.count ?? 0),
    page,
    pageSize: PAGE_SIZE,
    hasNext,
  };
}
