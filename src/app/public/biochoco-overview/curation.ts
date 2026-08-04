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

// Initial set chosen from starred / high-confidence reviewed BioChoco records
// (wild, charismatic species with a spread across cats, ground mammals, and
// game birds). Swap any entry you don't like for another id and re-publish.
export const CURATED_IMAGES: CuratedImage[] = [
  {
    imageId: 95250,
    speciesLabel: "Leopardus pardalis",
    caption: { en: "Ocelot walking along a trail at night", es: "Ocelote recorriendo un sendero del bosque de noche" },
  },
  {
    imageId: 44218,
    speciesLabel: "Dicotyles tajacu",
    caption: { en: "A collared peccary often seen traveling in groups", es: "Un pecarí de collar hurgando en la hojarasca" },
  },
  {
    imageId: 598222,
    speciesLabel: "Cuniculus paca",
    caption: { en: "Lowland paca foraging at night", es: "Guanta en su ronda nocturna de forrajeo" },
  },
  {
    imageId: 2245331,
    speciesLabel: "Dasyprocta punctata",
    caption: {
      en: "Central American agouti eating a fallen fruit, the forest's most-photographed mammal",
      es: "Guatusa comiendo un fruto caído, el mamífero más fotografiado del bosque",
    },
  },
  {
    imageId: 1848441,
    speciesLabel: "Nasua narica",
    caption: {
      en: "A white-nosed coati nosing through the leaf litter by day",
      es: "Un cuchucho hozando la hojarasca a plena luz del día",
    },
  },
  {
    imageId: 32667,
    speciesLabel: "Eira barbara",
    caption: { en: "Tayra, a large diurnal weasel, on the move", es: "Cabeza de mate (tayra), una gran comadreja diurna, en movimiento" },
  },
  {
    imageId: 860135,
    speciesLabel: "Penelope purpurascens",
    caption: { en: "Crested guan foraging on the forest floor", es: "Pava crestada alimentándose en el suelo del bosque" },
  },
  {
    imageId: 2284600,
    speciesLabel: "Tinamus major",
    caption: { en: "Great tinamou, more often heard than seen", es: "Tinamú grande, más escuchado que visto" },
  },
];

// High-confidence BirdNET detections (≈6-second recordings). The set leans on
// Chocó-endemic and threatened voices that make the case for the region.
export const CURATED_AUDIO: CuratedAudioClip[] = [
  {
    audioId: 102593,
    speciesLabel: "Ramphastos ambiguus",
    caption: { en: "A Yellow-throated Toucan calling from the canopy", es: "Tucán goliamarillo llamando sobre el dosel" },
  },
  {
    audioId: 132338,
    speciesLabel: "Ramphastos brevis",
    caption: { en: "Chocó Toucan, a Chocó endemic", es: "Tucán del Chocó, un endémico del Chocó, a corta distancia" },
  },
  {
    audioId: 130203,
    speciesLabel: "Cephalopterus penduliger",
    caption: { en: "Long-wattled Umbrellabird, a threatened Chocó endemic and flagship species for FCAT", es: "Pájaro paraguas longuipéndulo, una especialidad amenazada del Chocó" },
  },
  {
    audioId: 159399,
    speciesLabel: "Ortalis erythroptera",
    caption: { en: "Rufous-headed Chachalaca, an endangered endemic, at dawn", es: "Chachalaca cabecirrufa, un endémico en peligro, al amanecer" },
  },
  {
    audioId: 329074,
    speciesLabel: "Pulsatrix perspicillata",
    caption: { en: "Spectacled Owl calling after dark", es: "Búho de anteojos llamando tras el anochecer" },
  },
  {
    audioId: 181406,
    speciesLabel: "Tinamus major",
    caption: { en: "Great Tinamou's tremulous whistle at dusk", es: "El silbido trémulo del tinamú grande al atardecer" },
  },
];
