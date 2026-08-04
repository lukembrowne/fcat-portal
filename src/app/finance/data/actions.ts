"use server";

import { requirePermission, getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeBudgetItems,
  financePeople,
  financePeopleGroups,
  financeSalaries,
  financeFundingSources,
  financeSalaryAllocations,
  financeUploads,
} from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import type { UploadPreview } from "../types";
import { parseLibroMayor } from "../lib/parse-libro-mayor";
import { parseBudgetExcel } from "../lib/parse-budget";
import { parseSueldosExcel, normalizeName } from "../lib/parse-sueldos";
import { isPlanningYear } from "@/lib/finance/sueldos-fields";
import { revalidatePath } from "next/cache";
import { sql, eq, and } from "drizzle-orm";
import { recordEvent } from "@/lib/system-events";

// --- LibroMayor upload ---

export async function previewLibroMayor(
  formData: FormData
): Promise<ActionResult<UploadPreview & { parseErrors: string[] }>> {
  await requirePermission("finance", "admin");

  const file = formData.get("file") as File | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };
  if (!file.name.endsWith(".csv")) {
    return { success: false, error: "El archivo debe ser un CSV (.csv)" };
  }

  try {
    const buffer = await file.arrayBuffer();
    const { rows, errors } = parseLibroMayor(buffer);

    if (rows.length === 0 && errors.length > 0) {
      return { success: false, error: errors.join("; ") };
    }

    const dates = rows.map((r) => r.fecha).sort();
    return {
      success: true,
      data: {
        rowCount: rows.length,
        dateRange:
          dates.length > 0
            ? { min: dates[0], max: dates[dates.length - 1] }
            : undefined,
        parseErrors: errors,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar archivo: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function commitLibroMayor(
  formData: FormData
): Promise<ActionResult<{ rowCount: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const file = formData.get("file") as File | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  try {
    const buffer = await file.arrayBuffer();
    const { rows, errors } = parseLibroMayor(buffer);

    if (rows.length === 0) {
      return { success: false, error: errors.join("; ") || "No se encontraron transacciones" };
    }

    // Transaction: delete all old rows, insert new ones (atomic)
    db.transaction((tx) => {
      tx.run(sql`DELETE FROM finance_transactions`);

      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        tx.insert(financeTransactions).values(batch).run();
      }

      tx.insert(financeUploads)
        .values({
          fileType: "libro_mayor",
          fileName: file.name,
          rowCount: rows.length,
          uploadedBy: user?.email || "unknown",
        })
        .run();
    });

    db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);
    await recordEvent({
      source: "finance",
      eventType: "finance_upload_libro_mayor",
      summary: `Libro Mayor cargado: ${file.name} (${rows.length} fila${rows.length === 1 ? "" : "s"})`,
      severity: "success",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_upload",
      details: { fileName: file.name, rowCount: rows.length, fileType: "libro_mayor" },
    });
    revalidatePath("/finance");
    return { success: true, data: { rowCount: rows.length } };
  } catch (e) {
    return {
      success: false,
      error: `Error al guardar datos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// --- Budget upload ---

export interface BudgetNewCategory {
  category: string;
  amount: number;
}

export interface BudgetPreview {
  /** Budget-year column the parser actually read from the file. */
  detectedYear: number;
  /** Year the uploader asked for (current year). */
  requestedYear: number;
  /** True when the requested year column was absent and another was used. */
  yearMismatch: boolean;
  /** Count of rows that will import without review (allowlist ∪ already-known). */
  knownCount: number;
  /** Sum of the known rows' amounts. */
  knownTotal: number;
  /**
   * Categories found in the file that are neither in the recognized allowlist
   * nor already present in the budget — the uploader chooses which to include.
   */
  newCategories: BudgetNewCategory[];
  /**
   * Categories in the current budget that are NOT in this file. Because upload
   * replaces all budget data, these would be deleted — surfaced so a truncated
   * or wrong file can't silently wipe lines.
   */
  removedCategories: string[];
  /** Parser warnings (e.g. total vs. summary-sheet reconciliation mismatch). */
  warnings: string[];
}

/** Distinct categories already stored in the budget (any year). */
function existingBudgetCategories(): Set<string> {
  const rows = db
    .selectDistinct({ category: financeBudgetItems.category })
    .from(financeBudgetItems)
    .all();
  return new Set(rows.map((r) => r.category));
}

/**
 * Pre-flight parse of a budget file. Reports which categories will import
 * cleanly and which are new/unrecognized, so the uploader can approve the new
 * ones instead of having them silently dropped.
 */
export async function previewBudget(
  formData: FormData
): Promise<ActionResult<BudgetPreview>> {
  await requirePermission("finance", "admin");

  const file = formData.get("file") as File | null;
  const yearStr = formData.get("year") as string | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  const budgetYear = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

  try {
    const buffer = await file.arrayBuffer();
    const {
      items,
      unknownItems,
      errors,
      budgetYear: detectedYear,
    } = parseBudgetExcel(buffer, budgetYear);

    if (items.length === 0 && unknownItems.length === 0) {
      return {
        success: false,
        error: errors.join("; ") || "No se encontraron items de presupuesto",
      };
    }

    // Categories already stored count as known (they were approved before), so
    // re-uploading the same file doesn't re-prompt for them.
    const known = existingBudgetCategories();
    const knownRows = [...items, ...unknownItems.filter((u) => known.has(u.category))];
    const newCategories = unknownItems
      .filter((u) => !known.has(u.category))
      .map((u) => ({ category: u.category, amount: u.amount }));

    // Categories in the current budget that this file does not contain — they
    // would be dropped by the replace-all commit.
    const fileCategories = new Set([
      ...items.map((i) => i.category),
      ...unknownItems.map((u) => u.category),
    ]);
    const removedCategories = [...known]
      .filter((c) => !fileCategories.has(c))
      .sort((a, b) => a.localeCompare(b));

    return {
      success: true,
      data: {
        detectedYear,
        requestedYear: budgetYear,
        yearMismatch: detectedYear !== budgetYear,
        knownCount: knownRows.length,
        knownTotal: knownRows.reduce((sum, r) => sum + r.amount, 0),
        newCategories,
        removedCategories,
        warnings: errors,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al analizar presupuesto: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function commitBudget(
  formData: FormData
): Promise<ActionResult<{ itemCount: number; newCount: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const file = formData.get("file") as File | null;
  const yearStr = formData.get("year") as string | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  const budgetYear = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

  // Categories the uploader explicitly approved on the pre-flight step.
  let approvedCategories: string[] = [];
  const approvedRaw = formData.get("approvedCategories");
  if (typeof approvedRaw === "string" && approvedRaw) {
    try {
      const parsed = JSON.parse(approvedRaw);
      if (Array.isArray(parsed)) approvedCategories = parsed.map(String);
    } catch {
      // ignore malformed approval payload — treat as none approved
    }
  }

  try {
    const buffer = await file.arrayBuffer();
    const { items, unknownItems, errors } = parseBudgetExcel(buffer, budgetYear);

    // Effective import set = allowlist rows + unrecognized rows that are either
    // already stored (previously approved) or approved on this upload.
    const approveSet = new Set([
      ...existingBudgetCategories(),
      ...approvedCategories,
    ]);
    const includedUnknown = unknownItems.filter((u) => approveSet.has(u.category));
    const allItems = [...items, ...includedUnknown];

    if (allItems.length === 0) {
      return {
        success: false,
        error: errors.join("; ") || "No se encontraron items de presupuesto",
      };
    }

    db.transaction((tx) => {
      tx.run(sql`DELETE FROM finance_budget_items`);
      tx.insert(financeBudgetItems).values(allItems).run();

      tx.insert(financeUploads)
        .values({
          fileType: "budget",
          fileName: file.name,
          rowCount: allItems.length,
          uploadedBy: user?.email || "unknown",
        })
        .run();
    });

    db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);
    await recordEvent({
      source: "finance",
      eventType: "finance_upload_budget",
      summary: `Presupuesto ${budgetYear} cargado: ${file.name} (${allItems.length} item${allItems.length === 1 ? "" : "s"}${includedUnknown.length > 0 ? `, ${includedUnknown.length} nueva${includedUnknown.length === 1 ? "" : "s"}` : ""})`,
      severity: "success",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_upload",
      details: {
        fileName: file.name,
        rowCount: allItems.length,
        newCategories: includedUnknown.map((u) => u.category),
        budgetYear,
        fileType: "budget",
      },
    });
    revalidatePath("/finance");
    return {
      success: true,
      data: { itemCount: allItems.length, newCount: includedUnknown.length },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar presupuesto: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// --- Sueldos import ---
//
// Unlike the other finance uploads, this one UPSERTS. Replace-all is safe when
// a file is the only source of truth; once salaries are edited on the page it
// would silently destroy that work. So: match by name, update what is found,
// insert what is not, delete nothing. Allocation targets that can't be matched
// block the commit rather than being dropped — that silent drop is the specific
// defect the old importer had.

export interface SueldosImportPreview {
  detectedYear: number | null;
  requestedYear: number;
  /** People in the file that don't exist yet. */
  newPeople: { name: string; role: string | null; group: string | null; annualCost: number }[];
  /** People that exist and whose salary for this year the file would CHANGE. */
  salaryChanges: { name: string; from: number | null; to: number }[];
  /** People that exist with this salary already — no-ops. */
  unchangedCount: number;
  newSources: { name: string; status: "funded" | "pending" }[];
  existingSourceCount: number;
  allocationCount: number;
  /**
   * Allocation targets that matched neither a person nor a group. The commit
   * refuses while any of these are unresolved.
   */
  unresolvedTargets: { rawTarget: string; lineCount: number; suggestions: string[] }[];
  /** Options the resolver offers: every person and group known after import. */
  resolutionOptions: { value: string; label: string }[];
  warnings: string[];
}

/** Everything the parse + matching step produces, shared by preview and commit. */
function analyzeSueldosFile(parsed: ReturnType<typeof parseSueldosExcel>, year: number) {
  const existingPeople = db
    .select({
      id: financePeople.id,
      name: financePeople.name,
      groupId: financePeople.groupId,
    })
    .from(financePeople)
    .all();
  const existingGroups = db
    .select({ id: financePeopleGroups.id, name: financePeopleGroups.name })
    .from(financePeopleGroups)
    .all();
  const existingSources = db
    .select({ id: financeFundingSources.id, name: financeFundingSources.name })
    .from(financeFundingSources)
    .all();
  const existingSalaries = db
    .select({
      personId: financeSalaries.personId,
      year: financeSalaries.year,
      annualCost: financeSalaries.annualCost,
    })
    .from(financeSalaries)
    .all();

  const personByKey = new Map(existingPeople.map((p) => [normalizeName(p.name), p]));
  const groupByKey = new Map(existingGroups.map((g) => [normalizeName(g.name), g]));
  const sourceByKey = new Map(existingSources.map((s) => [normalizeName(s.name), s]));
  const salaryByPersonYear = new Map(
    existingSalaries.map((s) => [`${s.personId}:${s.year}`, s.annualCost])
  );

  // People from the file, plus the ones already stored, form the match universe
  // — an allocation may name someone the salary sheet doesn't list.
  const fileKeys = new Set(parsed.people.map((p) => normalizeName(p.name)));
  const knownPersonKeys = new Set([...personByKey.keys(), ...fileKeys]);
  const knownGroupKeys = new Set([
    ...groupByKey.keys(),
    ...parsed.groups.map((g) => normalizeName(g)),
  ]);

  const unresolved = new Map<string, number>();
  for (const a of parsed.allocations) {
    if (knownPersonKeys.has(a.targetKey) || knownGroupKeys.has(a.targetKey)) continue;
    unresolved.set(a.rawTarget, (unresolved.get(a.rawTarget) ?? 0) + 1);
  }

  return {
    existingPeople,
    existingGroups,
    personByKey,
    groupByKey,
    sourceByKey,
    salaryByPersonYear,
    unresolved,
    year,
  };
}

/** First-letter + surname overlap, used only to ORDER the manual picker. Never
 *  used to auto-match — see the Zambrano note in parse-sueldos.ts. */
function suggestionsFor(
  rawTarget: string,
  people: { name: string }[],
  groups: { name: string }[]
): string[] {
  const target = normalizeName(rawTarget);
  const parts = target.split(" ").filter(Boolean);
  const scored = [
    ...people.map((p) => ({ label: p.name, key: normalizeName(p.name) })),
    ...groups.map((g) => ({ label: g.name, key: normalizeName(g.name) })),
  ].map((c) => {
    const cParts = c.key.split(" ").filter(Boolean);
    const shared = parts.filter((p) => cParts.includes(p)).length;
    return { label: c.label, shared };
  });
  return scored
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 5)
    .map((s) => s.label);
}

export async function previewSueldosImport(
  formData: FormData
): Promise<ActionResult<SueldosImportPreview>> {
  await requirePermission("finance", "admin");

  const file = formData.get("file") as File | null;
  const yearRaw = formData.get("year");
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  try {
    const parsed = parseSueldosExcel(await file.arrayBuffer());
    if (parsed.errors.length > 0) {
      return { success: false, error: parsed.errors.join("; ") };
    }

    const year =
      typeof yearRaw === "string" && yearRaw
        ? parseInt(yearRaw, 10)
        : (parsed.detectedYear ?? new Date().getFullYear());
    if (!isPlanningYear(year)) {
      return { success: false, error: `Año inválido: ${year}` };
    }

    const a = analyzeSueldosFile(parsed, year);

    const newPeople: SueldosImportPreview["newPeople"] = [];
    const salaryChanges: SueldosImportPreview["salaryChanges"] = [];
    let unchangedCount = 0;

    for (const p of parsed.people) {
      const existing = a.personByKey.get(normalizeName(p.name));
      if (!existing) {
        newPeople.push({
          name: p.name,
          role: p.role,
          group: p.group,
          annualCost: p.annualCost,
        });
        continue;
      }
      const current = a.salaryByPersonYear.get(`${existing.id}:${year}`) ?? null;
      if (current == null || Math.abs(current - p.annualCost) > 0.005) {
        salaryChanges.push({ name: existing.name, from: current, to: p.annualCost });
      } else {
        unchangedCount++;
      }
    }

    const newSources = parsed.sources
      .filter((s) => !a.sourceByKey.has(normalizeName(s.name)))
      .map((s) => ({ name: s.name, status: s.status }));

    const resolutionOptions = [
      ...a.existingGroups.map((g) => ({ value: `group:${g.name}`, label: `${g.name} (grupo)` })),
      ...[
        ...new Set([...a.existingPeople.map((p) => p.name), ...parsed.people.map((p) => p.name)]),
      ]
        .sort((x, y) => x.localeCompare(y, "es"))
        .map((n) => ({ value: `person:${n}`, label: n })),
    ];

    return {
      success: true,
      data: {
        detectedYear: parsed.detectedYear,
        requestedYear: year,
        newPeople,
        salaryChanges,
        unchangedCount,
        newSources,
        existingSourceCount: parsed.sources.length - newSources.length,
        allocationCount: parsed.allocations.length,
        unresolvedTargets: [...a.unresolved.entries()].map(([rawTarget, lineCount]) => ({
          rawTarget,
          lineCount,
          suggestions: suggestionsFor(
            rawTarget,
            [...a.existingPeople, ...parsed.people.map((p) => ({ name: p.name }))],
            a.existingGroups
          ),
        })),
        resolutionOptions,
        warnings: parsed.warnings,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al analizar el archivo: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function commitSueldosImport(
  formData: FormData
): Promise<ActionResult<{
  peopleCreated: number;
  salariesWritten: number;
  sourcesCreated: number;
  allocationsCreated: number;
}>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const file = formData.get("file") as File | null;
  const yearRaw = formData.get("year");
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  // { "Luzia Mendez": "person:Lucia Mendez" } from the preview's resolver.
  let resolutions: Record<string, string> = {};
  const resolutionsRaw = formData.get("resolutions");
  if (typeof resolutionsRaw === "string" && resolutionsRaw) {
    try {
      const parsedRes = JSON.parse(resolutionsRaw);
      if (parsedRes && typeof parsedRes === "object") {
        resolutions = parsedRes as Record<string, string>;
      }
    } catch {
      return { success: false, error: "No se pudieron leer las correspondencias de nombres" };
    }
  }

  try {
    const parsed = parseSueldosExcel(await file.arrayBuffer());
    if (parsed.errors.length > 0) {
      return { success: false, error: parsed.errors.join("; ") };
    }

    const year =
      typeof yearRaw === "string" && yearRaw
        ? parseInt(yearRaw, 10)
        : (parsed.detectedYear ?? new Date().getFullYear());
    if (!isPlanningYear(year)) {
      return { success: false, error: `Año inválido: ${year}` };
    }

    const a = analyzeSueldosFile(parsed, year);

    // Every unresolved target must have been mapped, or nothing is written.
    const stillUnresolved = [...a.unresolved.keys()].filter((t) => !resolutions[t]);
    if (stillUnresolved.length > 0) {
      return {
        success: false,
        error: `Faltan correspondencias para: ${stillUnresolved.join(", ")}`,
      };
    }

    let peopleCreated = 0;
    let salariesWritten = 0;
    let sourcesCreated = 0;
    let allocationsCreated = 0;

    db.transaction((tx) => {
      const groupIdByKey = new Map(
        tx
          .select({ id: financePeopleGroups.id, name: financePeopleGroups.name })
          .from(financePeopleGroups)
          .all()
          .map((g) => [normalizeName(g.name), g.id])
      );

      // Groups the file references but the database lacks (only if push-schema
      // seeding was skipped).
      for (const gName of parsed.groups) {
        if (groupIdByKey.has(normalizeName(gName))) continue;
        const row = tx
          .insert(financePeopleGroups)
          .values({ name: gName })
          .returning({ id: financePeopleGroups.id })
          .get();
        groupIdByKey.set(normalizeName(gName), row.id);
      }

      // --- People + salaries (upsert; never delete) ---
      const personIdByKey = new Map(
        tx
          .select({ id: financePeople.id, name: financePeople.name })
          .from(financePeople)
          .all()
          .map((p) => [normalizeName(p.name), p.id])
      );

      for (const p of parsed.people) {
        const key = normalizeName(p.name);
        const groupId = p.group ? (groupIdByKey.get(normalizeName(p.group)) ?? null) : null;
        let personId = personIdByKey.get(key);

        if (personId == null) {
          const row = tx
            .insert(financePeople)
            .values({ name: p.name, role: p.role, groupId })
            .returning({ id: financePeople.id })
            .get();
          personId = row.id;
          personIdByKey.set(key, personId);
          peopleCreated++;
        } else {
          tx.update(financePeople)
            .set({ role: p.role, groupId, updatedAt: new Date() })
            .where(eq(financePeople.id, personId))
            .run();
        }

        const existingSalary = tx
          .select({ id: financeSalaries.id })
          .from(financeSalaries)
          .where(and(eq(financeSalaries.personId, personId), eq(financeSalaries.year, year)))
          .get();

        if (existingSalary) {
          tx.update(financeSalaries)
            .set({ annualCost: p.annualCost, updatedAt: new Date() })
            .where(eq(financeSalaries.id, existingSalary.id))
            .run();
        } else {
          tx.insert(financeSalaries)
            .values({ personId, year, annualCost: p.annualCost })
            .run();
        }
        salariesWritten++;
      }

      // --- Sources (upsert) ---
      const sourceIdByKey = new Map(
        tx
          .select({ id: financeFundingSources.id, name: financeFundingSources.name })
          .from(financeFundingSources)
          .all()
          .map((s) => [normalizeName(s.name), s.id])
      );

      for (const s of parsed.sources) {
        const key = normalizeName(s.name);
        const existingId = sourceIdByKey.get(key);
        if (existingId == null) {
          const row = tx
            .insert(financeFundingSources)
            .values({
              name: s.name,
              status: s.status,
              defaultStartDate: s.defaultStartDate,
              defaultEndDate: s.defaultEndDate,
            })
            .returning({ id: financeFundingSources.id })
            .get();
          sourceIdByKey.set(key, row.id);
          sourcesCreated++;
        } else {
          tx.update(financeFundingSources)
            .set({ status: s.status, updatedAt: new Date() })
            .where(eq(financeFundingSources.id, existingId))
            .run();
        }
      }

      // --- Allocation lines ---
      // Re-running must not duplicate: a line is identified by
      // (source, target, amount, period), and an exact repeat is skipped.
      const existingLines = new Set(
        tx
          .select({
            sourceId: financeSalaryAllocations.sourceId,
            personId: financeSalaryAllocations.personId,
            groupId: financeSalaryAllocations.groupId,
            amount: financeSalaryAllocations.amount,
            startDate: financeSalaryAllocations.startDate,
            endDate: financeSalaryAllocations.endDate,
          })
          .from(financeSalaryAllocations)
          .all()
          .map(
            (l) =>
              `${l.sourceId}|${l.personId ?? ""}|${l.groupId ?? ""}|${l.amount}|${l.startDate}|${l.endDate}`
          )
      );

      for (const alloc of parsed.allocations) {
        const sourceId = sourceIdByKey.get(normalizeName(alloc.sourceName));
        if (sourceId == null) continue;

        // Resolve the target: direct key match first, then the user's mapping.
        let personId: number | null = null;
        let groupId: number | null = null;

        const directGroup = groupIdByKey.get(alloc.targetKey);
        const directPerson = personIdByKey.get(alloc.targetKey);

        if (directGroup != null) groupId = directGroup;
        else if (directPerson != null) personId = directPerson;
        else {
          const mapping = resolutions[alloc.rawTarget];
          if (!mapping) continue;
          const idx = mapping.indexOf(":");
          const kind = mapping.slice(0, idx);
          const name = normalizeName(mapping.slice(idx + 1));
          if (kind === "group") groupId = groupIdByKey.get(name) ?? null;
          else personId = personIdByKey.get(name) ?? null;
          if (personId == null && groupId == null) continue;
        }

        const fingerprint = `${sourceId}|${personId ?? ""}|${groupId ?? ""}|${alloc.amount}|${alloc.startDate}|${alloc.endDate}`;
        if (existingLines.has(fingerprint)) continue;
        existingLines.add(fingerprint);

        tx.insert(financeSalaryAllocations)
          .values({
            sourceId,
            personId,
            groupId,
            amount: alloc.amount,
            startDate: alloc.startDate,
            endDate: alloc.endDate,
            notes: alloc.notes,
          })
          .run();
        allocationsCreated++;
      }

      tx.insert(financeUploads)
        .values({
          fileType: "sueldos",
          fileName: file.name,
          rowCount: parsed.people.length + parsed.allocations.length,
          uploadedBy: user?.email || "unknown",
        })
        .run();
    });

    db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);

    await recordEvent({
      source: "finance",
      eventType: "finance_sueldos_import",
      summary: `Sueldos importados desde ${file.name}: ${peopleCreated} persona${peopleCreated === 1 ? "" : "s"} nueva${peopleCreated === 1 ? "" : "s"}, ${sourcesCreated} fuente${sourcesCreated === 1 ? "" : "s"} nueva${sourcesCreated === 1 ? "" : "s"}, ${allocationsCreated} línea${allocationsCreated === 1 ? "" : "s"} (año ${year})`,
      severity: "success",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_upload",
      details: {
        fileName: file.name,
        year,
        peopleCreated,
        salariesWritten,
        sourcesCreated,
        allocationsCreated,
      },
    });

    revalidatePath("/finance/sueldos");
    revalidatePath("/finance/data");
    return {
      success: true,
      data: { peopleCreated, salariesWritten, sourcesCreated, allocationsCreated },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al importar sueldos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// --- Fetch last upload info ---

export async function fetchLastUploads(): Promise<
  ActionResult<
    Record<string, { fileName: string; uploadedBy: string; uploadedAt: Date; rowCount: number | null } | null>
  >
> {
  await requirePermission("finance", "viewer");

  try {
    const types = ["libro_mayor", "budget", "sueldos"] as const;
    const result: Record<string, { fileName: string; uploadedBy: string; uploadedAt: Date; rowCount: number | null } | null> = {};

    for (const type of types) {
      const rows = db
        .select()
        .from(financeUploads)
        .where(sql`file_type = ${type}`)
        .orderBy(sql`uploaded_at DESC`)
        .limit(1)
        .all();

      result[type] = rows.length > 0
        ? {
            fileName: rows[0].fileName,
            uploadedBy: rows[0].uploadedBy,
            uploadedAt: rows[0].uploadedAt,
            rowCount: rows[0].rowCount,
          }
        : null;
    }

    return { success: true, data: result };
  } catch (e) {
    return {
      success: false,
      error: `Error al obtener información de uploads: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
