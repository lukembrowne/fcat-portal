"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  updateSitePageConfig,
  fetchSiteAudioOptions,
  fetchSitePhotoOptions,
  fetchSiteStarredPhotoOptions,
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
  Star,
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

/** The personalization sections the builder always shows, in canonical order. */
type SectionType = "note" | "featuredPhotos" | "featuredAudio";
const SECTION_ORDER: SectionType[] = ["note", "featuredPhotos", "featuredAudio"];

/** Per-section label + one-line description + short usage instruction (U1). */
const SECTION_META: Record<
  SectionType,
  { label: string; icon: typeof Type; description: string; instruction: string }
> = {
  note: {
    label: "Mensaje",
    icon: StickyNote,
    description: "Un saludo o nota personal del equipo para el propietario.",
    instruction:
      "Escriba unas líneas dirigidas al propietario. Aparecerá como una nota firmada por el equipo de monitoreo.",
  },
  featuredPhotos: {
    label: "Fotos destacadas",
    icon: ImageIcon,
    description: "Una galería con las mejores fotos de la fauna del sitio.",
    instruction:
      "Elija hasta 6 fotos. Por defecto se muestran las fotos destacadas (★) que marcó el equipo; use “Todas” para elegir entre las mejores fotos por especie.",
  },
  featuredAudio: {
    label: "Grabación",
    icon: Volume2,
    description: "Una grabación de audio de ejemplo del sitio.",
    instruction:
      "Seleccione una grabación para que el propietario pueda escuchar los sonidos de su tierra.",
  },
};

function newBlock(type: SectionType): ContentBlock {
  switch (type) {
    case "note":
      return { type: "note", text: "" };
    case "featuredPhotos":
      return { type: "featuredPhotos", imageIds: [] };
    case "featuredAudio":
      return { type: "featuredAudio", audioId: null };
  }
}

/**
 * Seed the editor's content blocks so all three personalization sections are
 * always present (U1) and "Fotos destacadas" is a singleton (U2): keep the
 * existing blocks (first featuredPhotos only), then append an empty card for
 * every section type not yet present, in canonical order. Empty cards are NOT
 * persisted — handleSave drops them (KTD-1) — so an untouched section never
 * pollutes the saved config.
 */
function seedSections(existing: ContentBlock[]): ContentBlock[] {
  const seeded: ContentBlock[] = [];
  let seenPhotos = false;
  for (const b of existing) {
    if (b.type === "featuredPhotos") {
      if (seenPhotos) continue; // singleton
      seenPhotos = true;
    }
    seeded.push(b);
  }
  for (const type of SECTION_ORDER) {
    if (!seeded.some((b) => b.type === type)) seeded.push(newBlock(type));
  }
  return seeded;
}

