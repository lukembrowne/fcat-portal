/**
 * Bilingual copy for the public BioChoco overview page.
 *
 * No i18n library — parallel `en` / `es` objects with an identical key shape,
 * matching the portal's hardcoded-strings convention. Numbers are injected from
 * the snapshot at render time and are language-agnostic; only labels live here.
 *
 * The Spanish is a draft pending FCAT review. Edit either language independently.
 */

import type { Lang } from "./lib/snapshot-types";

export interface Contact {
  name: string;
  role: string;
  email: string;
}

export interface ReportContent {
  eyebrow: string;
  title: string;
  subtitle: string;
  intro: string;

  statLabels: {
    deployments: string;
    deploymentsSub: string; // "{cam} camera · {audio} audio · {climate} climate" scaffold label
    sites: string;
    cameraSpecies: string;
    audioSpecies: string;
    audioSpeciesSub: string;
    detections: string;
    cameraTrapDays: string;
    iButtonReadings: string;
  };

  learn: { heading: string; body: string[] };
  methods: { heading: string; body: string[] };

  species: {
    heading: string;
    cameraHeading: string;
    audioHeading: string;
    audioCaveat: string;
    detectionsLabel: string;
  };

  media: {
    heading: string;
    photosHeading: string;
    audioHeading: string;
    empty: string;
  };

  map: { heading: string; note: string };

  collaborate: { heading: string; body: string[]; contactsHeading: string };
  contacts: Contact[];

  footer: string;

  ui: {
    toLanguage: string; // label for the toggle button that switches AWAY
    print: string;
    download: string;
    comingSoonTitle: string;
    comingSoonBody: string;
    publishedAt: string; // "Data as of" prefix
  };
}

const contacts: Contact[] = [
  { name: "Luke Browne", role: "Research Lead", email: "lukebrowne@fcat-ecuador.org" },
  { name: "Luis Carrasco", role: "Reserve Director", email: "luiscarrasco@fcat-ecuador.org" },
  { name: "Jordan Karubian", role: "Co-Founder", email: "jordankarubian@fcat-ecuador.org" },
];

const en: ReportContent = {
  eyebrow: "BioChoco · Ecuadorian Chocó",
  title: "A living record of one of the world's richest rainforests",
  subtitle:
    "FCAT runs a landscape-scale biodiversity monitoring network across forest, cacao agroforestry, and restoration in the Ecuadorian Chocó. This is an open invitation to build on it.",
  intro:
    "Cameras, acoustic recorders, and microclimate loggers sample sites across a working conservation landscape. The data below is live from our field program — we are looking for researchers to collaborate, ask new questions, and help turn it into science.",

  statLabels: {
    deployments: "monitoring deployments",
    deploymentsSub: "camera · audio · climate",
    sites: "field sites",
    cameraSpecies: "camera species",
    audioSpecies: "candidate audio species",
    audioSpeciesSub: "automated, pending review",
    detections: "wildlife detections",
    cameraTrapDays: "camera-trap-days",
    iButtonReadings: "microclimate readings",
  },

  learn: {
    heading: "What we're trying to learn",
    body: [
      "How does biodiversity respond as land shifts between primary forest, regenerating forest, cacao agroforestry, and restoration? Which management choices recover the most biodiversity per hectare — and per dollar?",
      "We model occupancy of birds, mammals, and soundscapes across this gradient, and track how a connected reserve can knit fragmented habitat back together.",
    ],
  },
  methods: {
    heading: "How the monitoring works",
    body: [
      "Camera traps record wildlife day and night; MegaDetector and species classifiers surface animals from millions of frames, with expert review of the labels that matter.",
      "Passive acoustic recorders capture the dawn-to-dusk soundscape; BirdNET proposes species that experts then confirm.",
      "Microclimate loggers measure the temperature each sensor site actually experiences, grounding the biology in local conditions.",
    ],
  },

  species: {
    heading: "What we're finding",
    cameraHeading: "Most-detected camera species",
    audioHeading: "Most-detected audio species",
    audioCaveat: "Audio species are automated candidates (confidence ≥ 0.8) pending expert review, not a confirmed list.",
    detectionsLabel: "detections",
  },

  media: {
    heading: "From the field",
    photosHeading: "Camera-trap photographs",
    audioHeading: "Field recordings",
    empty: "Curated photos and recordings are being selected and will appear here soon.",
  },

  map: {
    heading: "Where we sample",
    note: "Sites are shown at reserve scale; exact camera locations are not published.",
  },

  collaborate: {
    heading: "Collaborate with us",
    body: [
      "This dataset is open to researchers. If you work on occupancy, bioacoustics, agroforestry, restoration ecology, or Chocó biodiversity — or want to bring a new question to it — we'd like to hear from you.",
      "Students, postdocs, and PIs are all welcome. Tell us what you'd explore.",
    ],
    contactsHeading: "Get in touch",
  },
  contacts,

  footer: "FCAT — Fundación para la Conservación de los Andes Tropicales",

  ui: {
    toLanguage: "Español",
    print: "Save as PDF",
    download: "Download",
    comingSoonTitle: "Coming soon",
    comingSoonBody: "This overview is being prepared and will be published shortly.",
    publishedAt: "Data as of",
  },
};

