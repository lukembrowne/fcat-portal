/**
 * Configured external (LILA BC) source datasets the importer can pull from.
 *
 * URLs are the public-bucket locations from LILA's master dataset table
 * (https://lila.science/image-access/), verified June 2026. For each dataset:
 *  - `metadataUrl`: COCO-Camera-Traps metadata (a ZIP holding one JSON).
 *  - `mdResultsUrl`: LILA's precomputed MegaDetector-with-RDE results (a ZIP
 *    holding one JSON) — we join these boxes instead of running MegaDetector.
 *  - `imageBaseUrl`: prefix the per-image `file_name` is appended to.
 * Orinoquía category names are common names (resolved via LILA's taxonomy CSV);
 * WCS category names are scientific binomials. All overridable by env so ops can
 * correct them without a deploy. WCS metadata is ~840MB and is stream-parsed.
 */

import type { DatasetConfig } from "./lila-source";
import { EXTERNAL_TARGET_TIERS } from "./taxon-map";

const CDLA = "Community Data License Agreement - Permissive - Version 1.0";
const MD = "https://lila.science/public/lila-md-results";

export const LILA_DATASETS: Record<string, DatasetConfig> = {
  orinoquia: {
    slug: "orinoquia",
    name: "Orinoquía Camera Traps",
    metadataUrl:
      process.env.LILA_ORINOQUIA_METADATA_URL ??
      "https://storage.googleapis.com/public-datasets-lila/orinoquia-camera-traps/orinoquia_camera_traps_metadata.zip",
    mdResultsUrl:
      process.env.LILA_ORINOQUIA_MD_RESULTS_URL ??
      `${MD}/orinoquia-camera-traps_public_mdv5a.0.0_results.filtered_rde_0.150_0.850_10_0.200.json.zip`,
    imageBaseUrl:
      process.env.LILA_ORINOQUIA_IMAGE_BASE_URL ??
      "https://storage.googleapis.com/public-datasets-lila/orinoquia-camera-traps/public",
    datasetLicense: CDLA,
  },
  wcs: {
    slug: "wcs",
    name: "WCS Camera Traps",
    metadataUrl:
      process.env.LILA_WCS_METADATA_URL ??
      "https://storage.googleapis.com/public-datasets-lila/wcs/wcs_camera_traps.json.zip",
    mdResultsUrl:
      process.env.LILA_WCS_MD_RESULTS_URL ??
      `${MD}/wcs-camera-traps_animals_mdv5a.0.0_results.filtered_rde_0.150_0.850_20_0.200.json.zip`,
    imageBaseUrl:
      process.env.LILA_WCS_IMAGE_BASE_URL ??
      "https://storage.googleapis.com/public-datasets-lila/wcs-unzipped",
    datasetLicense: CDLA,
  },
};

/** Canonical classes the importer targets by default (Tier A + B). */
export const DEFAULT_REQUESTED_CLASSES = Object.keys(EXTERNAL_TARGET_TIERS);

export type LilaDatasetSlug = keyof typeof LILA_DATASETS;
