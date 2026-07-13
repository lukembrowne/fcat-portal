"use server";

import { requirePermission, getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeBudgetItems,
  financeSueldosGrants,
  financeSueldosTotals,
  financeUploads,
} from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import type { UploadPreview } from "../types";
import { parseLibroMayor } from "../lib/parse-libro-mayor";
import { parseBudgetExcel } from "../lib/parse-budget";
import { parseSueldosExcel } from "../lib/parse-sueldos";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
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

// --- Sueldos upload ---

export async function commitSueldos(
  formData: FormData
): Promise<ActionResult<{ grantCount: number; totalCount: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const file = formData.get("file") as File | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  try {
    const buffer = await file.arrayBuffer();
    const { grants, totals, errors } = parseSueldosExcel(buffer);

    if (grants.length === 0 && totals.length === 0) {
      return {
        success: false,
        error: errors.join("; ") || "No se encontraron datos de sueldos",
      };
    }

    db.transaction((tx) => {
      tx.run(sql`DELETE FROM finance_sueldos_grants`);
      tx.run(sql`DELETE FROM finance_sueldos_totals`);

      if (grants.length > 0) {
        tx.insert(financeSueldosGrants).values(grants).run();
      }
      if (totals.length > 0) {
        tx.insert(financeSueldosTotals).values(totals).run();
      }

      tx.insert(financeUploads)
        .values({
          fileType: "sueldos",
          fileName: file.name,
          rowCount: grants.length + totals.length,
          uploadedBy: user?.email || "unknown",
        })
        .run();
    });

    db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);
    await recordEvent({
      source: "finance",
      eventType: "finance_upload_sueldos",
      summary: `Sueldos cargados: ${file.name} (${grants.length} grant${grants.length === 1 ? "" : "s"}, ${totals.length} total${totals.length === 1 ? "" : "es"})`,
      severity: "success",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_upload",
      details: { fileName: file.name, grantCount: grants.length, totalCount: totals.length, fileType: "sueldos" },
    });
    revalidatePath("/finance");
    return {
      success: true,
      data: { grantCount: grants.length, totalCount: totals.length },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar sueldos: ${e instanceof Error ? e.message : String(e)}`,
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