const es: ReportContent = {
  eyebrow: "BioChoco · Chocó ecuatoriano",
  title: "Un registro vivo de uno de los bosques más ricos del planeta",
  subtitle:
    "FCAT mantiene una red de monitoreo de biodiversidad a escala de paisaje en bosque, agroforestería de cacao y restauración en el Chocó ecuatoriano. Esta es una invitación abierta a construir sobre ella.",
  intro:
    "Cámaras, grabadoras acústicas y registradores de microclima muestrean sitios en un paisaje de conservación productivo. Los datos a continuación provienen en vivo de nuestro programa de campo — buscamos investigadores para colaborar, plantear nuevas preguntas y ayudar a convertirlos en ciencia.",

  statLabels: {
    deployments: "instalaciones de monitoreo",
    deploymentsSub: "cámara · audio · clima",
    sites: "sitios de campo",
    cameraSpecies: "especies en cámara",
    audioSpecies: "especies candidatas en audio",
    audioSpeciesSub: "automáticas, pendientes de revisión",
    detections: "detecciones de fauna",
    cameraTrapDays: "días-cámara-trampa",
    iButtonReadings: "registros de microclima",
  },

  learn: {
    heading: "Qué buscamos aprender",
    body: [
      "¿Cómo responde la biodiversidad cuando la tierra cambia entre bosque primario, bosque en regeneración, agroforestería de cacao y restauración? ¿Qué decisiones de manejo recuperan más biodiversidad por hectárea — y por dólar?",
      "Modelamos la ocupación de aves, mamíferos y paisajes sonoros a lo largo de este gradiente, y seguimos cómo una reserva conectada puede volver a unir hábitats fragmentados.",
    ],
  },
  methods: {
    heading: "Cómo funciona el monitoreo",
    body: [
      "Las cámaras trampa registran fauna de día y de noche; MegaDetector y clasificadores de especies extraen animales de millones de fotogramas, con revisión experta de las etiquetas clave.",
      "Las grabadoras acústicas pasivas capturan el paisaje sonoro del amanecer al anochecer; BirdNET propone especies que los expertos luego confirman.",
      "Los registradores de microclima miden la temperatura que realmente experimenta cada sitio, anclando la biología a las condiciones locales.",
    ],
  },

  species: {
    heading: "Qué estamos encontrando",
    cameraHeading: "Especies más detectadas en cámara",
    audioHeading: "Especies más detectadas en audio",
    audioCaveat: "Las especies de audio son candidatas automáticas (confianza ≥ 0.8) pendientes de revisión experta, no una lista confirmada.",
    detectionsLabel: "detecciones",
  },

  media: {
    heading: "Desde el campo",
    photosHeading: "Fotografías de cámara trampa",
    audioHeading: "Grabaciones de campo",
    empty: "Se están seleccionando fotos y grabaciones curadas que aparecerán aquí pronto.",
  },

  map: {
    heading: "Dónde muestreamos",
    note: "Los sitios se muestran a escala de reserva; no se publican las ubicaciones exactas de las cámaras.",
  },

  collaborate: {
    heading: "Colabora con nosotros",
    body: [
      "Este conjunto de datos está abierto a investigadores. Si trabajas en ocupación, bioacústica, agroforestería, ecología de la restauración o biodiversidad del Chocó — o quieres traer una nueva pregunta — nos gustaría saber de ti.",
      "Estudiantes, postdoctorados e investigadores principales son bienvenidos. Cuéntanos qué explorarías.",
    ],
    contactsHeading: "Contáctanos",
  },
  contacts,

  footer: "FCAT — Fundación para la Conservación de los Andes Tropicales",

  ui: {
    toLanguage: "English",
    print: "Guardar como PDF",
    download: "Descargar",
    comingSoonTitle: "Próximamente",
    comingSoonBody: "Esta descripción se está preparando y se publicará en breve.",
    publishedAt: "Datos al",
  },
};

export const CONTENT: Record<Lang, ReportContent> = { en, es };

/** Default language: Spanish, the organization's working language. */
export const DEFAULT_LANG: Lang = "es";
