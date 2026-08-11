"use server";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  grants,
  funders,
  systemEvents,
  grantStatusEnum,
  grantFundingEntityEnum,
  type GrantStatus,
  type GrantFundingEntity,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { recordEvent } from "@/lib/system-events";
import { EDITABLE_GRANT_FIELDS, type EditableGrantField } from "@/lib/grants/constants";
import type { ActionResult } from "@/lib/types";

const PROJECT = "grants";

// ---------------------------------------------------------------------------
// Reads (return bare data; requirePermission throws via redirect on failure)
// ---------------------------------------------------------------------------

export interface GrantListItem {
  id: number;
  name: string;
  projectTitle: string | null;
  funderId: number | null;
  funderName: string | null; // resolved funder record name, or null
  funderNameRaw: string | null; // typed fallback when unlinked
  status: GrantStatus;
  amountRequested: number | null;
  amountAwarded: number | null;
  fundingEntity: GrantFundingEntity | null;
  dueDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  website: string | null;
  folderLink: string | null;
  budgetLink: string | null;
  proposalLink: string | null;
  notes: string | null;
}

const SORTABLE_COLUMNS = {
  name: grants.name,
  projectTitle: grants.projectTitle,
  funder: funders.name,
  status: grants.status,
  amount: grants.amountRequested,
  awarded: grants.amountAwarded,
  entity: grants.fundingEntity,
  due: grants.dueDate,
  start: grants.startDate,
  end: grants.endDate,
} as const;

/**
 * Columns that are empty for most rows, where SQLite's default NULL ordering
 * would bury the data. NULLs sort before every value in ASC, and a header's
 * first click is always ASC (SortableHeader sends asc for a non-active column) —
 * so without this, one click on Start puts every unfunded grant above every
 * funded one and the sort reads as broken. `due` is deliberately absent: it is
 * populated on nearly every grant, and its ordering is long-established.
 */
const NULLS_LAST_COLUMNS = new Set<SortColumn>([
  "projectTitle",
  "awarded",
  "entity",
  "start",
  "end",
]);

export type SortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = "asc" | "desc";

export async function getGrants(filters?: {
  status?: string;
  funderId?: string;
  search?: string;
  needsLinking?: string;
  sortBy?: string;
  sortDir?: string;
}): Promise<GrantListItem[]> {
  await requirePermission(PROJECT, "viewer");

  let query = db
    .select({
      id: grants.id,
      name: grants.name,
      projectTitle: grants.projectTitle,
      funderId: grants.funderId,
      funderName: funders.name,
      funderNameRaw: grants.funderNameRaw,
      status: grants.status,
      amountRequested: grants.amountRequested,
      amountAwarded: grants.amountAwarded,
      fundingEntity: grants.fundingEntity,
      dueDate: grants.dueDate,
      startDate: grants.startDate,
      endDate: grants.endDate,
      website: grants.website,
      folderLink: grants.folderLink,
      budgetLink: grants.budgetLink,
      proposalLink: grants.proposalLink,
      notes: grants.notes,
    })
    .from(grants)
    .leftJoin(funders, eq(grants.funderId, funders.id))
    .$dynamic();

  const where = [];
  if (filters?.status && filters.status !== "all") {
    where.push(eq(grants.status, filters.status as GrantStatus));
  }
  if (filters?.funderId) {
    const fid = parseInt(filters.funderId, 10);
    if (!isNaN(fid)) where.push(eq(grants.funderId, fid));
  }
  if (filters?.needsLinking === "1") {
    where.push(isNull(grants.funderId));
  }
  if (filters?.search) {
    const term = `%${filters.search}%`;
    where.push(
      sql`(${grants.name} LIKE ${term} OR ${grants.funderNameRaw} LIKE ${term} OR ${funders.name} LIKE ${term})`
    );
  }
  if (where.length > 0) query = query.where(and(...where));

  const sortCol = filters?.sortBy as SortColumn | undefined;
  const sortDir = filters?.sortDir === "asc" ? "asc" : "desc";
  const resolved: SortColumn =
    sortCol && sortCol in SORTABLE_COLUMNS ? sortCol : "due";
  const column = SORTABLE_COLUMNS[resolved];
  const orderFn = sortDir === "asc" ? asc : desc;

  // Empty-heavy columns push their blanks to the bottom in both directions;
  // see NULLS_LAST_COLUMNS. Stable id tiebreaker keeps ordering deterministic.
  const order = NULLS_LAST_COLUMNS.has(resolved)
    ? [sql`${column} IS NULL`, orderFn(column), asc(grants.id)]
    : [orderFn(column), asc(grants.id)];

  return query.orderBy(...order).all();
}

