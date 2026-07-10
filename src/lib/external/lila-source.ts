/**
 * LILA BC source adapter: turn a dataset's COCO-Camera-Traps metadata into a
 * capped list of import candidates, each already mapped to a canonical Chocó
 * class AND carrying a bounding box.
 *
 * We do NOT run MegaDetector ourselves: LILA publishes MegaDetector results
 * (with repeat-detection-elimination / RDE) for every dataset, so we join those
 * precomputed boxes to our target images. That removes all detector compute from
 * the import. Boxes are MDv5a (RDE) rather than the portal's MDv6 — a negligible
 * difference for train-only augmentation, recorded honestly in `detectorVersion`.
 *
 * Metadata files are large (WCS is ~840MB) and not always valid JSON (some carry
 * `"datetime": NaN`), so we STREAM-parse them with a NaN/Infinity sanitizer
 * rather than `JSON.parse` (which has a ~512MB string ceiling and rejects NaN).
 *
 * LILA per-dataset category names are sometimes COMMON names ("ocelot", "agouti"),
 * so callers pass a taxonomy map (LILA's taxonomy-mapping CSV: category →
 * scientific binomial); when a category is already scientific the map misses and
 * we map it directly.
 *
 * The pure core (`selectCandidates`) is unit-tested; the streaming network path
 * (`fetchLilaMetadata`) reuses the same per-annotation policy via `resolveClass`.
 */

import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { unzipSync } from "fflate";
import { parse as parseCsv } from "csv-parse/sync";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/Pick";
import { streamArray } from "stream-json/streamers/StreamArray";

import { mapTaxonToClass, isLicenseAllowed } from "./taxon-map";

/** Minimal slice of the COCO-Camera-Traps JSON we rely on. */
export interface CocoMetadata {
  images: Array<{
    id: string;
    file_name: string;
    /** Some LILA sets carry a per-image license; falls back to dataset license. */
    license?: string | null;
  }>;
  annotations: Array<{
    image_id: string;
    category_id: number;
  }>;
  categories: Array<{ id: number; name: string }>;
}

/** One image selected for import, mapped to a canonical class. */
export interface ImportCandidate {
  sourceDataset: string;
  sourceImageId: string;
  sourceUrl: string;
  originalTaxon: string;
  mappedClass: string;
  license: string;
  /**
   * Precomputed MegaDetector box `[x, y, w, h]` normalized to [0,1]. Present on
   * candidates from {@link fetchLilaMetadata}; absent from the pure in-memory
   * {@link selectCandidates} (which exists for unit tests).
   */
  bbox?: [number, number, number, number];
  /** Confidence of the chosen animal detection. */
  detConf?: number;
  /** Detector that produced `bbox`, recorded as the crop's model version. */
  detectorVersion?: string;
}

export interface DatasetConfig {
  /** Stable slug used in filenames + provenance, e.g. "orinoquia" / "wcs". */
  slug: string;
  /** Human label, e.g. "Orinoquía Camera Traps". */
  name: string;
  /** URL of the COCO-Camera-Traps metadata (a ZIP holding one JSON, or a JSON). */
  metadataUrl: string;
  /** URL of LILA's MegaDetector-with-RDE results (a ZIP holding one JSON). */
  mdResultsUrl: string;
  /** Base URL the per-image `file_name` is appended to (public bucket). */
  imageBaseUrl: string;
  /** Dataset-level license, used when an image has none of its own. */
  datasetLicense: string;
}

/** MegaDetector category id for "animal" in LILA results files. */
const MD_ANIMAL_CATEGORY = "1";
/** Drop animal detections below this confidence (LILA's typical threshold). */
const MD_CONF_FLOOR = 0.2;
/** Recorded as each external crop's detector model version. */
export const MD_DETECTOR_VERSION = "MDv5a.0.0-RDE";

