"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  updateSitePageConfig,
  fetchSiteAudioOptions,
  fetchSitePhotoOptions,
  type SiteAudioOption,
  type SitePhotoOption,
} from "../actions";
import {
  type PageConfig,
  type PageBlock,
  FEATURED_PHOTOS_MAX,
  NOTE_MAX,
  SUMMARY_MAX,
} from "@/lib/landowner/page-config";
import { formatClipDuration } from "@/lib/landowner/format-audio";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  Eye,
  Check,
  Image as ImageIcon,
  Type,
  StickyNote,
  Volume2,
} from "lucide-react";

interface PageBuilderProps {
  siteId: string;
  token: string;
  initialConfig: PageConfig;
}

/** Content-block types the builder manages (hero is handled separately). */
type ContentBlock = Exclude<PageBlock, { type: "hero" }>;

const ADDABLE: { type: ContentBlock["type"]; label: string; icon: typeof Type }[] =
  [
    { type: "note", label: "Mensaje", icon: StickyNote },
    { type: "featuredPhotos", label: "Fotos destacadas", icon: ImageIcon },
    { type: "featuredAudio", label: "Grabación", icon: Volume2 },
  ];

function newBlock(type: ContentBlock["type"]): ContentBlock {
  switch (type) {
    case "note":
      return { type: "note", text: "" };
    case "summary":
      return { type: "summary", text: "" };
    case "featuredPhotos":
      return { type: "featuredPhotos", imageIds: [] };
    case "featuredAudio":
      return { type: "featuredAudio", audioId: null };
    case "projectContext":
      return { type: "projectContext", enabled: true };
  }
}