export async function getGrant(id: number) {
  await requirePermission(PROJECT, "viewer");
  const row = db
    .select({
      grant: grants,
      funderName: funders.name,
    })
    .from(grants)
    .leftJoin(funders, eq(grants.funderId, funders.id))
    .where(eq(grants.id, id))
    .get();
  return row ?? null;
}

/** Most recent audit event for a grant — drives the "last updated by" subtext. */
export async function getGrantActivity(
  id: number
): Promise<{ actorEmail: string | null; occurredAt: Date } | null> {
  await requirePermission(PROJECT, "viewer");
  const row = db
    .select({
      actorEmail: systemEvents.actorEmail,
      occurredAt: systemEvents.occurredAt,
    })
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.source, "grants"),
        eq(systemEvents.targetType, "grant"),
        eq(systemEvents.targetId, String(id))
      )
    )
    .orderBy(desc(systemEvents.occurredAt))
    .limit(1)
    .get();
  return row ?? null;
}

export interface GrantsSummaryData {
  pendingCount: number;
  pendingAmount: number;
  fundedCount: number;
  fundedAmount: number;
  inPrepCount: number;
}

/** Dashboard summary numbers (reproduces the n8n digest header). */
export async function getGrantsSummary(): Promise<GrantsSummaryData> {
  await requirePermission(PROJECT, "viewer");
  const rows = db
    .select({ status: grants.status, amount: grants.amountRequested })
    .from(grants)
    .all();

  const out: GrantsSummaryData = {
    pendingCount: 0,
    pendingAmount: 0,
    fundedCount: 0,
    fundedAmount: 0,
    inPrepCount: 0,
  };
  for (const r of rows) {
    const amt = r.amount ?? 0;
    if (r.status === "pending_decision") {
      out.pendingCount++;
      out.pendingAmount += amt;
    } else if (r.status === "funded") {
      out.fundedCount++;
      out.fundedAmount += amt;
    } else if (r.status === "in_prep") {
      out.inPrepCount++;
    }
  }
  return out;
}

/** Lightweight funder list for the grant-form picker (serializable). */
export async function getFunderOptions(): Promise<
  { id: number; name: string }[]
> {
  await requirePermission(PROJECT, "viewer");
  return db
    .select({ id: funders.id, name: funders.name })
    .from(funders)
    .orderBy(asc(funders.name))
    .all();
}

// ---------------------------------------------------------------------------
// Mutations (return ActionResult<T>)
// ---------------------------------------------------------------------------

