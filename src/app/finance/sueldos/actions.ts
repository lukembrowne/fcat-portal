"use server";

/**
 * Server actions for salary planning (/finance/sueldos).
 *
 * Reads are finance `viewer`; every mutation is finance `admin`. Each mutation
 * revalidates the page rather than the edited row, because one salary edit moves
 * three columns in two tables plus four metrics — refreshing less leaves the page
 * internally inconsistent.
 *
 * System events fire on create/delete of a person, source, or allocation, not on
 * per-field edits (those are the high-frequency case the instrumentation policy
 * says to skip). Event summaries name the person and the action, never the
 * salary figure — /admin/activity is a wider audience than finance viewers.
 */

import { requirePermission, getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financePeople,
  financePeopleGroups,
  financeSalaries,
  financeFundingSources,
  financeSalaryAllocations,
} from "@/db/schema";
import { sql, eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordEvent } from "@/lib/system-events";
import type { ActionResult } from "@/lib/types";
import { SUELDO_CATEGORIES } from "../constants";
import { monthSequence } from "../lib/calculations";
import {
  personCoverage,
  groupCoverage,
  grandTotal,
  fundedInYear,
  monthlyAmount,
  shareOfSalary,
  salaryForYear,
  salaryForMonth,
  type AllocationRow,
  type PersonRow,
  type SalaryRow,
  type Coverage,
  type GroupCoverage,
} from "../lib/sueldos-planning";
import {
  EDITABLE_PERSON_FIELDS,
  EDITABLE_SOURCE_FIELDS,
  EDITABLE_ALLOCATION_FIELDS,
  isIsoDate,
  isPlanningYear,
  type FundingStatusFilter,
} from "@/lib/finance/sueldos-fields";
import { parseAmount } from "@/lib/grants/coerce";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonPanel extends Coverage {
  id: number;
  name: string;
  role: string | null;
  groupId: number | null;
  active: boolean;
}

export interface GroupPanel extends GroupCoverage {
  id: number;
  name: string;
  description: string | null;
  members: PersonPanel[];
}

export interface AllocationLine {
  id: number;
  sourceId: number;
  personId: number | null;
  groupId: number | null;
  /** Person or group name, resolved for display. */
  targetName: string;
  targetKind: "person" | "group";
  amount: number;
  startDate: string;
  endDate: string;
  notes: string | null;
  /** Amount landing in the selected year. */
  fundedThisYear: number;
  /** Fraction of the target's salary this line covers. Null for group lines. */
  share: number | null;
}

export interface SourcePanel {
  id: number;
  name: string;
  status: "funded" | "pending";
  defaultStartDate: string | null;
  defaultEndDate: string | null;
  notes: string | null;
  lines: AllocationLine[];
  /** Sum of every line's amount, across all years. */
  totalAllocated: number;
  /** Sum landing in the selected year. */
  fundedThisYear: number;
}

export interface ChartMonth {
  month: string;
  sources: { sourceId: number; source: string; amount: number }[];
  totalFunded: number;
  /** Salary in effect that month, stepping at year boundaries. Null when the
   *  month predates the target's first salary row. */
  monthlyCost: number | null;
}

export interface ChartPanel {
  key: string;
  label: string;
  months: ChartMonth[];
}

