"use server";

import { fetchSubmissions } from "@/lib/odk-client";
import type {
  OdkTreeSubmission,
  TreeRecord,
  TreeDashboardMetrics,
  OdkGeoPoint,
} from "@/lib/odk-types";

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

export async function fetchTreeData(): Promise<{
  success: boolean;
  trees: TreeRecord[];
  metrics: TreeDashboardMetrics;
  error?: string;
}> {
  try {
    const raw = await fetchSubmissions<OdkTreeSubmission>("2", "siembra_arboles");
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

    return { success: true, trees, metrics };
  } catch (err) {
    console.error("Failed to fetch tree data:", err);
    return {
      success: false,
      trees: [],
      metrics: { totalTrees: 0, uniqueSpecies: 0, uniqueFarms: 0, survivalRate: 0 },
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