function parseAmount(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const cleaned = String(v).replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDate(v: FormDataEntryValue | null): Date | null {
  if (v == null || String(v).trim() === "") return null;
  // Store date-only fields at UTC midnight (matches the importer convention).
  const d = new Date(`${String(v).trim()}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function text(v: FormDataEntryValue | null): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export async function saveGrant(
  _prev: ActionResult<{ id: number }> | null,
  formData: FormData
): Promise<ActionResult<{ id: number }>> {
  const user = await requirePermission(PROJECT, "editor");

  const idRaw = formData.get("id");
  const id = idRaw ? parseInt(String(idRaw), 10) : null;

  const name = text(formData.get("name"));
  if (!name) return { success: false, error: "Grant name is required." };

  const statusRaw = String(formData.get("status") ?? "to_research");
  if (!grantStatusEnum.includes(statusRaw as GrantStatus)) {
    return { success: false, error: "Invalid status." };
  }
  const status = statusRaw as GrantStatus;

  const funderIdRaw = formData.get("funderId");
  const funderId =
    funderIdRaw && String(funderIdRaw) !== ""
      ? parseInt(String(funderIdRaw), 10)
      : null;
  // Keep the typed name only when no funder record is linked.
  const funderNameRaw = funderId ? null : text(formData.get("funderNameRaw"));

  const entityRaw = text(formData.get("fundingEntity"));
  if (entityRaw && !grantFundingEntityEnum.includes(entityRaw as GrantFundingEntity)) {
    return { success: false, error: "Invalid funding entity." };
  }

  const values = {
    funderId: funderId && !isNaN(funderId) ? funderId : null,
    funderNameRaw,
    name,
    projectTitle: text(formData.get("projectTitle")),
    website: text(formData.get("website")),
    status,
    amountRequested: parseAmount(formData.get("amountRequested")),
    amountAwarded: parseAmount(formData.get("amountAwarded")),
    fundingEntity: (entityRaw as GrantFundingEntity | null) ?? null,
    dueDate: parseDate(formData.get("dueDate")),
    startDate: parseDate(formData.get("startDate")),
    endDate: parseDate(formData.get("endDate")),
    notes: text(formData.get("notes")),
    folderLink: text(formData.get("folderLink")),
    budgetLink: text(formData.get("budgetLink")),
    proposalLink: text(formData.get("proposalLink")),
    updatedAt: new Date(),
  };

  try {
    let savedId: number;
    if (id) {
      await db.update(grants).set(values).where(eq(grants.id, id));
      savedId = id;
    } else {
      const inserted = await db
        .insert(grants)
        .values(values)
        .returning({ id: grants.id });
      savedId = inserted[0].id;
    }

    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: id ? "grant_updated" : "grant_created",
      severity: "success",
      actorEmail: user.email,
      targetType: "grant",
      targetId: savedId,
      summary: `${id ? "Grant updated" : "Grant created"} · ${name}`,
      details: { status, amountRequested: values.amountRequested },
    });

    revalidatePath("/grants");
    revalidatePath(`/grants/${savedId}`);
    return { success: true, data: { id: savedId } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save the grant.",
    };
  }
}

export async function updateGrantStatus(
  id: number,
  status: GrantStatus
): Promise<ActionResult> {
  const user = await requirePermission(PROJECT, "editor");
  if (!grantStatusEnum.includes(status)) {
    return { success: false, error: "Invalid status." };
  }
  try {
    await db
      .update(grants)
      .set({ status, updatedAt: new Date() })
      .where(eq(grants.id, id));
    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: "grant_status_changed",
      actorEmail: user.email,
      targetType: "grant",
      targetId: id,
      summary: `Grant status changed → ${status}`,
    });
    revalidatePath("/grants");
    revalidatePath(`/grants/${id}`);
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to change the status.",
    };
  }
}

export interface UpdatedGrantField {
  field: EditableGrantField;
  /** Canonical stored value, serialized for the client. Dates as "YYYY-MM-DD". */
  value: string | number | null;
}

function dateToInput(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Single-field write for the inline row editor. Each field is coerced + validated
 * server-side (the action is directly reachable, so client constraints aren't trusted).
 * Returns the canonical stored value so the cell can re-render formatted.
 */
export async function updateGrantField(
  id: number,
  field: string,
  raw: string | null
): Promise<ActionResult<UpdatedGrantField>> {
  const user = await requirePermission(PROJECT, "editor");
  if (!(EDITABLE_GRANT_FIELDS as readonly string[]).includes(field)) {
    return { success: false, error: "Unknown field." };
  }
  const f = field as EditableGrantField;

  const set: Partial<typeof grants.$inferInsert> = { updatedAt: new Date() };
  let canonical: string | number | null = raw;

  switch (f) {
    case "name": {
      const v = text(raw);
      if (!v) return { success: false, error: "Grant name is required." };
      set.name = v;
      canonical = v;
      break;
    }
    case "projectTitle": {
      const v = text(raw);
      set.projectTitle = v;
      canonical = v;
      break;
    }
    case "status": {
      if (!grantStatusEnum.includes(raw as GrantStatus)) {
        return { success: false, error: "Invalid status." };
      }
      set.status = raw as GrantStatus;
      canonical = raw;
      break;
    }
    case "amountRequested": {
      const v = parseAmount(raw);
      set.amountRequested = v;
      canonical = v;
      break;
    }
    case "amountAwarded": {
      const v = parseAmount(raw);
      set.amountAwarded = v;
      canonical = v;
      break;
    }
    case "fundingEntity": {
      // Unset is valid — an unfunded grant has no entity. Anything else must be
      // in the enum, or the SQLite CHECK would reject the write anyway.
      if (raw === null || raw === "") {
        set.fundingEntity = null;
        canonical = null;
        break;
      }
      if (!grantFundingEntityEnum.includes(raw as GrantFundingEntity)) {
        return { success: false, error: "Invalid funding entity." };
      }
      set.fundingEntity = raw as GrantFundingEntity;
      canonical = raw;
      break;
    }
    case "dueDate": {
      const d = parseDate(raw);
      set.dueDate = d;
      canonical = dateToInput(d);
      break;
    }
    case "startDate": {
      const d = parseDate(raw);
      set.startDate = d;
      canonical = dateToInput(d);
      break;
    }
    case "endDate": {
      const d = parseDate(raw);
      set.endDate = d;
      canonical = dateToInput(d);
      break;
    }
    case "funderId": {
      const fid = raw && raw !== "" ? parseInt(raw, 10) : null;
      const v = fid && !isNaN(fid) ? fid : null;
      set.funderId = v;
      if (v) set.funderNameRaw = null; // linking a funder clears the one-off name
      canonical = v;
      break;
    }
    case "funderNameRaw": {
      const v = text(raw);
      set.funderNameRaw = v;
      canonical = v;
      break;
    }
    case "notes": {
      const v = text(raw);
      set.notes = v;
      canonical = v;
      break;
    }
    case "website": {
      const v = text(raw);
      set.website = v;
      canonical = v;
      break;
    }
    case "folderLink": {
      const v = text(raw);
      set.folderLink = v;
      canonical = v;
      break;
    }
    case "budgetLink": {
      const v = text(raw);
      set.budgetLink = v;
      canonical = v;
      break;
    }
    case "proposalLink": {
      const v = text(raw);
      set.proposalLink = v;
      canonical = v;
      break;
    }
  }

  try {
    await db.update(grants).set(set).where(eq(grants.id, id));
    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: field === "status" ? "grant_status_changed" : "grant_updated",
      actorEmail: user.email,
      targetType: "grant",
      targetId: id,
      summary: `Grant #${id}: ${field} updated`,
      details: { field: f },
    });
    revalidatePath("/grants");
    revalidatePath(`/grants/${id}`);
    return { success: true, data: { field: f, value: canonical } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save.",
    };
  }
}

export async function linkGrantFunder(
  grantId: number,
  funderId: number
): Promise<ActionResult> {
  const user = await requirePermission(PROJECT, "editor");
  try {
    await db
      .update(grants)
      .set({ funderId, funderNameRaw: null, updatedAt: new Date() })
      .where(eq(grants.id, grantId));
    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: "grant_funder_linked",
      actorEmail: user.email,
      targetType: "grant",
      targetId: grantId,
      summary: `Grant #${grantId} linked to funder #${funderId}`,
    });
    revalidatePath("/grants");
    revalidatePath(`/grants/${grantId}`);
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to link the funder.",
    };
  }
}

export async function deleteGrant(id: number): Promise<ActionResult> {
  const user = await requirePermission(PROJECT, "editor");
  try {
    const existing = db
      .select({ name: grants.name })
      .from(grants)
      .where(eq(grants.id, id))
      .get();
    await db.delete(grants).where(eq(grants.id, id));
    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: "grant_deleted",
      severity: "warn",
      actorEmail: user.email,
      targetType: "grant",
      targetId: id,
      summary: `Grant deleted · ${existing?.name ?? `#${id}`}`,
    });
    revalidatePath("/grants");
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete the grant.",
    };
  }
}
