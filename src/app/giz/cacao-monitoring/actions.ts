"use server";

import { fetchSubmissions, parseWktPoint } from "@/lib/odk-client";
import type {
  OdkCacaoSubmission,
  CacaoRecord,
  CacaoMetrics,
} from "@/lib/odk-types";

function transformSubmissions(raw: OdkCacaoSubmission[]): CacaoRecord[] {
  return raw.map((s) => {
    const coords = parseWktPoint(s.metadata_ubicacion);

    return {
      id: s.__id,
      farmCode: s.identificacion_codigo_finca ?? "",
      ownerName: s.identificacion_nombre_propietario ?? "",
      community: s.identificacion_comunidad ?? "",
      plantingDate: s.identificacion_fecha_siembra?.split("T")[0] ?? null,
      monitoringDate: s.metadata_fecha_monitoreo?.split("T")[0] ?? null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      plantsPlanted: s.datos_plantas_num_plantas_sembradas,
      plantsAlive: s.datos_plantas_num_plantas_vivas,
      survivalRate: s.datos_plantas_tasa_sobrevivencia,
      numCleanings: s.manejo_num_limpiezas,
      fertilized: s.manejo_realizo_fertilizacion,
      ownerComments: s.observaciones_comentarios_propietario,
      monitorNotes: s.observaciones_notas_monitor,
      plantsDead: s.num_plantas_muertas,
      daysSincePlanting: s.dias_desde_siembra,
    };
  });
}

export async function fetchCacaoData(): Promise<{
  success: boolean;
  records: CacaoRecord[];
  metrics: CacaoMetrics;
  error?: string;
}> {
  try {
    const raw = await fetchSubmissions<OdkCacaoSubmission>("2", "monitoreo_cacao_v1");
    const records = transformSubmissions(raw);

    const totalPlants = records.reduce((sum, r) => sum + (r.plantsPlanted ?? 0), 0);
    const plantsAlive = records.reduce((sum, r) => sum + (r.plantsAlive ?? 0), 0);
    const ratesWithData = records.filter((r) => r.survivalRate != null);
    const avgSurvival =
      ratesWithData.length > 0
        ? ratesWithData.reduce((sum, r) => sum + r.survivalRate!, 0) / ratesWithData.length
        : 0;
    const communities = new Set(records.map((r) => r.community).filter(Boolean));

    const metrics: CacaoMetrics = {
      totalFarms: records.length,
      totalPlants,
      plantsAlive,
      avgSurvivalRate: Math.round(avgSurvival * 10) / 10,
      communities: communities.size,
    };

    return { success: true, records, metrics };
  } catch (err) {
    console.error("Failed to fetch cacao data:", err);
    return {
      success: false,
      records: [],
      metrics: { totalFarms: 0, totalPlants: 0, plantsAlive: 0, avgSurvivalRate: 0, communities: 0 },
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