/** True when a content block has no user content and must not be persisted. */
function isEmptyBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case "note":
    case "summary":
      return block.text.trim().length === 0;
    case "featuredPhotos":
      return block.imageIds.length === 0;
    case "featuredAudio":
      return block.audioId == null;
    case "projectContext":
      return false;
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
  const [blocks, setBlocks] = useState<ContentBlock[]>(() =>
    seedSections(
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
    )
  );

  const [audioOptions, setAudioOptions] = useState<SiteAudioOption[] | null>(
    null
  );
  const [photoOptions, setPhotoOptions] = useState<SitePhotoOption[] | null>(
    null
  );
  const [starredOptions, setStarredOptions] = useState<
    SitePhotoOption[] | null
  >(null);
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
    if (starredOptions === null) {
      fetchSiteStarredPhotoOptions(siteId)
        .then(setStarredOptions)
        .catch(() => setStarredOptions([]));
    }
    if (audioOptions === null) {
      fetchSiteAudioOptions(siteId)
        .then(setAudioOptions)
        .catch(() => setAudioOptions([]));
    }
  }, [open, siteId, photoOptions, starredOptions, audioOptions]);

  const thumb = (id: number) =>
    `/api/public/site-images/${token}/${id}?size=thumb`;

  const presentTypes = new Set(blocks.map((b) => b.type));
  const missingSections = SECTION_ORDER.filter((t) => !presentTypes.has(t));

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
  function addBlock(type: SectionType) {
    // featuredPhotos is a singleton — never add a second one (U2).
    setBlocks((bs) =>
      type === "featuredPhotos" && bs.some((b) => b.type === "featuredPhotos")
        ? bs
        : [...bs, newBlock(type)]
    );
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSaving(true);
    // Persist on content only (KTD-1): drop empty section cards so an untouched
    // card never pollutes the resolved public page.
    const contentBlocks = blocks.filter((b) => !isEmptyBlock(b));
    const config: PageConfig = {
      version: initialConfig.version,
      blocks: [{ type: "hero", imageId: heroImageId }, ...contentBlocks],
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
    <div className="rounded-lg border bg-card p-4">
      {/* Split screen on desktop: controls left, sticky live preview right (U4).
          Below lg it collapses to a single column (preview under controls). */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6">
        {/* ---- Controls column ---- */}
        <div className="min-w-0 space-y-4">
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
          <div className="space-y-1.5 rounded border p-3">
            <div>
              <label className="text-xs font-semibold text-foreground">
                Foto principal
              </label>
              <p className="text-xs text-muted-foreground">
                La foto grande que encabeza la página del propietario.
              </p>
              <p className="text-[11px] text-muted-foreground">
                Elija una foto o deje &ldquo;Automático&rdquo; para usar la mejor
                captura del sitio.
              </p>
            </div>
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
                    heroImageId === null
                      ? "border-primary"
                      : "border-transparent"
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

          {/* Personalization sections (always present, each with instructions) */}
          <div className="space-y-3">
            {blocks.map((block, i) => {
              const meta =
                block.type in SECTION_META
                  ? SECTION_META[block.type as SectionType]
                  : null;
              const Icon = meta?.icon ?? Type;
              return (
                <div key={i} className="rounded border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        {meta?.label ?? block.type}
                      </span>
                      {meta && (
                        <>
                          <p className="text-xs text-muted-foreground">
                            {meta.description}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {meta.instruction}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex flex-none items-center gap-1">
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
                        aria-label="Eliminar sección"
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
                    starredOptions={starredOptions}
                    thumb={thumb}
                    token={token}
                  />
                </div>
              );
            })}
          </div>

          {/* Re-add a section that was removed (featuredPhotos stays single). */}
          {missingSections.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {missingSections.map((type) => {
                const meta = SECTION_META[type];
                const Icon = meta.icon;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => addBlock(type)}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
                  >
                    <Plus className="h-3 w-3" />
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="gap-1.5"
            >
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
        </div>

        {/* ---- Preview column (sticky on desktop, below controls on mobile) ---- */}
        {showPreview && (
          <div className="mt-6 space-y-1 lg:mt-0 lg:self-start lg:sticky lg:top-6">
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
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
  audioOptions,
  photoOptions,
  starredOptions,
  thumb,
  token,
}: {
  block: ContentBlock;
  onChange: (next: ContentBlock) => void;
  audioOptions: SiteAudioOption[] | null;
  photoOptions: SitePhotoOption[] | null;
  starredOptions: SitePhotoOption[] | null;
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

    case "featuredPhotos":
      return (
        <FeaturedPhotosEditor
          block={block}
          onChange={onChange}
          photoOptions={photoOptions}
          starredOptions={starredOptions}
          thumb={thumb}
        />
      );

    case "projectContext":
      return (
        <p className="text-xs text-muted-foreground">
          Muestra una tarjeta &ldquo;Sobre el proyecto BioChocó&rdquo; con un
          enlace a la página del proyecto.
        </p>
      );
  }
}

/**
 * Featured-photos picker with a "Solo destacadas ★ / Todas" filter (U3).
 * Defaults to the team's starred photos; auto-falls back to "Todas" (the
 * per-species best-photo pool) when the site has no starred images. The
 * 6-image cap is enforced in both modes.
 */
function FeaturedPhotosEditor({
  block,
  onChange,
  photoOptions,
  starredOptions,
  thumb,
}: {
  block: Extract<ContentBlock, { type: "featuredPhotos" }>;
  onChange: (next: ContentBlock) => void;
  photoOptions: SitePhotoOption[] | null;
  starredOptions: SitePhotoOption[] | null;
  thumb: (id: number) => string;
}) {
  // `null` = the team hasn't chosen a filter yet → derive the default: "Solo
  // destacadas", auto-falling back to "Todas" when the site has no starred
  // photos. Deriving (instead of an effect + setState) avoids cascading renders.
  const [modeChoice, setModeChoice] = useState<"starred" | "all" | null>(null);
  const autoMode: "starred" | "all" =
    starredOptions !== null && starredOptions.length === 0 ? "all" : "starred";
  const mode = modeChoice ?? autoMode;

  const options = mode === "starred" ? starredOptions : photoOptions;
  const imageIds = block.imageIds;
  const selected = new Set(imageIds);
  const atCap = imageIds.length >= FEATURED_PHOTOS_MAX;
  const toggle = (id: number) => {
    const next = selected.has(id)
      ? imageIds.filter((x) => x !== id)
      : [...imageIds, id].slice(0, FEATURED_PHOTOS_MAX);
    onChange({ type: "featuredPhotos", imageIds: next });
  };

  const pick = (target: "starred" | "all") => setModeChoice(target);

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border p-0.5 text-xs">
        <button
          type="button"
          onClick={() => pick("starred")}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 ${
            mode === "starred"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          <Star className="h-3 w-3" />
          Solo destacadas
        </button>
        <button
          type="button"
          onClick={() => pick("all")}
          className={`rounded px-2 py-1 ${
            mode === "all"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          Todas
        </button>
      </div>

      <p className="text-[10px] text-muted-foreground">
        {imageIds.length}/{FEATURED_PHOTOS_MAX} seleccionadas
      </p>

      {options === null ? (
        <p className="text-xs text-muted-foreground">Cargando fotos…</p>
      ) : options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {mode === "starred"
            ? "No hay fotos destacadas. Use “Todas” para elegir entre las mejores fotos por especie."
            : "No hay fotos disponibles."}
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {options.map((o) => {
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
      )}
    </div>
  );
}
