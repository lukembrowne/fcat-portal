import type { ModelInputSample } from "./actions";

/**
 * A compact slice of the site × occasion detection matrix the model consumes —
 * lets a reader confirm the site/visit structure is built correctly. Rows =
 * sites (instalaciones), columns = ocasiones (ventanas de tiempo). Cell = 1
 * (detectada), 0 (revisada sin detección) or · (fuera de ventana / NA). The
 * survey-effort level is on each cell's hover title.
 */
export function DetectionSampleTable({ sample }: { sample: ModelInputSample }) {
  const occ = Array.from({ length: sample.maxOccasions }, (_, i) => i + 1);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Muestra de la matriz sitio × ocasión que entra al modelo (
        {sample.rows.length} de {sample.nSites} sitios; ocasión = ventana de {sample.binWidth} días).
        Cada fila es un sitio; cada columna, una ocasión.
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 bg-background px-2 py-1 text-left font-medium">Sitio</th>
              <th className="px-1 py-1 text-right font-medium">det.</th>
              {occ.map((o) => (
                <th key={o} className="px-1 py-1 text-center font-normal tabular-nums">
                  {o}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((r) => (
              <tr key={r.siteId} className="border-t">
                <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap font-medium">
                  {r.siteName}
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
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-emerald-600 mr-1" />1 =
        detectada ·{" "}
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-muted mr-1" />0 = revisada
        sin detección · <span className="mr-1">·</span> = fuera de la ventana del sitio (NA). Sitio =
        instalación; ocasión = ventana de {sample.binWidth} días.
      </p>
    </div>
  );
}