export interface SueldosPlanningData {
  year: number;
  availableYears: number[];
  statusFilter: FundingStatusFilter;
  /** Actual salary spend from the ledger, over the layout's date range. */
  totalSpent: number;
  total: Coverage;
  groups: GroupPanel[];
  /** People belonging to no group. */
  ungrouped: PersonPanel[];
  sources: SourcePanel[];
  chart: ChartPanel[];
  /** True when no people exist yet — the page shows the import hint. */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchSueldosPlanning(
  year: number,
  statusFilter: FundingStatusFilter,
  ledgerFrom: string,
  ledgerTo: string
): Promise<ActionResult<SueldosPlanningData>> {
  await requirePermission("finance", "viewer");

  try {
    // 1. Ledger spend — unchanged behavior, driven by the layout's date range.
    const sueldoCategoryList = SUELDO_CATEGORIES.map((c) => `'${c}'`).join(",");
    const totalRow = db
      .select({ total: sql<number>`COALESCE(SUM(debe), 0)` })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND cuenta_nombre IN (${sql.raw(sueldoCategoryList)}) AND fecha >= ${ledgerFrom} AND fecha <= ${ledgerTo}`
      )
      .get();

    // 2. Planning rows.
    const groupRows = db
      .select()
      .from(financePeopleGroups)
      .orderBy(financePeopleGroups.sortOrder, financePeopleGroups.id)
      .all();

    const peopleRows = db.select().from(financePeople).orderBy(financePeople.name).all();
    const salaryRows = db.select().from(financeSalaries).all();
    const sourceRows = db
      .select()
      .from(financeFundingSources)
      .orderBy(financeFundingSources.name)
      .all();
    const allocationRows = db.select().from(financeSalaryAllocations).all();

    // 3. Apply the status filter at the source level — it governs the whole
    //    page, so every downstream figure sees the same allocation set.
    const visibleSourceIds = new Set(
      sourceRows.filter((s) => statusFilter === "all" || s.status === statusFilter).map((s) => s.id)
    );
    const visibleSources = sourceRows.filter((s) => visibleSourceIds.has(s.id));

    const people: PersonRow[] = peopleRows.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      groupId: p.groupId,
      active: p.active,
    }));
    const salaries: SalaryRow[] = salaryRows.map((s) => ({
      personId: s.personId,
      year: s.year,
      annualCost: s.annualCost,
    }));
    const allocations: AllocationRow[] = allocationRows
      .filter((a) => visibleSourceIds.has(a.sourceId))
      .map((a) => ({
        id: a.id,
        sourceId: a.sourceId,
        personId: a.personId,
        groupId: a.groupId,
        amount: a.amount,
        startDate: a.startDate,
        endDate: a.endDate,
      }));

    // 4. Roster panels.
    const personById = new Map(peopleRows.map((p) => [p.id, p]));
    const groupById = new Map(groupRows.map((g) => [g.id, g]));

    const toPanel = (p: PersonRow): PersonPanel => ({
      ...personCoverage(p, salaries, allocations, year),
      id: p.id,
      name: p.name,
      role: p.role,
      groupId: p.groupId,
      active: p.active,
    });

    const groups: GroupPanel[] = groupRows.map((g) => ({
      ...groupCoverage(g.id, people, salaries, allocations, year),
      id: g.id,
      name: g.name,
      description: g.description,
      members: people.filter((p) => p.groupId === g.id).map(toPanel),
    }));

    const ungrouped = people.filter((p) => p.groupId == null).map(toPanel);

    // 5. Source panels.
    const sources: SourcePanel[] = visibleSources.map((s) => {
      const lines: AllocationLine[] = allocationRows
        .filter((a) => a.sourceId === s.id)
        .map((a) => {
          const targetPerson = a.personId != null ? personById.get(a.personId) : undefined;
          const targetGroup = a.groupId != null ? groupById.get(a.groupId) : undefined;
          const row: AllocationRow = {
            id: a.id,
            sourceId: a.sourceId,
            personId: a.personId,
            groupId: a.groupId,
            amount: a.amount,
            startDate: a.startDate,
            endDate: a.endDate,
          };
          const annual =
            a.personId != null ? salaryForYear(salaries, a.personId, year) : null;

          return {
            id: a.id,
            sourceId: a.sourceId,
            personId: a.personId,
            groupId: a.groupId,
            targetName: targetPerson?.name ?? targetGroup?.name ?? "—",
            targetKind: a.personId != null ? ("person" as const) : ("group" as const),
            amount: a.amount,
            startDate: a.startDate,
            endDate: a.endDate,
            notes: a.notes,
            fundedThisYear: fundedInYear(row, year),
            share: a.personId != null ? shareOfSalary(row, annual) : null,
          };
        })
        .sort((x, y) => x.targetName.localeCompare(y.targetName));

      return {
        id: s.id,
        name: s.name,
        status: s.status,
        defaultStartDate: s.defaultStartDate,
        defaultEndDate: s.defaultEndDate,
        notes: s.notes,
        lines,
        totalAllocated: lines.reduce((sum, l) => sum + l.amount, 0),
        fundedThisYear: lines.reduce((sum, l) => sum + l.fundedThisYear, 0),
      };
    });

    // 6. Charts keep their own multi-year horizon — they answer "when does
    //    funding run out", which the year selector deliberately does not bound.
    const now = new Date();
    const chartMonths = monthSequence(
      `${now.getFullYear()}-01-01`,
      `${now.getFullYear() + 2}-12-01`
    );
    const sourceNameById = new Map(sourceRows.map((s) => [s.id, s.name]));

    function buildChart(
      key: string,
      label: string,
      matches: (a: AllocationRow) => boolean,
      costForMonth: (month: string) => number | null
    ): ChartPanel {
      const relevant = allocations.filter(matches);
      const months: ChartMonth[] = chartMonths.map((m) => {
        const bySource = new Map<number, number>();
        for (const a of relevant) {
          const span = monthSequence(
            `${a.startDate.slice(0, 7)}-01`,
            `${a.endDate.slice(0, 7)}-01`
          );
          if (!span.includes(m)) continue;
          bySource.set(a.sourceId, (bySource.get(a.sourceId) ?? 0) + monthlyAmount(a));
        }
        const srcs = Array.from(bySource.entries()).map(([sourceId, amount]) => ({
          sourceId,
          source: sourceNameById.get(sourceId) ?? "—",
          amount,
        }));
        return {
          month: m,
          sources: srcs,
          totalFunded: srcs.reduce((s, x) => s + x.amount, 0),
          monthlyCost: costForMonth(m),
        };
      });
      return { key, label, months };
    }

    const activePeople = people.filter((p) => p.active);
    const chart: ChartPanel[] = [];

    if (activePeople.length > 0) {
      chart.push(
        buildChart("total", "Total — Todos los Empleados", () => true, (m) => {
          const sum = activePeople.reduce(
            (s, p) => s + (salaryForMonth(salaries, p.id, m) ?? 0),
            0
          );
          return sum > 0 ? sum / 12 : null;
        })
      );
    }

    for (const g of groupRows) {
      const memberIds = new Set(
        people.filter((p) => p.groupId === g.id && p.active).map((p) => p.id)
      );
      if (memberIds.size === 0 && !allocations.some((a) => a.groupId === g.id)) continue;
      chart.push(
        buildChart(
          `group-${g.id}`,
          `${g.name} (grupo)`,
          (a) => a.groupId === g.id || (a.personId != null && memberIds.has(a.personId)),
          (m) => {
            const sum = Array.from(memberIds).reduce(
              (s, id) => s + (salaryForMonth(salaries, id, m) ?? 0),
              0
            );
            return sum > 0 ? sum / 12 : null;
          }
        )
      );
    }

    for (const p of activePeople) {
      chart.push(
        buildChart(
          `person-${p.id}`,
          p.name,
          (a) => a.personId === p.id,
          (m) => {
            const annual = salaryForMonth(salaries, p.id, m);
            return annual != null ? annual / 12 : null;
          }
        )
      );
    }

    const availableYears = Array.from(new Set(salaryRows.map((s) => s.year))).sort(
      (a, b) => b - a
    );

    return {
      success: true,
      data: {
        year,
        availableYears,
        statusFilter,
        totalSpent: totalRow?.total ?? 0,
        total: grandTotal(people, salaries, allocations, year),
        groups,
        ungrouped,
        sources,
        chart,
        empty: peopleRows.length === 0,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos de sueldos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Inline field updates
// ---------------------------------------------------------------------------

type FieldValue = string | number | null;

function ok(field: string, value: FieldValue): ActionResult<{ field: string; value: FieldValue }> {
  revalidatePath("/finance/sueldos");
  return { success: true, data: { field, value } };
}

function fail(error: string): ActionResult<{ field: string; value: FieldValue }> {
  return { success: false, error };
}

/** Distinguish a unique-constraint collision from anything else, so a duplicate
 *  name reads as a sentence rather than a stack trace. */
function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("UNIQUE constraint failed");
}

export async function updatePersonField(
  id: number,
  field: string,
  raw: string | null
): Promise<ActionResult<{ field: string; value: FieldValue }>> {
  await requirePermission("finance", "admin");

  if (!(EDITABLE_PERSON_FIELDS as readonly string[]).includes(field)) {
    return fail(`Campo no editable: ${field}`);
  }

  try {
    const trimmed = raw?.trim() ?? null;

    if (field === "name") {
      if (!trimmed) return fail("El nombre no puede estar vacío");
      try {
        db.update(financePeople)
          .set({ name: trimmed, updatedAt: new Date() })
          .where(eq(financePeople.id, id))
          .run();
      } catch (e) {
        if (isUniqueViolation(e)) return fail(`Ya existe una persona llamada "${trimmed}"`);
        throw e;
      }
      return ok(field, trimmed);
    }

    if (field === "groupId") {
      const groupId = trimmed ? Number(trimmed) : null;
      if (groupId != null && !Number.isInteger(groupId)) return fail("Grupo inválido");
      if (groupId != null) {
        const exists = db
          .select({ id: financePeopleGroups.id })
          .from(financePeopleGroups)
          .where(eq(financePeopleGroups.id, groupId))
          .get();
        if (!exists) return fail("El grupo no existe");
      }
      db.update(financePeople)
        .set({ groupId, updatedAt: new Date() })
        .where(eq(financePeople.id, id))
        .run();
      return ok(field, groupId);
    }

    if (field === "active") {
      const active = trimmed === "true" || trimmed === "1";
      db.update(financePeople)
        .set({ active, updatedAt: new Date() })
        .where(eq(financePeople.id, id))
        .run();
      return ok(field, active ? "true" : "false");
    }

    // role, notes — free text, nullable
    db.update(financePeople)
      .set({ [field]: trimmed, updatedAt: new Date() })
      .where(eq(financePeople.id, id))
      .run();
    return ok(field, trimmed);
  } catch (e) {
    return fail(`Error al guardar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Set (or clear) a person's salary for one year. The `field` slot carries the
 * YEAR rather than a column name — a salary cell is addressed by person and
 * year, and the row may not exist yet.
 */
export async function updateSalaryForYear(
  personId: number,
  field: string,
  raw: string | null
): Promise<ActionResult<{ field: string; value: FieldValue }>> {
  await requirePermission("finance", "admin");

  const year = Number(field);
  if (!isPlanningYear(year)) return fail(`Año inválido: ${field}`);

  try {
    const trimmed = raw?.trim() ?? null;

    if (!trimmed) {
      db.delete(financeSalaries)
        .where(and(eq(financeSalaries.personId, personId), eq(financeSalaries.year, year)))
        .run();
      return ok(field, null);
    }

    const amount = parseAmount(trimmed);
    if (amount == null) return fail(`Monto inválido: "${trimmed}"`);
    if (amount < 0) return fail("El sueldo no puede ser negativo");

    const existing = db
      .select({ id: financeSalaries.id })
      .from(financeSalaries)
      .where(and(eq(financeSalaries.personId, personId), eq(financeSalaries.year, year)))
      .get();

    if (existing) {
      db.update(financeSalaries)
        .set({ annualCost: amount, updatedAt: new Date() })
        .where(eq(financeSalaries.id, existing.id))
        .run();
    } else {
      db.insert(financeSalaries).values({ personId, year, annualCost: amount }).run();
    }

    return ok(field, amount);
  } catch (e) {
    return fail(`Error al guardar sueldo: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function updateSourceField(
  id: number,
  field: string,
  raw: string | null
): Promise<ActionResult<{ field: string; value: FieldValue }>> {
  await requirePermission("finance", "admin");

  if (!(EDITABLE_SOURCE_FIELDS as readonly string[]).includes(field)) {
    return fail(`Campo no editable: ${field}`);
  }

  try {
    const trimmed = raw?.trim() ?? null;

    if (field === "name") {
      if (!trimmed) return fail("El nombre no puede estar vacío");
      try {
        db.update(financeFundingSources)
          .set({ name: trimmed, updatedAt: new Date() })
          .where(eq(financeFundingSources.id, id))
          .run();
      } catch (e) {
        if (isUniqueViolation(e)) return fail(`Ya existe una fuente llamada "${trimmed}"`);
        throw e;
      }
      return ok(field, trimmed);
    }

    if (field === "status") {
      if (trimmed !== "funded" && trimmed !== "pending") return fail("Estado inválido");
      db.update(financeFundingSources)
        .set({ status: trimmed, updatedAt: new Date() })
        .where(eq(financeFundingSources.id, id))
        .run();
      return ok(field, trimmed);
    }

    if (field === "defaultStartDate" || field === "defaultEndDate") {
      if (trimmed && !isIsoDate(trimmed)) return fail(`Fecha inválida: "${trimmed}"`);
      db.update(financeFundingSources)
        .set({ [field]: trimmed, updatedAt: new Date() })
        .where(eq(financeFundingSources.id, id))
        .run();
      return ok(field, trimmed);
    }

    db.update(financeFundingSources)
      .set({ notes: trimmed, updatedAt: new Date() })
      .where(eq(financeFundingSources.id, id))
      .run();
    return ok(field, trimmed);
  } catch (e) {
    return fail(`Error al guardar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function updateAllocationField(
  id: number,
  field: string,
  raw: string | null
): Promise<ActionResult<{ field: string; value: FieldValue }>> {
  await requirePermission("finance", "admin");

  if (!(EDITABLE_ALLOCATION_FIELDS as readonly string[]).includes(field)) {
    return fail(`Campo no editable: ${field}`);
  }

  try {
    const trimmed = raw?.trim() ?? null;

    if (field === "amount") {
      const amount = parseAmount(trimmed);
      if (amount == null) return fail(`Monto inválido: "${trimmed ?? ""}"`);
      db.update(financeSalaryAllocations)
        .set({ amount, updatedAt: new Date() })
        .where(eq(financeSalaryAllocations.id, id))
        .run();
      return ok(field, amount);
    }

    if (field === "startDate" || field === "endDate") {
      if (!trimmed || !isIsoDate(trimmed)) return fail(`Fecha inválida: "${trimmed ?? ""}"`);
      db.update(financeSalaryAllocations)
        .set({ [field]: trimmed, updatedAt: new Date() })
        .where(eq(financeSalaryAllocations.id, id))
        .run();
      return ok(field, trimmed);
    }

    // Retargeting: "person:12" / "group:3". Both columns move together so the
    // person-XOR-group CHECK is never momentarily violated.
    if (field === "personId" || field === "groupId") {
      if (!trimmed) return fail("Debe seleccionar una persona o un grupo");
      const [kind, idStr] = trimmed.split(":");
      const targetId = Number(idStr);
      if (!Number.isInteger(targetId)) return fail("Destino inválido");

      if (kind === "person") {
        const exists = db
          .select({ id: financePeople.id })
          .from(financePeople)
          .where(eq(financePeople.id, targetId))
          .get();
        if (!exists) return fail("La persona no existe");
        db.update(financeSalaryAllocations)
          .set({ personId: targetId, groupId: null, updatedAt: new Date() })
          .where(eq(financeSalaryAllocations.id, id))
          .run();
      } else if (kind === "group") {
        const exists = db
          .select({ id: financePeopleGroups.id })
          .from(financePeopleGroups)
          .where(eq(financePeopleGroups.id, targetId))
          .get();
        if (!exists) return fail("El grupo no existe");
        db.update(financeSalaryAllocations)
          .set({ groupId: targetId, personId: null, updatedAt: new Date() })
          .where(eq(financeSalaryAllocations.id, id))
          .run();
      } else {
        return fail("Destino inválido");
      }
      return ok(field, trimmed);
    }

    if (field === "sourceId") {
      const sourceId = Number(trimmed);
      if (!Number.isInteger(sourceId)) return fail("Fuente inválida");
      const exists = db
        .select({ id: financeFundingSources.id })
        .from(financeFundingSources)
        .where(eq(financeFundingSources.id, sourceId))
        .get();
      if (!exists) return fail("La fuente no existe");
      db.update(financeSalaryAllocations)
        .set({ sourceId, updatedAt: new Date() })
        .where(eq(financeSalaryAllocations.id, id))
        .run();
      return ok(field, sourceId);
    }

    db.update(financeSalaryAllocations)
      .set({ notes: trimmed, updatedAt: new Date() })
      .where(eq(financeSalaryAllocations.id, id))
      .run();
    return ok(field, trimmed);
  } catch (e) {
    return fail(`Error al guardar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Create / delete
// ---------------------------------------------------------------------------

export async function createPerson(input: {
  name: string;
  role: string | null;
  groupId: number | null;
  year: number;
  annualCost: string | null;
}): Promise<ActionResult<{ id: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const name = input.name.trim();
  if (!name) return { success: false, error: "El nombre es obligatorio" };
  if (!isPlanningYear(input.year)) {
    return { success: false, error: `Año inválido: ${input.year}` };
  }

  let annualCost: number | null = null;
  if (input.annualCost && input.annualCost.trim()) {
    annualCost = parseAmount(input.annualCost);
    if (annualCost == null) {
      return { success: false, error: `Monto inválido: "${input.annualCost}"` };
    }
    if (annualCost < 0) return { success: false, error: "El sueldo no puede ser negativo" };
  }

  try {
    const inserted = db
      .insert(financePeople)
      .values({ name, role: input.role?.trim() || null, groupId: input.groupId })
      .returning({ id: financePeople.id })
      .get();

    if (annualCost != null) {
      db.insert(financeSalaries)
        .values({ personId: inserted.id, year: input.year, annualCost })
        .run();
    }

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_person_created",
      summary: `Persona agregada a sueldos: ${name}`,
      severity: "info",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_person",
      targetId: String(inserted.id),
      details: { name, year: input.year, hasSalary: annualCost != null },
    });

    revalidatePath("/finance/sueldos");
    return { success: true, data: { id: inserted.id } };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { success: false, error: `Ya existe una persona llamada "${name}"` };
    }
    return {
      success: false,
      error: `Error al crear persona: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function deletePerson(id: number): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  try {
    const person = db
      .select({ name: financePeople.name })
      .from(financePeople)
      .where(eq(financePeople.id, id))
      .get();
    if (!person) return { success: false, error: "La persona no existe" };

    // Salaries and person-named allocations cascade; pooled group lines don't.
    db.delete(financePeople).where(eq(financePeople.id, id)).run();

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_person_deleted",
      summary: `Persona eliminada de sueldos: ${person.name}`,
      severity: "warn",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_person",
      targetId: String(id),
      details: { name: person.name },
    });

    revalidatePath("/finance/sueldos");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al eliminar persona: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function createFundingSource(input: {
  name: string;
  status: "funded" | "pending";
  defaultStartDate: string | null;
  defaultEndDate: string | null;
}): Promise<ActionResult<{ id: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const name = input.name.trim();
  if (!name) return { success: false, error: "El nombre es obligatorio" };
  for (const d of [input.defaultStartDate, input.defaultEndDate]) {
    if (d && !isIsoDate(d)) return { success: false, error: `Fecha inválida: "${d}"` };
  }

  try {
    const inserted = db
      .insert(financeFundingSources)
      .values({
        name,
        status: input.status,
        defaultStartDate: input.defaultStartDate,
        defaultEndDate: input.defaultEndDate,
      })
      .returning({ id: financeFundingSources.id })
      .get();

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_source_created",
      summary: `Fuente de financiamiento agregada: ${name} (${input.status === "funded" ? "financiado" : "pendiente"})`,
      severity: "info",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_funding_source",
      targetId: String(inserted.id),
      details: { name, status: input.status },
    });

    revalidatePath("/finance/sueldos");
    return { success: true, data: { id: inserted.id } };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { success: false, error: `Ya existe una fuente llamada "${name}"` };
    }
    return {
      success: false,
      error: `Error al crear fuente: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function deleteFundingSource(id: number): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  try {
    const source = db
      .select({ name: financeFundingSources.name })
      .from(financeFundingSources)
      .where(eq(financeFundingSources.id, id))
      .get();
    if (!source) return { success: false, error: "La fuente no existe" };

    const lineCount = db
      .select({ n: sql<number>`COUNT(*)` })
      .from(financeSalaryAllocations)
      .where(eq(financeSalaryAllocations.sourceId, id))
      .get();

    db.delete(financeFundingSources).where(eq(financeFundingSources.id, id)).run();

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_source_deleted",
      summary: `Fuente de financiamiento eliminada: ${source.name} (${lineCount?.n ?? 0} línea${lineCount?.n === 1 ? "" : "s"})`,
      severity: "warn",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_funding_source",
      targetId: String(id),
      details: { name: source.name, lineCount: lineCount?.n ?? 0 },
    });

    revalidatePath("/finance/sueldos");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al eliminar fuente: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function createAllocation(input: {
  sourceId: number;
  /** "person:12" or "group:3" */
  target: string;
  amount: string;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
}): Promise<ActionResult<{ id: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const source = db
    .select()
    .from(financeFundingSources)
    .where(eq(financeFundingSources.id, input.sourceId))
    .get();
  if (!source) return { success: false, error: "La fuente no existe" };

  const amount = parseAmount(input.amount);
  if (amount == null) return { success: false, error: `Monto inválido: "${input.amount}"` };

  // Unset dates inherit the source's default period.
  const startDate = input.startDate?.trim() || source.defaultStartDate;
  const endDate = input.endDate?.trim() || source.defaultEndDate;
  if (!startDate || !endDate) {
    return {
      success: false,
      error: "Debe indicar fechas de inicio y fin (o definirlas en la fuente)",
    };
  }
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    return { success: false, error: "Fechas inválidas" };
  }
  if (endDate < startDate) {
    return { success: false, error: "La fecha de fin no puede ser anterior a la de inicio" };
  }

  const [kind, idStr] = input.target.split(":");
  const targetId = Number(idStr);
  if (!Number.isInteger(targetId) || (kind !== "person" && kind !== "group")) {
    return { success: false, error: "Debe seleccionar una persona o un grupo" };
  }

  try {
    const targetName =
      kind === "person"
        ? db
            .select({ name: financePeople.name })
            .from(financePeople)
            .where(eq(financePeople.id, targetId))
            .get()?.name
        : db
            .select({ name: financePeopleGroups.name })
            .from(financePeopleGroups)
            .where(eq(financePeopleGroups.id, targetId))
            .get()?.name;

    if (!targetName) {
      return { success: false, error: kind === "person" ? "La persona no existe" : "El grupo no existe" };
    }

    const inserted = db
      .insert(financeSalaryAllocations)
      .values({
        sourceId: input.sourceId,
        personId: kind === "person" ? targetId : null,
        groupId: kind === "group" ? targetId : null,
        amount,
        startDate,
        endDate,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: financeSalaryAllocations.id })
      .get();

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_allocation_created",
      summary: `Línea de financiamiento agregada: ${source.name} → ${targetName}`,
      severity: "info",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_salary_allocation",
      targetId: String(inserted.id),
      details: { source: source.name, target: targetName, startDate, endDate },
    });

    revalidatePath("/finance/sueldos");
    return { success: true, data: { id: inserted.id } };
  } catch (e) {
    return {
      success: false,
      error: `Error al crear línea: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function deleteAllocation(id: number): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  try {
    const line = db
      .select({
        sourceName: financeFundingSources.name,
        personId: financeSalaryAllocations.personId,
        groupId: financeSalaryAllocations.groupId,
      })
      .from(financeSalaryAllocations)
      .innerJoin(
        financeFundingSources,
        eq(financeSalaryAllocations.sourceId, financeFundingSources.id)
      )
      .where(eq(financeSalaryAllocations.id, id))
      .get();
    if (!line) return { success: false, error: "La línea no existe" };

    db.delete(financeSalaryAllocations).where(eq(financeSalaryAllocations.id, id)).run();

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_allocation_deleted",
      summary: `Línea de financiamiento eliminada: ${line.sourceName}`,
      severity: "warn",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_salary_allocation",
      targetId: String(id),
      details: { source: line.sourceName },
    });

    revalidatePath("/finance/sueldos");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al eliminar línea: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Groups and people, for the allocation target picker and the person dialog. */
export async function fetchSueldosTargets(): Promise<
  ActionResult<{
    groups: { id: number; name: string }[];
    people: { id: number; name: string; groupId: number | null }[];
  }>
> {
  await requirePermission("finance", "viewer");
  try {
    return {
      success: true,
      data: {
        groups: db
          .select({ id: financePeopleGroups.id, name: financePeopleGroups.name })
          .from(financePeopleGroups)
          .orderBy(financePeopleGroups.sortOrder)
          .all(),
        people: db
          .select({
            id: financePeople.id,
            name: financePeople.name,
            groupId: financePeople.groupId,
          })
          .from(financePeople)
          .orderBy(financePeople.name)
          .all(),
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar destinos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
