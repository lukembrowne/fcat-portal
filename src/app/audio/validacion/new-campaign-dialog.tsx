"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";

import { createCampaign } from "./actions";
import { DEFAULT_TARGET_SAMPLE_SIZE } from "@/lib/birdnet-validation/types";
import { SpeciesPicker, useSpeciesCatalog } from "./species-picker";

export function AddSpeciesPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [species, setSpecies] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [target, setTarget] = useState(DEFAULT_TARGET_SAMPLE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const { catalog, loading, error: catalogError } = useSpeciesCatalog(open);

  const submit = () => {
    if (!species) {
      setError("Elige una especie de la lista");
      return;
    }
    setSubmitting(true);
    setError(null);
    void createCampaign({ species, targetSampleSize: target, notes })
      .then((result) => {
        if (!result.success) {
          setError(result.error);
          return;
        }
        // The species exists either way. A failed draw keeps the panel open so
        // the reason is read rather than dismissed, but the list still
        // refreshes underneath — the row is there, showing "Preparar".
        if (result.data.drawError) {
          setError(
            `Especie añadida, pero no se pudo extraer la muestra: ${result.data.drawError} Usa "Preparar" en su fila para reintentar.`
          );
          startTransition(() => router.refresh());
          return;
        }
        setOpen(false);
        setSpecies(null);
        setNotes("");
        startTransition(() => router.refresh());
      })
      .finally(() => setSubmitting(false));
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" /> Añadir especie
      </button>
    );
  }

  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border bg-card p-3">
      <div>
        <p className="text-sm font-medium">Añadir una especie a validar</p>
        <p className="text-[11px] text-muted-foreground">
          Sólo aparecen las especies que BirdNET ha detectado, con su número de
          detecciones.
        </p>
      </div>

      <SpeciesPicker
        catalog={catalog}
        loading={loading}
        selected={species}
        onSelect={setSpecies}
      />

      {species ? (
        <p className="text-xs">
          Seleccionada: <span className="italic">{species}</span>
        </p>
      ) : null}

      {/* Above the sample size on purpose: it is the field that gets filled in
          most often, and the sample size is left at 200 almost every time. */}
      <label className="block text-sm">
        Notas (opcional)
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Fuera de rango; no está en la lista de JF. REVISAR"
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
        />
      </label>
      <p className="text-[11px] text-muted-foreground">
        Por qué esta especie merece revisarse: dudas de rango, confusión con
        otra especie, lo que haga falta. Se ve en la lista y se puede editar
        después.
      </p>

      <label className="block max-w-[12rem] text-sm">
        Tamaño de muestra
        <input
          type="number"
          min={20}
          max={1000}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          className="mt-1 w-full rounded border px-2 py-1 text-sm tabular-nums"
        />
      </label>

      <p className="text-[11px] text-muted-foreground">
        200 clips es el tamaño recomendado. La muestra se extrae al añadir la
        especie, repartida entre bandas de puntuación y entre sitios; tarda unos
        segundos.
      </p>

      {catalogError ? <p className="text-xs text-rose-700">{catalogError}</p> : null}
      {error ? <p className="text-xs text-rose-700">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !species}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Añadir
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