export function PageBuilder({
  siteId,
  token,
  initialConfig,
}: PageBuilderProps) {
  const router = useRouter();
  // Open by default: the builder now lives on its own dedicated page
  // (/biochoco/paginas-publicas/[siteId]), so editing is the whole point —
  // don't make the editor hide behind an "Editar" click.
  const [open, setOpen] = useState(true);

  // Hero handled separately; content blocks are the rest, in order.
  const initialHero = useMemo(() => {
    const hero = initialConfig.blocks.find((b) => b.type === "hero");
    return hero?.type === "hero" ? hero.imageId : null;
  }, [initialConfig]);
  const [heroImageId, setHeroImageId] = useState<number | null>(initialHero);
  const [blocks, setBlocks] = useState<ContentBlock[]>(
    () =>
      initialConfig.blocks.filter(
        // "hero" is managed separately. "summary" and "projectContext" are no
        // longer builder-managed — summary is retired, and "Sobre BioChoco" is
        // now always auto-rendered on the public page by the server — so drop
        // any existing ones on load (they won't be re-saved).
        (b) =>
          b.type !== "hero" &&
          b.type !== "summary" &&
          b.type !== "projectContext"
      ) as ContentBlock[]
  );

  const [audioOptions, setAudioOptions] = useState<SiteAudioOption[] | null>(
    null
  );
  const [photoOptions, setPhotoOptions] = useState<SitePhotoOption[] | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [previewKey, setPreviewKey] = useState(0);

  // Lazy-load the media pickers when the builder first opens.
  useEffect(() => {
    if (!open) return;
    if (photoOptions === null) {
      fetchSitePhotoOptions(siteId)
        .then(setPhotoOptions)
        .catch(() => setPhotoOptions([]));
    }
    if (audioOptions === null) {
      fetchSiteAudioOptions(siteId)
        .then(setAudioOptions)
        .catch(() => setAudioOptions([]));
    }
  }, [open, siteId, photoOptions, audioOptions]);

  const thumb = (id: number) =>
    `/api/public/site-images/${token}/${id}?size=thumb`;

  function updateBlock(index: number, next: ContentBlock) {
    setBlocks((bs) => bs.map((b, i) => (i === index ? next : b)));
  }
  function removeBlock(index: number) {
    setBlocks((bs) => bs.filter((_, i) => i !== index));
  }
  function moveBlock(index: number, dir: -1 | 1) {
    setBlocks((bs) => {
      const j = index + dir;
      if (j < 0 || j >= bs.length) return bs;
      const copy = [...bs];
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });
  }
  function addBlock(type: ContentBlock["type"]) {
    setBlocks((bs) => [...bs, newBlock(type)]);
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSaving(true);
    const config: PageConfig = {
      version: initialConfig.version,
      blocks: [{ type: "hero", imageId: heroImageId }, ...blocks],
    };
    const result = await updateSitePageConfig(siteId, config);
    setSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setPreviewKey((k) => k + 1); // refresh preview to the saved state
    router.refresh();
  }

  if (!open) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <div>
              <p className="text-sm font-medium">Personalizar página pública</p>
              <p className="text-xs text-muted-foreground">
                Mensaje, fotos y grabación que verá el propietario.
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Editar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium">Personalizar página pública</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted-foreground hover:underline"
        >
          Cerrar
        </button>
      </div>

      {/* Hero picker */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Foto principal
        </label>
        {photoOptions === null ? (
          <p className="text-xs text-muted-foreground">Cargando fotos…</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {/* "Automático" tile — clears the manual hero selection. */}
            <button
              type="button"
              onClick={() => setHeroImageId(null)}
              title="Automático (mejor foto)"
              className={`relative flex aspect-square flex-col items-center justify-center gap-1 rounded border-2 bg-muted/40 p-1 text-center ${
                heroImageId === null ? "border-primary" : "border-transparent"
              }`}
            >
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-[9px] leading-tight text-muted-foreground">
                Automático (mejor foto)
              </span>
              {heroImageId === null && (
                <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
              )}
            </button>
            {photoOptions.map((o) => {
              const isSel = heroImageId === o.imageId;
              return (
                <button
                  key={o.imageId}
                  type="button"
                  onClick={() => setHeroImageId(o.imageId)}
                  title={o.label}
                  className={`relative aspect-square overflow-hidden rounded border-2 ${
                    isSel ? "border-primary" : "border-transparent"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb(o.imageId)}
                    alt={o.label}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  {isSel && (
                    <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content blocks */}
      <div className="space-y-3">
        {blocks.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Aún no hay bloques. Agregue uno abajo.
          </p>
        )}
        {blocks.map((block, i) => (
          <div key={i} className="rounded border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {ADDABLE.find((a) => a.type === block.type)?.label ?? block.type}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveBlock(i, -1)}
                  disabled={i === 0}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label="Subir"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => moveBlock(i, 1)}
                  disabled={i === blocks.length - 1}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label="Bajar"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeBlock(i)}
                  className="rounded p-1 text-destructive hover:bg-muted"
                  aria-label="Eliminar bloque"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <BlockEditor
              block={block}
              onChange={(next) => updateBlock(i, next)}
              audioOptions={audioOptions}
              photoOptions={photoOptions}
              thumb={thumb}
              token={token}
            />
          </div>
        ))}
      </div>

      {/* Add block */}
      <div className="flex flex-wrap gap-1.5">
        {ADDABLE.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            type="button"
            onClick={() => addBlock(type)}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
          >
            <Plus className="h-3 w-3" />
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
          {saved ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Guardado
            </>
          ) : saving ? (
            "Guardando…"
          ) : (
            "Guardar"
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowPreview((v) => !v)}
          className="gap-1.5"
        >
          <Eye className="h-3.5 w-3.5" />
          {showPreview ? "Ocultar vista previa" : "Vista previa"}
        </Button>
      </div>

      {showPreview && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Vista del propietario (guarde para actualizar).
          </p>
          <div className="mx-auto w-full max-w-[420px] overflow-hidden rounded-2xl border bg-background">
            <iframe
              key={previewKey}
              // Same-origin relative path — NOT `publicUrl`, which is the
              // absolute production URL (NEXT_PUBLIC_BASE_URL). In dev that
              // would load the deployed prod page (old formatting, cross-origin
              // broken images) instead of the current environment's page.
              src={`/public/biochoco/${token}`}
              title="Vista previa de la página del propietario"
              className="h-[720px] w-full"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
  audioOptions,
  photoOptions,
  thumb,
  token,
}: {
  block: ContentBlock;
  onChange: (next: ContentBlock) => void;
  audioOptions: SiteAudioOption[] | null;
  photoOptions: SitePhotoOption[] | null;
  thumb: (id: number) => string;
  token: string;
}) {
  switch (block.type) {
    case "note":
    case "summary": {
      const max = block.type === "note" ? NOTE_MAX : SUMMARY_MAX;
      const placeholder =
        block.type === "note"
          ? "Un saludo o nota personal para el propietario…"
          : "Una breve descripción de los resultados…";
      return (
        <div className="space-y-1">
          <textarea
            value={block.text}
            onChange={(e) =>
              onChange({ ...block, text: e.target.value.slice(0, max) })
            }
            rows={3}
            placeholder={placeholder}
            className="w-full resize-y rounded border bg-background px-2 py-1.5 text-sm"
          />
          <p className="text-right text-[10px] text-muted-foreground">
            {block.text.length}/{max}
          </p>
        </div>
      );
    }

    case "featuredAudio": {
      if (audioOptions === null)
        return <p className="text-xs text-muted-foreground">Cargando…</p>;
      if (audioOptions.length === 0)
        return (
          <p className="text-xs text-muted-foreground">
            No hay audio disponible
          </p>
        );
      const selectedId = block.audioId;
      return (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {/* "Ninguna" — clears the selection. */}
          <button
            type="button"
            onClick={() => onChange({ ...block, audioId: null })}
            className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs ${
              selectedId === null
                ? "border-primary ring-1 ring-primary"
                : "border-transparent hover:bg-muted"
            }`}
          >
            {selectedId === null && (
              <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
            )}
            <span className="text-muted-foreground">Ninguna</span>
          </button>
          {audioOptions.map((o) => {
            const isSel = selectedId === o.id;
            const d = formatClipDuration(o.durationSeconds);
            return (
              <div
                key={o.id}
                className={`flex items-center gap-2 rounded border p-1.5 ${
                  isSel
                    ? "border-primary ring-1 ring-primary"
                    : "border-border"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={o.filename}>
                    {o.filename}
                    {d ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        ({d})
                      </span>
                    ) : null}
                  </p>
                  <audio
                    controls
                    preload="none"
                    src={`/api/public/site-audio/${token}/${o.id}`}
                    className="mt-1 h-8 w-full"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onChange({ ...block, audioId: o.id })}
                  className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ${
                    isSel
                      ? "bg-primary text-primary-foreground"
                      : "border hover:bg-muted"
                  }`}
                >
                  {isSel ? (
                    <>
                      <Check className="h-3 w-3" />
                      Seleccionada
                    </>
                  ) : (
                    "Elegir"
                  )}
                </button>
              </div>
            );
          })}
        </div>
      );
    }

    case "featuredPhotos": {
      const imageIds = block.imageIds;
      const selected = new Set(imageIds);
      const atCap = imageIds.length >= FEATURED_PHOTOS_MAX;
      const toggle = (id: number) => {
        const next = selected.has(id)
          ? imageIds.filter((x) => x !== id)
          : [...imageIds, id].slice(0, FEATURED_PHOTOS_MAX);
        onChange({ type: "featuredPhotos", imageIds: next });
      };
      if (photoOptions === null)
        return <p className="text-xs text-muted-foreground">Cargando fotos…</p>;
      if (photoOptions.length === 0)
        return (
          <p className="text-xs text-muted-foreground">No hay fotos disponibles.</p>
        );
      return (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            {block.imageIds.length}/{FEATURED_PHOTOS_MAX} seleccionadas
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {photoOptions.map((o) => {
              const isSel = selected.has(o.imageId);
              const disabled = !isSel && atCap;
              return (
                <button
                  key={o.imageId}
                  type="button"
                  onClick={() => toggle(o.imageId)}
                  disabled={disabled}
                  title={o.label}
                  className={`relative aspect-square overflow-hidden rounded border-2 ${
                    isSel ? "border-primary" : "border-transparent"
                  } ${disabled ? "opacity-40" : ""}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb(o.imageId)}
                    alt={o.label}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  {isSel && (
                    <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    case "projectContext":
      return (
        <p className="text-xs text-muted-foreground">
          Muestra una tarjeta &ldquo;Sobre el proyecto BioChoco&rdquo; con un
          enlace a la página del proyecto.
        </p>
      );
  }
}
