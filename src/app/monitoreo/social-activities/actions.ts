"use server";

import { requirePermission } from "@/lib/auth";
import { fetchSubmissions } from "@/lib/odk-client";
import {
  MONITOREO_PROJECT_ID,
  MONITOREO_FORM_SOCIAL_ACTIVITIES,
} from "@/lib/odk-constants";
import type { ActionResult } from "@/lib/types";
import type {
  OdkSocialActivitySubmission,
  SocialActivityRecord,
  SocialActivityMetrics,
} from "@/lib/odk-types";
import {
  TIPO_EVENTO_LABELS,
  AREA_DESARROLLO_LABELS,
  LUGAR_EVENTO_LABELS,
  TIPO_PARTICIPANTES_LABELS,
  PROYECTO_FCAT_LABELS,
} from "./labels";

// ─── Helpers ─────────────────────────────────────────────────

function parseMultiSelect(
  value: string | null,
  labelMap: Record<string, string>
): { values: string[]; labels: string[] } {
  if (!value) return { values: [], labels: [] };
  const values = value.split(/\s+/).filter(Boolean);
  const labels = values.map((v) => labelMap[v] ?? v);
  return { values, labels };
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

// ─── Transform ───────────────────────────────────────────────

function transformSubmissions(
  raw: OdkSocialActivitySubmission[]
): SocialActivityRecord[] {
  return raw.map((s) => {
    const areas = parseMultiSelect(s.area_desarrollo, AREA_DESARROLLO_LABELS);
    const participantTypes = parseMultiSelect(
      s.tipo_participantes,
      TIPO_PARTICIPANTES_LABELS
    );
    const projects = parseMultiSelect(s.proyecto_fcat, PROYECTO_FCAT_LABELS);

    const numMujeres = toNum(s.grupo_num_participantes_num_mujeres);
    const numHombres = toNum(s.grupo_num_participantes_num_hombres);
    const numNinos = toNum(s.grupo_num_participantes_num_ninos);
    const numAdolescentes = toNum(s.grupo_num_participantes_num_adolescentes);
    const numOtros = toNum(s.grupo_num_participantes_num_otros_participantes);

    const parsedTotal = parseInt(
      s.grupo_num_participantes_total_participantes ?? "",
      10
    );
    const totalParticipantes = Number.isNaN(parsedTotal)
      ? numMujeres + numHombres + numNinos + numAdolescentes + numOtros
      : parsedTotal;

    const tipoEvento = s.tipo_evento ?? "";

    return {
      id: s.__id,
      fecha: s.fecha ?? null,
      tipoEvento,
      tipoEventoLabel: TIPO_EVENTO_LABELS[tipoEvento] ?? tipoEvento,
      areasDesarrollo: areas.values,
      areasDesarrolloLabels: areas.labels,
      temaEvento: s.tema_evento?.trim() ?? "",
      institucionOrganizadora: s.institucion_organizadora?.trim() ?? "",
      nombreCapacitadores: s.nombre_capacitadores?.trim() ?? "",
      lugarEvento: s.lugar_evento ?? "",
      lugarEventoLabel:
        LUGAR_EVENTO_LABELS[s.lugar_evento ?? ""] ?? (s.lugar_evento ?? ""),
      tipoParticipantes: participantTypes.values,
      tipoParticipantesLabels: participantTypes.labels,
      comunidadesInstituciones: s.comunidades_instituciones?.trim() ?? "",
      numMujeres,
      numHombres,
      numNinos,
      numAdolescentes,
      numOtros,
      totalParticipantes,
      proyectosFcat: projects.values,
      proyectosFcatLabels: projects.labels,
      nombreEncuestador: s.nombre_encuestador?.trim() ?? "",
      fotoListaParticipantes: s.foto_lista_participantes ?? null,
      fotoRegistro2: s.foto_registro_2 ?? null,
      fotoEvento1: s.grupo_fotos_evento_foto_evento_1 ?? null,
      fotoEvento2: s.grupo_fotos_evento_foto_evento_2 ?? null,
      fotoEvento3: s.grupo_fotos_evento_foto_evento_3 ?? null,
      fotoEvento4: s.grupo_fotos_evento_foto_evento_4 ?? null,
      hasPhotos: !!(
        s.foto_lista_participantes ||
        s.foto_registro_2 ||
        s.grupo_fotos_evento_foto_evento_1 ||
        s.grupo_fotos_evento_foto_evento_2 ||
        s.grupo_fotos_evento_foto_evento_3 ||
        s.grupo_fotos_evento_foto_evento_4
      ),
    };
  });
}

// ─── Server Action ───────────────────────────────────────────

export async function fetchSocialActivities(): Promise<
  ActionResult<{
    activities: SocialActivityRecord[];
    metrics: SocialActivityMetrics;
  }>
> {
  try {
    await requirePermission("monitoreo", "viewer");
    const raw = await fetchSubmissions<OdkSocialActivitySubmission>(
      MONITOREO_PROJECT_ID,
      MONITOREO_FORM_SOCIAL_ACTIVITIES,
      { flatten: true }
    );
    const activities = transformSubmissions(raw);

    const totalParticipantes = activities.reduce(
      (sum, a) => sum + a.totalParticipantes,
      0
    );
    const totalMujeres = activities.reduce((sum, a) => sum + a.numMujeres, 0);
    const uniqueCommunities = new Set(
      activities
        .map((a) => a.comunidadesInstituciones.toLowerCase().trim())
        .filter(Boolean)
    );

    const metrics: SocialActivityMetrics = {
      totalEventos: activities.length,
      totalParticipantes,
      totalMujeres,
      porcentajeMujeres:
        totalParticipantes > 0
          ? Math.round((totalMujeres / totalParticipantes) * 100)
          : 0,
      comunidadesAlcanzadas: uniqueCommunities.size,
      promedioParticipantes:
        activities.length > 0
          ? Math.round(totalParticipantes / activities.length)
          : 0,
    };

    return { success: true, data: { activities, metrics } };
  } catch (err) {
    console.error("Failed to fetch social activities:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