function normalize(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve a raw COCO category name to a canonical Chocó class via the optional
 * taxonomy map then the congener policy. Returns the scientific binomial used
 * and the mapped class, or `null` if the taxon is not a target. Shared by the
 * pure and streaming selection paths so they can never diverge.
 */
function resolveClass(
  categoryName: string,
  taxonomyMap?: Map<string, string>,
): { scientific: string; mappedClass: string } | null {
  const scientific = taxonomyMap?.get(normalize(categoryName)) ?? categoryName;
  const mappedClass = mapTaxonToClass(scientific);
  return mappedClass ? { scientific, mappedClass } : null;
}

/**
 * Pure selection (in-memory): map every annotated image to a canonical class,
 * drop unmapped / non-allowlisted / non-target images, dedupe to one candidate
 * per image (first mapped annotation wins), and cap per class. Used by unit
 * tests; production uses {@link fetchLilaMetadata}, which streams + adds boxes.
 *
 * @param capByClass max candidates per canonical class. A class absent from the
 *   map is treated as cap 0 (not a target) so we never pull unrequested classes.
 * @param taxonomyMap optional category-name → scientific-binomial resolver.
 */
export function selectCandidates(input: {
  dataset: DatasetConfig;
  metadata: CocoMetadata;
  capByClass: Map<string, number>;
  taxonomyMap?: Map<string, string>;
}): ImportCandidate[] {
  const { dataset, metadata, capByClass, taxonomyMap } = input;

  const categoryById = new Map<number, string>();
  for (const c of metadata.categories) categoryById.set(c.id, c.name);

  const imageById = new Map<string, CocoMetadata["images"][number]>();
  for (const img of metadata.images) imageById.set(img.id, img);

  const kept: ImportCandidate[] = [];
  const perClassCount = new Map<string, number>();
  const seenImages = new Set<string>();

  for (const ann of metadata.annotations) {
    if (seenImages.has(ann.image_id)) continue; // one crop per source image

    const categoryName = categoryById.get(ann.category_id);
    if (!categoryName) continue;

    const resolved = resolveClass(categoryName, taxonomyMap);
    if (!resolved) continue;
    const { scientific, mappedClass } = resolved;

    const cap = capByClass.get(mappedClass) ?? 0;
    if (cap <= 0) continue;
    if ((perClassCount.get(mappedClass) ?? 0) >= cap) continue;

    const img = imageById.get(ann.image_id);
    if (!img) continue;

    const license = img.license ?? dataset.datasetLicense;
    if (!isLicenseAllowed(license)) continue;

    seenImages.add(ann.image_id);
    perClassCount.set(mappedClass, (perClassCount.get(mappedClass) ?? 0) + 1);
    kept.push({
      sourceDataset: dataset.slug,
      sourceImageId: img.id,
      sourceUrl: dataset.imageBaseUrl.replace(/\/$/, "") + "/" + img.file_name,
      originalTaxon: scientific,
      mappedClass,
      license,
    });
  }

  return kept;
}

/**
 * Default URL of LILA's taxonomy-mapping CSV (category name → scientific name
 * for every dataset). Overridable via env. See
 * https://lila.science/taxonomy-mapping-for-camera-trap-data-sets/
 */
export const LILA_TAXONOMY_CSV_URL =
  process.env.LILA_TAXONOMY_CSV_URL ??
  "https://lila.science/public/lila-taxonomy-mapping_release.csv";

/**
 * Fetch LILA's taxonomy-mapping CSV and build a `normalize(query) → scientific
 * binomial` map across all datasets. Orinoquía's COCO categories are common
 * names ("ocelot", "red_brocket_deer") that only resolve through this map; WCS
 * categories are already scientific and largely miss it (then map directly).
 *
 * A global (not per-dataset) map is intentional: our target queries are
 * unambiguous common names, and falling back to the raw category name when a
 * query is absent keeps scientific-name datasets working.
 */
export async function fetchLilaTaxonomyMap(): Promise<Map<string, string>> {
  const res = await fetch(LILA_TAXONOMY_CSV_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `LILA taxonomy CSV fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  const rows = parseCsv(await res.text(), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Array<{ query?: string; scientific_name?: string }>;

  const map = new Map<string, string>();
  for (const r of rows) {
    const query = r.query?.trim();
    const sci = r.scientific_name?.trim();
    if (query && sci) map.set(normalize(query), sci);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Streaming ingestion (large, occasionally-invalid LILA JSON)
// ---------------------------------------------------------------------------

/**
 * Stream transform that replaces JSON-invalid `NaN` / `Infinity` / `-Infinity`
 * value tokens with `null`. Some LILA COCO files carry `"datetime": NaN`, which
 * a strict JSON parser rejects. Operates on raw bytes via latin1 (a 1:1
 * byte↔char map), holding back a few trailing bytes so a token split across
 * chunk boundaries is still rewritten. Only ASCII tokens are touched, so all
 * other bytes (incl. UTF-8 filenames) round-trip unchanged.
 */
function sanitizeJsonStream(): Transform {
  const TOKEN = /(?<=[:\s,[])(?:NaN|-?Infinity)(?=[\s,\]}])/g;
  const HOLD = 12; // > longest token + delimiters
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const buf = Buffer.concat([carry, chunk]);
      const cut = Math.max(0, buf.length - HOLD);
      const head = buf.subarray(0, cut).toString("latin1").replace(TOKEN, "null");
      carry = buf.subarray(cut);
      cb(null, Buffer.from(head, "latin1"));
    },
    flush(cb) {
      cb(null, Buffer.from(carry.toString("latin1").replace(TOKEN, "null"), "latin1"));
    },
  });
}

/**
 * Download a metadata/results URL and write the contained COCO/MD JSON to a
 * temp file, unzipping if it is a ZIP. Returns the temp file path (caller must
 * delete). We materialize to disk so the big JSON can be stream-parsed multiple
 * times cheaply without re-downloading or holding a giant string in memory.
 */
async function downloadJsonToTemp(
  url: string,
  slug: string,
  kind: string,
): Promise<string> {
  // `no-store`: these payloads are tens-to-hundreds of MB; Next.js would
  // otherwise try to cache the fetch response (and log "Single item size
  // exceeds maxSize" when it can't). We never want them cached.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `LILA fetch failed (${kind}) for ${slug}: ${res.status} ${res.statusText}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // ZIP files start with the local-file-header magic "PK\x03\x04".
  const isZip =
    url.toLowerCase().endsWith(".zip") || (bytes[0] === 0x50 && bytes[1] === 0x4b);

  let jsonBytes: Uint8Array;
  if (isZip) {
    const files = unzipSync(bytes);
    const jsonName = Object.keys(files).find((n) =>
      n.toLowerCase().endsWith(".json"),
    );
    if (!jsonName) {
      throw new Error(`LILA ${kind} ZIP for ${slug} contains no .json entry`);
    }
    jsonBytes = files[jsonName];
  } else {
    jsonBytes = bytes;
  }

  const tmp = path.join(os.tmpdir(), `lila-${slug}-${kind}-${process.pid}.json`);
  await fs.writeFile(tmp, jsonBytes);
  return tmp;
}

/**
 * Stream one top-level array (`filterPath`, e.g. "images") out of a JSON file,
 * invoking `onItem` per element. Sanitizes NaN/Infinity first. Memory stays flat
 * regardless of file size.
 */
async function streamArrayFromFile(
  file: string,
  filterPath: string,
  onItem: (value: unknown) => void,
): Promise<void> {
  const consumer = new Writable({
    objectMode: true,
    write(chunk: { value: unknown }, _enc, cb) {
      try {
        onItem(chunk.value);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  await pipeline(
    createReadStream(file),
    sanitizeJsonStream(),
    parser(),
    pick({ filter: filterPath }),
    streamArray(),
    consumer,
  );
}

/**
 * Production source path: stream a dataset's (possibly huge) COCO metadata,
 * map images to canonical classes, join LILA's precomputed MegaDetector-RDE
 * boxes, drop images without a usable box, and cap per class.
 *
 * Three metadata passes keep memory bounded (we only retain target images, not
 * the full 1M+ image list): categories → annotations(image→class) →
 * images(file_name for targets). Then one pass over the MD results for boxes.
 */
export async function fetchLilaMetadata(
  dataset: DatasetConfig,
  capByClass: Map<string, number>,
  taxonomyMap?: Map<string, string>,
  onProgress?: (msg: string) => void,
): Promise<ImportCandidate[]> {
  const report = (msg: string) => onProgress?.(msg);

  report(`Descargando metadatos de ${dataset.name}…`);
  const metaFile = await downloadJsonToTemp(dataset.metadataUrl, dataset.slug, "meta");
  try {
    // Pass 1: categories (small) → id → name.
    report(`Leyendo categorías de ${dataset.name}…`);
    const categoryById = new Map<number, string>();
    let sawCategories = false;
    await streamArrayFromFile(metaFile, "categories", (v) => {
      sawCategories = true;
      const c = v as { id: number; name: string };
      categoryById.set(c.id, c.name);
    });

    // Pass 2: annotations → first mapped class per image (dedupe to one/image).
    const hitByImage = new Map<string, { scientific: string; mappedClass: string }>();
    let sawAnnotations = false;
    let annScanned = 0;
    await streamArrayFromFile(metaFile, "annotations", (v) => {
      sawAnnotations = true;
      if (++annScanned % 250_000 === 0) {
        report(
          `Analizando anotaciones de ${dataset.name}… (${annScanned.toLocaleString()} leídas, ${hitByImage.size.toLocaleString()} objetivo)`,
        );
      }
      const a = v as { image_id: string; category_id: number };
      if (hitByImage.has(a.image_id)) return;
      const name = categoryById.get(a.category_id);
      if (!name) return;
      const resolved = resolveClass(name, taxonomyMap);
      if (resolved) hitByImage.set(a.image_id, resolved);
    });

    // Pass 3: images → file_name + license, but only for target images.
    report(`Resolviendo archivos de ${dataset.name} (${hitByImage.size.toLocaleString()} imágenes objetivo)…`);
    const metaByImage = new Map<string, { file: string; license: string }>();
    let sawImages = false;
    let imgScanned = 0;
    await streamArrayFromFile(metaFile, "images", (v) => {
      sawImages = true;
      if (++imgScanned % 250_000 === 0) {
        report(`Resolviendo archivos de ${dataset.name}… (${imgScanned.toLocaleString()} escaneadas)`);
      }
      const im = v as { id: string; file_name: string; license?: string | null };
      if (!hitByImage.has(im.id)) return;
      const license = im.license ?? dataset.datasetLicense;
      if (!isLicenseAllowed(license)) return;
      metaByImage.set(im.id, {
        file: String(im.file_name).replace(/\\/g, "/"),
        license,
      });
    });

    if (!sawCategories || !sawAnnotations || !sawImages) {
      throw new Error(
        `LILA metadata for ${dataset.slug} is missing images/annotations/categories — refusing to import partial data`,
      );
    }

    // Build the uncapped target list (image → class + file). We cap AFTER the
    // box join so caps count only images that actually have a usable box.
    interface Uncapped extends ImportCandidate {
      file: string;
    }
    const uncapped: Uncapped[] = [];
    for (const [id, hit] of hitByImage) {
      const m = metaByImage.get(id);
      if (!m) continue;
      uncapped.push({
        sourceDataset: dataset.slug,
        sourceImageId: id,
        sourceUrl: dataset.imageBaseUrl.replace(/\/$/, "") + "/" + m.file,
        originalTaxon: hit.scientific,
        mappedClass: hit.mappedClass,
        license: m.license,
        file: m.file,
      });
    }

    // Join precomputed MegaDetector boxes (best animal detection per image).
    report(
      `Descargando cajas de MegaDetector de ${dataset.name} (${uncapped.length.toLocaleString()} candidatos)…`,
    );
    const wanted = new Set(uncapped.map((c) => c.file));
    const mdFile = await downloadJsonToTemp(dataset.mdResultsUrl, dataset.slug, "md");
    const boxByFile = new Map<string, { bbox: number[]; conf: number }>();
    let mdScanned = 0;
    try {
      report(`Uniendo cajas de MegaDetector de ${dataset.name}…`);
      await streamArrayFromFile(mdFile, "images", (v) => {
        if (++mdScanned % 250_000 === 0) {
          report(
            `Uniendo cajas de MegaDetector de ${dataset.name}… (${mdScanned.toLocaleString()} resultados, ${boxByFile.size.toLocaleString()} emparejadas)`,
          );
        }
        const im = v as {
          file: string;
          detections?: Array<{ category: string; conf: number; bbox: number[] }>;
        };
        const f = String(im.file).replace(/\\/g, "/");
        if (!wanted.has(f)) return;
        let best: { bbox: number[]; conf: number } | null = null;
        for (const d of im.detections ?? []) {
          if (
            d.category === MD_ANIMAL_CATEGORY &&
            d.conf >= MD_CONF_FLOOR &&
            (!best || d.conf > best.conf)
          ) {
            best = { bbox: d.bbox, conf: d.conf };
          }
        }
        if (best) boxByFile.set(f, best);
      });
    } finally {
      await fs.rm(mdFile, { force: true });
    }

    // Attach boxes, drop box-less images, then cap per class.
    const perClassCount = new Map<string, number>();
    const out: ImportCandidate[] = [];
    for (const c of uncapped) {
      const box = boxByFile.get(c.file);
      if (!box) continue;
      const cap = capByClass.get(c.mappedClass) ?? 0;
      if (cap <= 0) continue;
      if ((perClassCount.get(c.mappedClass) ?? 0) >= cap) continue;
      perClassCount.set(c.mappedClass, (perClassCount.get(c.mappedClass) ?? 0) + 1);
      out.push({
        sourceDataset: c.sourceDataset,
        sourceImageId: c.sourceImageId,
        sourceUrl: c.sourceUrl,
        originalTaxon: c.originalTaxon,
        mappedClass: c.mappedClass,
        license: c.license,
        bbox: box.bbox as [number, number, number, number],
        detConf: box.conf,
        detectorVersion: MD_DETECTOR_VERSION,
      });
    }
    report(
      `${dataset.name}: ${out.length.toLocaleString()} candidatos con caja (de ${uncapped.length.toLocaleString()} imágenes objetivo)`,
    );
    return out;
  } finally {
    await fs.rm(metaFile, { force: true });
  }
}
