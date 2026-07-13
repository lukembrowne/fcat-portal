import Link from "next/link";
import type { ModelInputSample } from "./actions";

/**
 * A view of the site × occasion detection matrix the model consumes — lets a
 * reader confirm the site/visit structure is built correctly. Rows = sites
 * (instalaciones), columns = ocasiones (ventanas de tiempo). Cell = 1
 * (detectada), 0 (revisada sin detección) or · (fuera de ventana / NA). Each
 * site also shows its sampling period so an outlier long window — which inflates
 * the occasion count for every site — is visible and flagged. Site names link to
 * where the detections are reviewed. The survey-effort level is on each cell's
 * hover title.
 */
export function DetectionSampleTable({ sample }: { sample: ModelInputSample }) {
  const occ = Array.from({ length: sample.maxOccasions }, (_, i) => i + 1);
  // A window ≥3× the median (and clearly long) drives maxOccasions and pads
  // every other row with NA — flag it so the culprit is obvious.
  const isOutlier = (days: number) =>
    sample.medianTotalDays > 0 && days >= 3 * sample.medianTotalDays;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Matriz sitio × ocasión que entra al modelo ({sample.rows.length} sitios; ocasión = ventana
        de {sample.binWidth} días). Cada fila es un sitio; cada columna, una ocasión. El período de
        muestreo (inicio → fin) de cada sitio se muestra a la izquierda; un sitio con una ventana
        muy larga (⚠) ensancha la matriz y deja el resto de filas con NA.
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 bg-background px-2 py-1 text-left font-medium">Sitio</th>
              <th className="px-2 py-1 text-left font-medium whitespace-nowrap">Período</th>
              <th className="px-1 py-1 text-right font-medium" title="Días de muestreo (inicio→fin)">
                días
              </th>
              <th className="px-1 py-1 text-right font-medium" title="Ocasiones muestreadas en este sitio">
                oc.
              </th>
              <th className="px-1 py-1 text-right font-medium">det.</th>
              {occ.map((o) => (
                <th key={o} className="px-1 py-1 text-center font-normal tabular-nums">
                  {o}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((r) => {
              const outlier = isOutlier(r.totalDays);
              return (
                <tr key={r.siteId} className="border-t">
                  <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap font-medium">
                    <Link href={r.href} className="text-emerald-700 dark:text-emerald-400 hover:underline">
                      {r.siteName}
                    </Link>
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums text-muted-foreground">
                    {r.windowStart} → {r.windowEnd}
                  </td>
                  <td
                    className={`px-1 py-1 text-right tabular-nums ${
                      outlier ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-muted-foreground"
                    }`}
                    title={
                      outlier
                        ? `Ventana atípicamente larga (${r.totalDays} días; mediana ${sample.medianTotalDays}) — revisar fechas de este sitio`
                        : `${r.totalDays} días de muestreo`
                    }
                  >
                    {outlier ? "⚠ " : ""}
                    {r.totalDays}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-muted-foreground">
                    {r.occasions}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-muted-foreground">
                    {r.detections}
                  </td>
                  {occ.map((o) => {
                    const v = r.cells[o - 1] ?? null;
                    const eff = r.effort[o - 1];
                    const cls =
                      v === 1
                        ? "bg-emerald-600 text-white"
                        : v === 0
                          ? "bg-muted text-muted-foreground"
                          : "text-muted-foreground/40";
                    return (
                      <td
                        key={o}
                        title={eff ? `esfuerzo: ${eff}` : "fuera de ventana (NA)"}
                        className={`px-1 py-1 text-center tabular-nums ${cls}`}
                      >
                        {v === null ? "·" : v}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-emerald-600 mr-1" />1 =
        detectada ·{" "}
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-muted mr-1" />0 = revisada
        sin detección · <span className="mr-1">·</span> = fuera de la ventana del sitio (NA). Sitio =
        instalación (abre la página de verificación); ocasión = ventana de {sample.binWidth} días. ⚠
        = ventana de muestreo atípicamente larga.
      </p>
    </div>
  );
}
