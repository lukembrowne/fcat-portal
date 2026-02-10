"use server";

import { requirePermission, getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeBudgetItems,
  financeCategoryMap,
  financeSueldosGrants,
  financeSueldosTotals,
  financeUploads,
} from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import type { UploadPreview } from "../types";
import { parseLibroMayor } from "../lib/parse-libro-mayor";
import { parseBudgetExcel } from "../lib/parse-budget";
import { parseCategoryLinkExcel } from "../lib/parse-category-link";
import { parseSueldosExcel } from "../lib/parse-sueldos";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";

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

    // Transaction: delete all old rows, insert new ones
    db.run(sql`DELETE FROM finance_transactions`);

    // Insert in batches of 500
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      db.insert(financeTransactions).values(batch).run();
    }

    // Record upload metadata
    db.insert(financeUploads)
      .values({
        fileType: "libro_mayor",
        fileName: file.name,
        rowCount: rows.length,
        uploadedBy: user?.email || "unknown",
      })
      .run();

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

export async function commitBudget(
  formData: FormData
): Promise<ActionResult<{ itemCount: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const file = formData.get("file") as File | null;
  const yearStr = formData.get("year") as string | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  const budgetYear = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

  try {
    const buffer = await file.arrayBuffer();
    const { items, errors } = parseBudgetExcel(buffer, budgetYear);

    if (items.length === 0) {
      return {
        success: false,
        error: errors.join("; ") || "No se encontraron items de presupuesto",
      };
    }

    db.run(sql`DELETE FROM finance_budget_items`);
    db.insert(financeBudgetItems).values(items).run();

    db.insert(financeUploads)
      .values({
        fileType: "budget",
        fileName: file.name,
        rowCount: items.length,
        uploadedBy: user?.email || "unknown",
      })
      .run();

    revalidatePath("/finance");
    return { success: true, data: { itemCount: items.length } };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar presupuesto: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// --- Category Link upload ---

export async function commitCategoryLink(
  formData: FormData
): Promise<ActionResult<{ mappingCount: number }>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const file = formData.get("file") as File | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  try {
    const buffer = await file.arrayBuffer();
    const { mappings, errors } = parseCategoryLinkExcel(buffer);

    if (mappings.length === 0) {
      return {
        success: false,
        error: errors.join("; ") || "No se encontraron mapeos de categorías",
      };
    }

    db.run(sql`DELETE FROM finance_category_map`);
    db.insert(financeCategoryMap).values(mappings).run();

    db.insert(financeUploads)
      .values({
        fileType: "category_map",
        fileName: file.name,
        rowCount: mappings.length,
        uploadedBy: user?.email || "unknown",
      })
      .run();

    revalidatePath("/finance");
    return { success: true, data: { mappingCount: mappings.length } };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar mapeo: ${e instanceof Error ? e.message : String(e)}`,
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

    db.run(sql`DELETE FROM finance_sueldos_grants`);
    db.run(sql`DELETE FROM finance_sueldos_totals`);

    if (grants.length > 0) {
      db.insert(financeSueldosGrants).values(grants).run();
    }
    if (totals.length > 0) {
      db.insert(financeSueldosTotals).values(totals).run();
    }

    db.insert(financeUploads)
      .values({
        fileType: "sueldos",
        fileName: file.name,
        rowCount: grants.length + totals.length,
        uploadedBy: user?.email || "unknown",
      })
      .run();

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
    const types = ["libro_mayor", "budget", "category_map", "sueldos"] as const;
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
