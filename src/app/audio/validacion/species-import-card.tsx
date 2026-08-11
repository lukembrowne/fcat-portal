"use client";

/**
 * Paste or upload a list of species to validate.
 *
 * Preview first, commit second — the commit creates each species AND draws its
 * full sample, so it is expensive to undo and every row's fate is shown before
 * anything is written.
 *
 * The commit walks the list in `COMMIT_CHUNK_SIZE` slices, sequentially. There
 * is no limit on how many species one import adds; the limit is on how much
 * work rides on a single request, because each species' draw costs 1.4-2.0 s
 * and a few hundred of them in one call would be killed by the proxy.
 * Sequential, not `Promise.all`: each chunk does real database and ODK work,
 * and running them concurrently would multiply that load rather than shorten it.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload, ChevronDown, ChevronRight } from "lucide-react";

import {
  previewSpeciesImport,
  previewSpeciesImportFile,
  commitSpeciesImport,
  type SpeciesImportPreview,
  type SpeciesImportCommitRow,
} from "./import-actions";
import {
  COMMIT_CHUNK_SIZE,
  OUTCOME_LABEL,
  type ImportOutcome,
} from "./species-import";

const OUTCOME_CLASS: Record<ImportOutcome, string> = {
  ready: "text-emerald-800",
  duplicate: "text-muted-foreground",
  no_detections: "text-amber-800",
  unknown: "text-rose-800",
  repeated: "text-muted-foreground",
};

export function SpeciesImportCard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<SpeciesImportPreview | null>(null);
  const [committed, setCommitted] = useState<SpeciesImportCommitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );

  const reset = () => {
    setPreview(null);
    setCommitted(null);
    setError(null);
    setProgress(null);
  };

  const runPreview = () => {
    setBusy(true);
    reset();
    void previewSpeciesImport(text)
      .then((result) => {
        if (result.success) setPreview(result.data);
        else setError(result.error);
      })
      .finally(() => setBusy(false));
  };

  const runFilePreview = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    reset();
    const fd = new FormData();
    fd.set("file", file);
    void previewSpeciesImportFile(fd)
      .then((result) => {
        if (result.success) setPreview(result.data);
        else setError(result.error);
      })
      .finally(() => setBusy(false));
  };

  const runCommit = () => {
    if (!preview) return;
    const ready = preview.rows
      .filter((r) => r.outcome === "ready" && r.scientificName)
      .map((r) => ({ scientificName: r.scientificName!, notes: r.notes }));
    if (ready.length === 0) return;

    setBusy(true);
    setError(null);
    setCommitted(null);
    setProgress({ done: 0, total: ready.length });

    void (async () => {
      const all: SpeciesImportCommitRow[] = [];

      for (let i = 0; i < ready.length; i += COMMIT_CHUNK_SIZE) {
        const chunk = ready.slice(i, i + COMMIT_CHUNK_SIZE);
        // A whole chunk failing is recorded against its species and the import
        // continues. Stopping would strand the remaining names with no record
        // of which ones were already created.
        const failAll = (message: string) =>
          chunk.map(({ scientificName }) => ({
            scientificName,
            created: false,
            drawn: null,
            error: message,
          }));

        try {
          const result = await commitSpeciesImport(chunk);
          all.push(...(result.success ? result.data : failAll(result.error)));
        } catch {
          all.push(...failAll("La solicitud falló"));
        }

        setProgress({ done: Math.min(i + chunk.length, ready.length), total: ready.length });
      }

      setCommitted(all);
      setPreview(null);
      setText("");
      setProgress(null);
      setBusy(false);
      // Once, at the end — refreshing per chunk would re-render the whole
      // species table dozens of times during an import.
      startTransition(() => router.refresh());
    })();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
      >
        <ChevronRight className="h-3.5 w-3.5" /> Añadir varias especies
      </button>
    );
  }

  const readyCount = preview?.counts.ready ?? 0;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="inline-flex items-center gap-1.5 text-sm font-medium"
      >
        <ChevronDown className="h-3.5 w-3.5" /> Añadir varias especies
      </button>

      <div className="rounded border border-dashed p-2 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">Cómo usarlo</p>
        <ul className="ml-4 list-disc space-y-0.5">
          <li>
            Pega una lista de especies: una por línea, o pega directamente una
            columna copiada de Excel o Google Sheets.
          </li>
          <li>
            Se aceptan nombres científicos, en español o en inglés. La especie
            se lee siempre de la primera columna.
          </li>
          <li>
            Para importar notas, la hoja debe tener una columna titulada{" "}
            <span className="font-medium text-foreground">Notas</span> o{" "}
            <span className="font-medium text-foreground">Notes</span> (en
            cualquier posición). Sin encabezado sólo se leen notas si la lista
            tiene exactamente dos columnas: especie y nota.
          </li>
          <li>
            Las especies que ya se están validando se omiten; no se duplican ni
            se pierde el trabajo hecho.
          </li>
          <li>
            Cada especie añadida extrae su muestra automáticamente y queda
            lista para revisar.
          </li>
          <li>
            No hay límite de especies. Las listas largas se añaden por tandas de{" "}
            {COMMIT_CHUNK_SIZE}; no cierres la página hasta que termine.
          </li>
        </ul>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={"Ramphastos ambiguus\nCebus aequatorialis\nTucán del Chocó"}
        className="w-full rounded border px-2 py-1 font-mono text-xs"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={runPreview}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Revisar lista
        </button>

        <span className="text-xs text-muted-foreground">o</span>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          onChange={runFilePreview}
          className="text-xs file:mr-2 file:rounded file:border file:bg-background file:px-2 file:py-1 file:text-xs"
        />
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      {error ? <p className="text-xs text-rose-700">{error}</p> : null}

      {progress ? (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-foreground transition-all"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            Añadiendo {progress.done} de {progress.total} especies…
          </p>
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-2">
          {/* Stated either way. "No notes column found" is the failure this
              line exists for: without it, a sheet whose column is headed
              "Comments" imports silently and looks like it worked. */}
          <p className="text-[11px] text-muted-foreground">
            {preview.notesColumn != null
              ? `Notas leídas de la columna ${preview.notesColumn} · ${preview.withNotes} de ${preview.rows.length} filas tienen nota.`
              : "No se encontró una columna de notas; se importarán sin notas."}
          </p>

          <div className="max-h-56 overflow-y-auto rounded border">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/50 text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left">Texto pegado</th>
                  <th className="px-2 py-1 text-left">Especie</th>
                  <th className="px-2 py-1 text-right">Detecciones</th>
                  <th className="px-2 py-1 text-left">Resultado</th>
                  <th className="px-2 py-1 text-left">Notas</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={`${row.input}-${i}`} className="border-b last:border-0">
                    <td className="px-2 py-1">{row.input}</td>
                    <td className="px-2 py-1 italic text-muted-foreground">
                      {row.scientificName ??
                        (row.candidates
                          ? `¿${row.candidates.join(" o ")}?`
                          : "—")}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {row.detectionCount > 0
                        ? row.detectionCount.toLocaleString("es")
                        : "—"}
                    </td>
                    <td className={`px-2 py-1 ${OUTCOME_CLASS[row.outcome]}`}>
                      {OUTCOME_LABEL[row.outcome]}
                    </td>
                    <td
                      className="max-w-[14rem] truncate px-2 py-1 text-muted-foreground"
                      title={row.notes ?? undefined}
                    >
                      {row.notes ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runCommit}
              disabled={busy || pending || readyCount === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Añadir {readyCount} especie{readyCount === 1 ? "" : "s"}
            </button>
            <span className="text-[11px] text-muted-foreground">
              {preview.counts.duplicate} ya en validación ·{" "}
              {preview.counts.unknown} no reconocidas ·{" "}
              {preview.counts.no_detections} sin detecciones ·{" "}
              {preview.counts.repeated} repetidas
            </span>
          </div>
        </div>
      ) : null}

      {committed ? (
        <div className="space-y-1 rounded border p-2 text-xs">
          <p className="font-medium">
            {committed.filter((r) => r.created).length} especies añadidas.
          </p>
          {committed
            .filter((r) => r.error)
            .map((r) => (
              <p key={r.scientificName} className="text-amber-800">
                {r.scientificName}: {r.error}
                {r.created ? ' (añadida; usa "Preparar" en su fila para reintentar)' : ""}
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}
