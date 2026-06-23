"use server";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  funders,
  grants,
  funderPriorityEnum,
  type FunderPriority,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { recordEvent } from "@/lib/system-events";
import { normalizeFunderName } from "@/lib/grants/normalize";
import {
  EDITABLE_FUNDER_FIELDS,
  GRANT_SUCCESS_DENOMINATOR_STATUSES,
  type EditableFunderField,
} from "@/lib/grants/constants";
import type { ActionResult } from "@/lib/types";

const PROJECT = "grants";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface FunderListItem {
  id: number;
  name: string;
  priority: FunderPriority | null;
  funderType: string | null;
  focusAreas: string | null;
  relationshipManager: string | null;
  relationshipStatus: string | null;
  nextSteps: string | null;
  nextStepDue: Date | null;
  contactName: string | null;
  contactEmail: string | null;
  website: string | null;
  fundingHistory: string | null;
  description: string | null;
  notes: string | null;
  grantCount: number;
}

const SORTABLE_COLUMNS = {
  name: funders.name,
  priority: funders.priority,
  type: funders.funderType,
  manager: funders.relationshipManager,
  nextStep: funders.nextStepDue,
} as const;

export type FunderSortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = "asc" | "desc";

export async function getFunders(filters?: {
  priority?: string;
  search?: string;
  sortBy?: string;
  sortDir?: string;
}): Promise<FunderListItem[]> {
  await requirePermission(PROJECT, "viewer");

  let query = db
    .select({
      id: funders.id,
      name: funders.name,
      priority: funders.priority,
      funderType: funders.funderType,
      focusAreas: funders.focusAreas,
      relationshipManager: funders.relationshipManager,
      relationshipStatus: funders.relationshipStatus,
      nextSteps: funders.nextSteps,
      nextStepDue: funders.nextStepDue,
      contactName: funders.contactName,
      contactEmail: funders.contactEmail,
      website: funders.website,
      fundingHistory: funders.fundingHistory,
      description: funders.description,
      notes: funders.notes,
      grantCount: sql<number>`COUNT(${grants.id})`,
    })
    .from(funders)
    .leftJoin(grants, eq(grants.funderId, funders.id))
    .groupBy(funders.id)
    .$dynamic();

  const where = [];
  if (filters?.priority && filters.priority !== "all") {
    where.push(eq(funders.priority, filters.priority as FunderPriority));
  }
  if (filters?.search) {
    const term = `%${filters.search}%`;
    where.push(
      sql`(${funders.name} LIKE ${term} OR ${funders.relationshipManager} LIKE ${term} OR ${funders.focusAreas} LIKE ${term})`
    );
  }
  if (where.length > 0) query = query.where(and(...where));

  const sortCol = filters?.sortBy as FunderSortColumn | undefined;
  const sortDir = filters?.sortDir === "desc" ? "desc" : "asc";
  const column =
    sortCol && sortCol in SORTABLE_COLUMNS
      ? SORTABLE_COLUMNS[sortCol]
      : funders.name;
  const orderFn = sortDir === "asc" ? asc : desc;

  return query.orderBy(orderFn(column), asc(funders.id)).all();
}

export interface FunderGrantRow {
  id: number;
  name: string;
  status: string;
  amountRequested: number | null;
  amountAwarded: number | null;
  dueDate: Date | null;
}

export interface FunderMetrics {
  total: number;
  decided: number;
  funded: number;
  hitRate: number | null; // funded / decided
  totalRequested: number;
  totalAwarded: number;
}

