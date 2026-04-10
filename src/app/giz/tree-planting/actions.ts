"use server";

import { requirePermission } from "@/lib/auth";
import { fetchSubmissions } from "@/lib/odk-client";
import { GIZ_PROJECT_ID, GIZ_FORM_TREE_PLANTING } from "@/lib/odk-constants";
import type {
  OdkTreeSubmission,
  TreeRecord,
  TreeDashboardMetrics,
  OdkGeoPoint,
} from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";

function transformSubmissions(raw: OdkTreeSubmission[]): TreeRecord[] {
  return raw.map((s) => {
    let lat: number | null = null;
    let lng: number | null = null;

    const gps = s.gps as OdkGeoPoint | null;
    if (gps && gps.coordinates && gps.coordinates.length >= 2) {
      lng = gps.coordinates[0];
      lat = gps.coordinates[1];
    }

    return {
      id: s.__id,
      code: s.codigo_ficha ?? "",
      date: s.fecha_siembra?.split("T")[0] ?? null,
      farm: s.codigo_social ?? "",
      owner: s.dueno ?? "",
      species: s.nombre_especie ?? "",
      height: s.altura_inicial,
      condition: s.condicion_inicial ?? "",
      survival: s.supervivencia ?? "",
      worker: s.extensionista ?? "",
      notes: s.notas ?? "",
      lat,
      lng,
      photoTop: s.foto_superior ?? null,
      photoSide: s.foto_lateral ?? null,
      photoLeaf: s.foto_hoja ?? null,
    };
  });
}

export async function fetchTreeData(): Promise<ActionResult<{ trees: TreeRecord[]; metrics: TreeDashboardMetrics }>> {
  try {
    await requirePermission("giz", "viewer");
    const raw = await fetchSubmissions<OdkTreeSubmission>(GIZ_PROJECT_ID, GIZ_FORM_TREE_PLANTING);
    const trees = transformSubmissions(raw);

    const uniqueSpecies = new Set(trees.map((t) => t.species).filter(Boolean));
    const uniqueFarms = new Set(trees.map((t) => t.farm).filter(Boolean));
    const aliveCount = trees.filter((t) => t.survival === "vivo").length;
    const survivalRate =
      trees.length > 0 ? (aliveCount / trees.length) * 100 : 0;

    const metrics: TreeDashboardMetrics = {
      totalTrees: trees.length,
      uniqueSpecies: uniqueSpecies.size,
      uniqueFarms: uniqueFarms.size,
      survivalRate: Math.round(survivalRate * 10) / 10,
    };

    return { success: true, data: { trees, metrics } };
  } catch (err) {
    log.error({ err }, "Failed to fetch tree data");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
