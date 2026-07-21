/**
 * Landowner public-page config — an ordered list of typed content blocks stored
 * as JSON on the site's active share token (`site_share_tokens.page_config`).
 *
 * Design (see docs/plans/2026-07-15-006-feat-landowner-page-builder-plan.md):
 *  - Block types are ADDITIVE: adding one never needs a schema migration, and an
 *    older reader silently drops unknown types (that is what keeps the format
 *    forward-compatible).
 *  - This module is PURE (no DB, no server-only): it validates shape only. Id
 *    validation against a site's media snapshot lives in the server action.
 *  - `parsePageConfig` is defensive in the same spirit as the `deploymentIds`
 *    guard in fetchSiteDetailByToken: any malformed input resolves to null and
 *    the caller falls back to the default (legacy) layout.
 */

export const PAGE_CONFIG_VERSION = 1 as const;

/** Caps enforced on parse (defensive) and in the builder/save action. */
export const FEATURED_PHOTOS_MAX = 6;
export const SUMMARY_MAX = 1200;
export const NOTE_MAX = 800;

export type PageBlock =
  | { type: "hero"; imageId: number | null }
  | { type: "summary"; text: string }
  | { type: "note"; text: string }
  | { type: "featuredPhotos"; imageIds: number[] }
  | { type: "featuredAudio"; audioId: number | null }
  | { type: "projectContext"; enabled: boolean };

export type PageBlockType = PageBlock["type"];

export interface PageConfig {
  version: typeof PAGE_CONFIG_VERSION;
  blocks: PageBlock[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toPositiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function clampText(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Validate a single raw block. Returns null for unknown/invalid blocks. */
function parseBlock(raw: unknown): PageBlock | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case "hero":
      return { type: "hero", imageId: toPositiveInt(raw.imageId) };
    case "summary":
      return { type: "summary", text: clampText(raw.text, SUMMARY_MAX) };
    case "note":
      return { type: "note", text: clampText(raw.text, NOTE_MAX) };
    case "featuredPhotos": {
      if (!Array.isArray(raw.imageIds)) return null;
      const ids: number[] = [];
      const seen = new Set<number>();
      for (const candidate of raw.imageIds) {
        const id = toPositiveInt(candidate);
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= FEATURED_PHOTOS_MAX) break;
      }
      return { type: "featuredPhotos", imageIds: ids };
    }
    case "featuredAudio":
      return { type: "featuredAudio", audioId: toPositiveInt(raw.audioId) };
    case "projectContext":
      return { type: "projectContext", enabled: raw.enabled === true };
    default:
      return null; // unknown type → dropped (forward-compatible)
  }
}

/**
 * Parse a stored config string into a validated PageConfig, or null when the
 * input is absent/malformed/unsupported. Unknown block types are dropped; known
 * blocks are kept in order. Text is clamped and photo ids are deduped/capped.
 */
export function parsePageConfig(
  raw: string | null | undefined,
): PageConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.version !== PAGE_CONFIG_VERSION) return null;
  if (!Array.isArray(parsed.blocks)) return null;

  const blocks: PageBlock[] = [];
  for (const raw of parsed.blocks) {
    const block = parseBlock(raw);
    if (block) blocks.push(block);
  }
  return { version: PAGE_CONFIG_VERSION, blocks };
}

/** Serialize a config for storage. Assumes an already-valid config. */
export function serializePageConfig(config: PageConfig): string {
  return JSON.stringify(config);
}

/**
 * Collapse a config so it carries AT MOST ONE `featuredPhotos` block: the first
 * such block is kept in place, any later ones are dropped. All other blocks
 * (and their order) are preserved.
 *
 * "Fotos destacadas" is a singleton section (see the page-builder refinement
 * plan, KTD-2). Enforced defensively here so it holds no matter how the config
 * was produced — builder save, a legacy config with duplicates, or the public
 * resolver — and a page can never render two "Fotos destacadas" sections.
 */
export function enforceFeaturedPhotosSingleton(config: PageConfig): PageConfig {
  let seen = false;
  const blocks: PageBlock[] = [];
  for (const b of config.blocks) {
    if (b.type === "featuredPhotos") {
      if (seen) continue; // drop every featuredPhotos after the first
      seen = true;
    }
    blocks.push(b);
  }
  return { version: config.version, blocks };
}

/**
 * Keep only the featured-photo ids that survive snapshot validation, in their
 * original order. An empty result means the block resolves to nothing (it is
 * neither persisted nor rendered). Shared by the save sanitizer and the public
 * resolver so both apply the exact same token-snapshot gate.
 */
export function validateFeaturedPhotoIds(
  imageIds: number[],
  validIds: Set<number>,
): number[] {
  return imageIds.filter((id) => validIds.has(id));
}

/**
 * Build a config equivalent to the legacy per-token fields, in the current
 * default render order (hero, then note, then featured audio). Used by the
 * one-time backfill and as the fallback when a token has no page_config yet, so
 * no live page changes appearance at cutover.
 */
export function defaultConfigFromLegacy(legacy: {
  heroImageId: number | null;
  landownerNote: string | null;
  featuredAudioId: number | null;
}): PageConfig {
  const blocks: PageBlock[] = [
    { type: "hero", imageId: legacy.heroImageId ?? null },
  ];
  const note = (legacy.landownerNote ?? "").trim();
  if (note) blocks.push({ type: "note", text: note.slice(0, NOTE_MAX) });
  if (legacy.featuredAudioId != null) {
    blocks.push({ type: "featuredAudio", audioId: legacy.featuredAudioId });
  }
  return { version: PAGE_CONFIG_VERSION, blocks };
}