export async function getFunder(id: number) {
  await requirePermission(PROJECT, "viewer");
  const funder = db.select().from(funders).where(eq(funders.id, id)).get();
  if (!funder) return null;

  const linkedGrants = db
    .select({
      id: grants.id,
      name: grants.name,
      status: grants.status,
      amountRequested: grants.amountRequested,
      amountAwarded: grants.amountAwarded,
      dueDate: grants.dueDate,
    })
    .from(grants)
    .where(eq(grants.funderId, id))
    .orderBy(desc(grants.dueDate))
    .all();

  // Success-rate denominator: grants we applied to and got a verdict on. Excludes
  // "passed" (opportunities we chose not to pursue).
  const DECIDED = new Set(GRANT_SUCCESS_DENOMINATOR_STATUSES);
  const metrics: FunderMetrics = {
    total: linkedGrants.length,
    decided: 0,
    funded: 0,
    hitRate: null,
    totalRequested: 0,
    totalAwarded: 0,
  };
  for (const g of linkedGrants) {
    metrics.totalRequested += g.amountRequested ?? 0;
    metrics.totalAwarded += g.amountAwarded ?? 0;
    if (DECIDED.has(g.status)) metrics.decided++;
    if (g.status === "funded" || g.status === "completed") metrics.funded++;
  }
  if (metrics.decided > 0) metrics.hitRate = metrics.funded / metrics.decided;

  return { funder, grants: linkedGrants, metrics };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function text(v: FormDataEntryValue | null): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function parseDate(v: FormDataEntryValue | null): Date | null {
  if (v == null || String(v).trim() === "") return null;
  const d = new Date(`${String(v).trim()}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

export async function saveFunder(
  _prev: ActionResult<{ id: number }> | null,
  formData: FormData
): Promise<ActionResult<{ id: number }>> {
  const user = await requirePermission(PROJECT, "editor");

  const idRaw = formData.get("id");
  const id = idRaw ? parseInt(String(idRaw), 10) : null;

  const name = text(formData.get("name"));
  if (!name) return { success: false, error: "Funder name is required." };

  const priorityRaw = String(formData.get("priority") ?? "");
  const priority = funderPriorityEnum.includes(priorityRaw as FunderPriority)
    ? (priorityRaw as FunderPriority)
    : null;

  const values = {
    name,
    nameNormalized: normalizeFunderName(name),
    website: text(formData.get("website")),
    priority,
    funderType: text(formData.get("funderType")),
    focusAreas: text(formData.get("focusAreas")),
    relationshipManager: text(formData.get("relationshipManager")),
    relationshipStatus: text(formData.get("relationshipStatus")),
    nextSteps: text(formData.get("nextSteps")),
    nextStepDue: parseDate(formData.get("nextStepDue")),
    contactName: text(formData.get("contactName")),
    contactEmail: text(formData.get("contactEmail")),
    fundingHistory: text(formData.get("fundingHistory")),
    description: text(formData.get("description")),
    notes: text(formData.get("notes")),
    irs990Link: text(formData.get("irs990Link")),
    guidestarLink: text(formData.get("guidestarLink")),
    foundationDirectoryLink: text(formData.get("foundationDirectoryLink")),
    updatedAt: new Date(),
  };

  try {
    let savedId: number;
    if (id) {
      await db.update(funders).set(values).where(eq(funders.id, id));
      savedId = id;
    } else {
      const inserted = await db
        .insert(funders)
        .values(values)
        .returning({ id: funders.id });
      savedId = inserted[0].id;
    }

    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: id ? "funder_updated" : "funder_created",
      severity: "success",
      actorEmail: user.email,
      targetType: "funder",
      targetId: savedId,
      summary: `${id ? "Funder updated" : "Funder created"} · ${name}`,
    });

    revalidatePath("/grants/funders");
    revalidatePath(`/grants/funders/${savedId}`);
    return { success: true, data: { id: savedId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return {
        success: false,
        error: `A funder with an equivalent name to "${name}" already exists.`,
      };
    }
    return { success: false, error: msg || "Failed to save the funder." };
  }
}

export interface UpdatedFunderField {
  field: string;
  /** Canonical stored value, serialized for the client. Dates as "YYYY-MM-DD". */
  value: string | number | null;
}

/**
 * Single-field write for the inline funders row editor — mirrors
 * {@link updateGrantField}. Each field is coerced + validated server-side; the
 * field name is whitelisted so a crafted call can't touch non-displayed columns.
 * `name` is special: required, and recomputes `nameNormalized` (UNIQUE index).
 */
export async function updateFunderField(
  id: number,
  field: string,
  raw: string | null
): Promise<ActionResult<UpdatedFunderField>> {
  const user = await requirePermission(PROJECT, "editor");
  if (!(EDITABLE_FUNDER_FIELDS as readonly string[]).includes(field)) {
    return { success: false, error: "Unknown field." };
  }
  const f = field as EditableFunderField;

  const set: Partial<typeof funders.$inferInsert> = { updatedAt: new Date() };
  let canonical: string | number | null = raw;

  switch (f) {
    case "name": {
      const v = text(raw);
      if (!v) return { success: false, error: "Funder name is required." };
      set.name = v;
      set.nameNormalized = normalizeFunderName(v);
      canonical = v;
      break;
    }
    case "priority": {
      if (raw && raw !== "" && !funderPriorityEnum.includes(raw as FunderPriority)) {
        return { success: false, error: "Invalid priority." };
      }
      const v = funderPriorityEnum.includes(raw as FunderPriority)
        ? (raw as FunderPriority)
        : null;
      set.priority = v;
      canonical = v;
      break;
    }
    case "nextStepDue": {
      const d = parseDate(raw);
      set.nextStepDue = d;
      canonical = d ? d.toISOString().slice(0, 10) : null;
      break;
    }
    default: {
      // All remaining whitelisted fields are free text / long text. The field
      // name equals the Drizzle column property, so a dynamic set is safe here.
      const v = text(raw);
      (set as Record<string, unknown>)[f] = v;
      canonical = v;
      break;
    }
  }

  try {
    await db.update(funders).set(set).where(eq(funders.id, id));
    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: "funder_updated",
      actorEmail: user.email,
      targetType: "funder",
      targetId: id,
      summary: `Funder #${id}: ${f} updated`,
      details: { field: f },
    });
    revalidatePath("/grants/funders");
    revalidatePath(`/grants/funders/${id}`);
    return { success: true, data: { field: f, value: canonical } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return {
        success: false,
        error: "A funder with an equivalent name already exists.",
      };
    }
    return { success: false, error: msg || "Failed to save." };
  }
}

export async function deleteFunder(id: number): Promise<ActionResult> {
  const user = await requirePermission(PROJECT, "editor");
  try {
    const existing = db
      .select({ name: funders.name })
      .from(funders)
      .where(eq(funders.id, id))
      .get();
    // Preserve the funder name on linked grants before the FK nulls funder_id.
    if (existing) {
      await db
        .update(grants)
        .set({ funderNameRaw: existing.name })
        .where(eq(grants.funderId, id));
    }
    await db.delete(funders).where(eq(funders.id, id));
    await recordEvent({
      source: "grants",
      projectId: PROJECT,
      eventType: "funder_deleted",
      severity: "warn",
      actorEmail: user.email,
      targetType: "funder",
      targetId: id,
      summary: `Funder deleted · ${existing?.name ?? `#${id}`}`,
    });
    revalidatePath("/grants/funders");
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete the funder.",
    };
  }
}
