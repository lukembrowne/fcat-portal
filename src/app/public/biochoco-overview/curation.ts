/**
 * Curated media manifest for the public BioChoco overview page.
 *
 * This is the editorial control point (same version-controlled ethos as the
 * report repo's habitat-map.json): FCAT hand-picks which camera photos and
 * audio clips go public. Each entry references a DB id — a `biochoco_images.id`
 * for photos, an `audio_files.id` for clips — with a bilingual caption.
 *
 * At publish time build-snapshot.ts validates every id (must exist and belong
 * to BioChoco); unknown/foreign ids are dropped with a warning, never fatal.
 * An id becomes publicly servable ONLY by appearing here and in the resulting
 * snapshot — the manifest is the allowlist.
 *
 * To feature media: find the image/audio id in the internal portal, add an
 * entry below with a caption in both languages, and re-publish.
 */

import type { CuratedAudioClip, CuratedImage } from "./lib/snapshot-types";

export const CURATED_IMAGES: CuratedImage[] = [
  // Example (replace with real ids picked by FCAT):
  // {
  //   imageId: 12345,
  //   speciesLabel: "Panthera onca",
  //   caption: { en: "Jaguar on a ridge trail at dusk", es: "Jaguar en un sendero de cresta al anochecer" },
  // },
];

export const CURATED_AUDIO: CuratedAudioClip[] = [
  // Example (replace with real ids picked by FCAT):
  // {
  //   audioId: 6789,
  //   speciesLabel: "Grallaria alleni",
  //   caption: { en: "Moustached Antpitta, dawn chorus", es: "Gralaria bigotuda, coro del amanecer" },
  // },
];
