/**
 * Bilingual copy for the public BioChoco overview page.
 *
 * This is a faithful port of the standalone collaborator report
 * (~/Desktop/BioChoco-Collaborator-Report.html): the ENGLISH strings are the
 * Desktop text verbatim; the SPANISH is drafted to match, pending FCAT review.
 *
 * No i18n library — parallel `en` / `es` objects with an identical key shape,
 * matching the portal's hardcoded-strings convention. Numbers are injected from
 * the snapshot at render time via `{token}` placeholders the shell interpolates;
 * only labels/prose live here. Habitat names/descriptions live in `lib/habitat.ts`.
 */

import type { Lang } from "./lib/snapshot-types";

export interface Contact {
  name: string;
  role: string;
  email: string;
}

export interface TitledBody {
  title: string;
  body: string;
}

export interface MethodCard {
  title: string;
  model: string;
  body: string;
}

export interface GalleryShot {
  /** Screenshot filename under public/biochoco-overview/gallery/ (same value in en/es). */
  file: string;
  addr: string;
  title: string;
  caption: string;
}

export interface StatLabel {
  /** Fixed label under the number. */
  label: string;
  /** Sub-line; may contain `{token}` placeholders interpolated in the shell. */
  sub: string;
}

export interface ReportContent {
  hero: {
    eyebrow: string;
    title: string;
    sub: string;
    liveDate: string; // "Data current {date}"
    metaSensors: string;
  };

  learn: {
    heading: string;
    intro: string;
    objectives: { num: string; title: string; body: string }[]; // 4
    peopleHeading: string;
    people: string;
  };

  methods: {
    heading: string;
    intro: string;
    cards: MethodCard[]; // 4
    habitatHead: { title: string; body: string };
    sitesSampledOne: string; // "site sampled"
    sitesSampledMany: string; // "sites sampled"
  };

  stats: {
    eyebrow: string;
    heading: string;
    spanLine: string; // "... covering {span}."
    tiles: StatLabel[]; // 7, in Desktop order
    note: string; // statNote template with {deploymentCount} {retrievedCount} {inField}
  };

  map: {
    heading: string;
    note: string;
    legendTitle: string;
  };

  species: {
    heading: string;
    intro: string;
    onCamera: string;
    bySound: string;
    camCap: string; // "{n} species identified so far. ..."
    audCap: string; // "Most-detected birds across {n} recordings:"
    audNote: string; // "... more than {n} candidate bird species. ..."
  };

  bonus: {
    heading: string;
    photosHeading: string;
    audioHeading: string;
  };

  platform: {
    heading: string;
    intro: string;
    gallery: GalleryShot[]; // 4
  };

  collaborate: {
    heading: string;
    intro: string;
    oppListTitle: string;
    oppList: TitledBody[]; // 5
    network: string;
    ctaHeading: string;
    ctaBody: string;
    contactsHeading: string;
  };

  contacts: Contact[]; // 3

  footer: {
    org: string;
    tagline: string;
    date: string; // "Data current as of {date}"
  };

  ui: {
    toLanguage: string; // label for the toggle button that switches AWAY
    print: string;
    download: string;
    comingSoonTitle: string;
    comingSoonBody: string;
    publishedAt: string; // "Data as of" prefix
  };
}

const en: ReportContent = {
  hero: {
    eyebrow: "",
    title: "BioChocó",
    sub: "An integrated biodiversity monitoring network across a forest-to-farm landscape in the Chocó of western Ecuador.",
    liveDate: "Data current {date}",
    metaSensors: "Camera traps · passive acoustics · habitat · endangered species",
  },

  learn: {
    heading: "Objectives",
    intro:
      "The Chocó is one of the most biodiverse rainforests on Earth, and more than 95% of its original forest is already gone. What remains is a mosaic of forest, cacao farms, and pasture. How does biodiversity respond to these shifts in land use? How can we design conservation interventions to maximize benefits for local communities and biodiversity? BioChocó is working to answer these questions.",
    objectives: [
      {
        num: "01",
        title: "Track conservation outcomes",
        body: "Follow the real-time conservation outcomes of FCAT's corridor-building and restoration interventions, so we can see how biodiversity recovers as it happens.",
      },
      {
        num: "02",
        title: "Understand land-use change",
        body: "Measure how biodiversity and ecosystems respond to land-use change across a gradient of land use types, from primary forest through cacao agroforestry to open pasture.",
      },
      {
        num: "03",
        title: "Assess priority species",
        body: "Provide scientifically rigorous habitat-use assessments for the Chocó's endangered and keystone species across birds, mammals, frogs, and insects.",
      },
      {
        num: "04",
        title: "Elevate the Chocó globally",
        body: "Raise global awareness of and engagement with this understudied rainforest through an open, real-time data platform.",
      },
    ],
    peopleHeading: "Part of a holistic conservation program",
    people:
      "BioChocó is one part of a broader, community-led conservation program: FCAT has worked run an award-winning conservation and research program since 2003, employs two dozen local residents, and pairs field research with education and capacity building. Our aproach has produced more than 50 peer-reviewed scientific papers with local coauthors and awards including the Whitley Prize for Nature. BioChocó is run by four local field biologyist - FCATer@s - and works with 50 local farmers who host stations on their land. ",
  },

  methods: {
    heading: "How each biodiversity monitoring station works",
    intro:
      "Every biodiversity monitoring station within the Biochocó network is built around a GPS coordinate and a stack of automated sensors, so a single visit captures animals, sound, climate, and forest structure together.",
    cards: [
      {
        title: "Motion-triggered camera",
        model: "Trail camera · photo mode",
        body: "Runs at least 30 days per deployment. We pass photos through a custom species classifier we fine-tuned for the Chocó and each image is reviewed and verified.",
      },
      {
        title: "Passive acoustic recorder",
        model: "Song Meter Micro 2 · 48 kHz",
        body: "Records one minute in every ten, around the clock. Recordings run through BirdNET for species identification.",
      },
      {
        title: "Microclimate logger",
        model: "iButton Thermochron",
        body: "Logs temperature at 30 minute intervals through the deployment, giving a paired record of the microclimate each camera and recorder experienced.",
      },
      {
        title: "Habitat structure",
        model: "Field survey · drone overflight",
        body: "On the first visit the team measures canopy cover, tree size and density, and forest cover around each station, then links structure to what the sensors detect.",
      },
    ],
    habitatHead: {
      title: "What habitats are we monitoring?",
      body: "Monitoring stations are spread across the full gradient of land use types in the region, from primary and regenerating forest to open pasture, along with three cacao farming systems.",
    },
    sitesSampledOne: "site sampled",
    sitesSampledMany: "sites sampled",
  },

  stats: {
    eyebrow: "",
    heading: "Where the network stands today",
    spanLine: "Every number here comes straight from the FCAT data portal, covering {span}.",
    tiles: [
      { label: "monitoring deployments", sub: "{cam} camera · {audio} audio · {climate} climate" },
      { label: "camera-trap days", sub: "{span}" },
      { label: "camera-trap photos", sub: "collected in the field" },
      { label: "identifications reviewed", sub: "verified or corrected by staff" },
      { label: "species on camera", sub: "{mammals} mammals · {birds} birds" },
      { label: "audio recordings", sub: "{tb} TB of sound" },
      { label: "microclimate readings", sub: "{loggers} temperature loggers" },
    ],
    note: "{deploymentCount} sensor deployments have been established this field season; the {retrievedCount} shown above have completed their run and been retrieved, and about {inField} are still collecting in the field. Because sensors run on a rotating schedule, these totals keep climbing — the camera, audio, and microclimate counts above reflect the data retrieved and processed so far.",
  },

  map: {
    heading: "Where we are working",
    note: "Each point is a monitoring deployment, colored by habitat type. Pan and zoom to explore; the dashed line marks the FCAT reserve boundary.",
    legendTitle: "Habitat",
  },

  species: {
    heading: "Who is showing up",
    intro:
      "Camera identifications are verified or corrected by FCAT biologists. Bird detections come from automated BirdNET analysis, filtered to a confidence of 0.8 or higher.",
    onCamera: "On camera",
    bySound: "By sound",
    camCap: "{n} species identified so far. The most-detected wild species:",
    audCap: "Most-detected birds across {n} recordings:",
    audNote:
      "At a confidence of 0.8 or higher, BirdNET has flagged calls matching more than {n} candidate bird species. These automated detections still await expert review, so treat the wider list as a starting point rather than a confirmed species count.",
  },

  bonus: {
    heading: "From the field",
    photosHeading: "Camera-trap photographs",
    audioHeading: "Field recordings",
  },

  platform: {
    heading: "One open platform for the whole network",
    intro:
      "FCAT is building a virtual living laboratory: a single portal that pulls raw files from Google Drive, runs AI detection and our fine-tuned BioCLIP classifier, lets biologists verify results, and publishes them as open data in the Camtrap DP standard for GBIF and the Environmental Data Initiative. The same system tracks the field schedule, the microclimate records, and the training of the classifier itself. The aim is to share what the sensors capture, imagery, sound, climate, and biodiversity, as open data for the wider research community.",
    gallery: [
      {
        file: "results-by-site.jpg",
        addr: "FCAT Portal · Resultados por sitio",
        title: "Results by site",
        caption:
          "Every deployment on one habitat-colored map, with camera, temperature, and audio readiness tracked per site.",
      },
      {
        file: "occupancy.jpg",
        addr: "FCAT Portal · Ocupación",
        title: "Live occupancy modeling",
        caption:
          "Single- and multi-species occupancy models that refit automatically as new camera and audio detections arrive, rendered as predicted-occurrence maps.",
      },
      {
        file: "species-classifier.jpg",
        addr: "FCAT Portal · Clasificador de especies",
        title: "Custom species classifier",
        caption:
          "A fine-tuned BioCLIP model built into the camera-trap annotation pipeline — versioned and benchmarked per species against earlier models.",
      },
      {
        file: "microclimate.jpg",
        addr: "FCAT Portal · Microclima",
        title: "Microclimate records",
        caption: "Each iButton logger's temperature series, deployment window, and coverage, per site.",
      },
    ],
  },

  collaborate: {
    heading: "Where collaborators come in",
    intro:
      "The network is designed as a shared foundation. The sensors run, the data lands in an open portal, and we want researchers to build on it.",
    oppListTitle: "Opportunities for collaboration",
    oppList: [
      {
        title: "Occupancy and community modeling",
        body: "Repeated visits across the land-use gradient support single- and multi-species occupancy and diversity work on birds, mammals, frogs, and insects, drawing on verified camera-trap species records — dates, coordinates, and imagery — in the Camtrap DP standard and published to GBIF and the Environmental Data Initiative.",
      },
      {
        title: "Bioacoustics",
        body: "A large acoustic archive — continuous day-and-night recordings with BirdNET output — for community- and species-level analysis, with expert point counts from ornithologist Juan Freile for ground-truthing.",
      },
      {
        title: "Machine learning and computer vision",
        body: "A labeled, growing dataset for classifier training and detection benchmarks, building on our fine-tuned BioCLIP and MegaDetector.",
      },
      {
        title: "Carbon, habitat, and restoration ecology",
        body: "Forest-structure data — paired with per-station temperature and microclimate series — tied to two active restoration and agroforestry experiments.",
      },
      {
        title: "Socio-ecological research",
        body: "Work at the human-environment interface, alongside FCAT's community and land-use research.",
      },
    ],
    network:
      "This builds on an established network. FCAT works with computer scientists and ecologists at Tulane University, researchers at Universidad San Francisco de Quito, the Cornell Lab of Ornithology, and the twelve-member Chocó Alliance, so collaborators plug into an active, well-connected effort.",
    ctaHeading: "Let's build on this together",
    ctaBody:
      "If your research could use camera-trap, acoustic, or microclimate data from a Chocó forest landscape, or you want to co-design a study around the network, we would like to talk.",
    contactsHeading: "Get in touch",
  },

  contacts: [
    { name: "Luke Browne", role: "Monitoring lead", email: "lukebrowne@fcat-ecuador.org" },
    { name: "Luis Carrasco", role: "FCAT Reserve Director", email: "luiscarrasco@fcat-ecuador.org" },
    { name: "Jordan Karubian", role: "FCAT co-founder", email: "jordankarubian@fcat-ecuador.org" },
  ],

  footer: {
    org: "Fundación para la Conservación de los Andes Tropicales",
    tagline: "BioChoco biodiversity monitoring network · Chocó, Ecuador",
    date: "Data current as of {date}",
  },

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
  hero: {
    eyebrow: "FCAT · Chocó, Ecuador",
    title: "BioChoco",
    sub: "Una red integrada de monitoreo de biodiversidad a lo largo de un paisaje de bosque a finca en el Chocó del occidente de Ecuador.",
    liveDate: "Datos al {date}",
    metaSensors: "Cámaras trampa · acústica pasiva · microclima · hábitat",
  },

  learn: {
    heading: "Qué buscamos aprender",
    intro:
      "El Chocó es uno de los bosques lluviosos más biodiversos de la Tierra, y más del 90% de su bosque original ya se ha perdido. Lo que queda es un mosaico de bosque, fincas de cacao y pastizal. FCAT lleva a cabo aquí dos experimentos a escala de paisaje, uno que restaura tierra degradada y otro que replantea cómo se cultiva el cacao, para responder una pregunta difícil: ¿qué métodos recuperan más biodiversidad por cada dólar invertido? BioChoco mide la respuesta.",
    objectives: [
      {
        num: "01",
        title: "Seguir los resultados de conservación",
        body: "Seguir en tiempo real los resultados de conservación de las intervenciones de construcción de corredores y restauración de FCAT, para ver qué recupera la biodiversidad a medida que sucede.",
      },
      {
        num: "02",
        title: "Entender el cambio de uso del suelo",
        body: "Medir cómo responden la biodiversidad y los ecosistemas al cambio de uso del suelo a lo largo del gradiente, desde el bosque primario, pasando por la agroforestería de cacao, hasta el pastizal abierto.",
      },
      {
        num: "03",
        title: "Evaluar especies prioritarias",
        body: "Proveer evaluaciones de uso de hábitat científicamente rigurosas para las especies amenazadas y paraguas del Chocó, en aves, mamíferos, ranas e insectos.",
      },
      {
        num: "04",
        title: "Elevar el Chocó a escala global",
        body: "Aumentar la conciencia y la participación global en torno a este bosque poco estudiado mediante una plataforma de datos abierta y en tiempo real.",
      },
    ],
    peopleHeading: "Parte de un programa de conservación integral",
    people:
      "Cuatro FCATero/as, biólogos de campo locales, llevan el monitoreo en el campo, trabajando con alrededor de 50 agricultores que albergan estaciones en sus tierras. El monitoreo es una parte de un programa de conservación más amplio y liderado por la comunidad: FCAT trabaja aquí desde 2003, emplea a dos docenas de residentes locales, y combina la investigación de campo con educación y desarrollo de capacidades. Ese modelo ha producido más de 50 artículos revisados por pares con coautores locales y reconocimientos como el Premio Whitley para la Naturaleza.",
  },

  methods: {
    heading: "Cómo funciona cada estación",
    intro:
      "Cada estación se construye alrededor de una coordenada GPS y un conjunto de sensores automáticos, de modo que una sola visita captura animales, sonido, clima y estructura del bosque en conjunto.",
    cards: [
      {
        title: "Cámara activada por movimiento",
        model: "Cámara trampa · modo foto",
        body: "Funciona al menos 30 días por instalación. Las fotos pasan por MegaDetector para encontrar animales, y luego por un clasificador de especies afinado para el Chocó (un modelo BioCLIP entrenado con nuestras propias imágenes verificadas). Un biólogo revisa y corrige cada identificación.",
      },
      {
        title: "Grabadora acústica pasiva",
        model: "Song Meter Micro 2 · 48 kHz",
        body: "Graba un minuto de cada diez, durante todo el día. Las grabaciones pasan por BirdNET para la identificación de aves.",
      },
      {
        title: "Registrador de microclima",
        model: "iButton Thermochron",
        body: "Registra la temperatura a intervalos fijos durante toda la instalación, dando un registro emparejado del microclima que experimentó cada cámara y grabadora.",
      },
      {
        title: "Estructura del hábitat",
        model: "Muestreo de campo · sobrevuelo con dron",
        body: "En la primera visita el equipo mide la cobertura del dosel, el tamaño y densidad de los árboles, y la cobertura boscosa alrededor de cada estación, y luego vincula la estructura con lo que detectan los sensores.",
      },
    ],
    habitatHead: {
      title: "Siete tipos de hábitat a lo largo de un gradiente de uso del suelo",
      body: "Las estaciones se distribuyen por todo el gradiente, desde bosque no perturbado hasta pastizal abierto, con los tres sistemas principales de cacao muestreados por separado. Las fotos provienen de los muestreos de hábitat del equipo de campo.",
    },
    sitesSampledOne: "sitio muestreado",
    sitesSampledMany: "sitios muestreados",
  },

  stats: {
    eyebrow: "La primera temporada de campo",
    heading: "Dónde se encuentra la red hoy",
    spanLine: "Cada número aquí proviene directamente del portal de datos de FCAT, cubriendo {span}.",
    tiles: [
      { label: "instalaciones de monitoreo", sub: "{cam} cámara · {audio} audio · {climate} clima" },
      { label: "días-cámara-trampa", sub: "{span}" },
      { label: "fotos de cámara trampa", sub: "recolectadas en el campo" },
      { label: "identificaciones revisadas", sub: "verificadas o corregidas por el equipo" },
      { label: "especies en cámara", sub: "{mammals} mamíferos · {birds} aves" },
      { label: "grabaciones de audio", sub: "{tb} TB de sonido" },
      { label: "registros de microclima", sub: "{loggers} registradores de temperatura" },
    ],
    note: "Se han establecido {deploymentCount} instalaciones de sensores en esta temporada de campo; las {retrievedCount} mostradas arriba han completado su ciclo y han sido recogidas, y alrededor de {inField} siguen recolectando datos en el campo. Como los sensores funcionan en un calendario rotativo, estos totales siguen creciendo — los conteos de cámara, audio y microclima de arriba reflejan los datos recogidos y procesados hasta ahora.",
  },

  map: {
    heading: "Dónde estamos trabajando",
    note: "Cada punto es una instalación de monitoreo, coloreada por tipo de hábitat. Desplázate y haz zoom para explorar; la línea discontinua marca el límite de la reserva de FCAT.",
    legendTitle: "Hábitat",
  },

  species: {
    heading: "Quién está apareciendo",
    intro:
      "Las identificaciones de cámara son verificadas o corregidas por biólogos de FCAT. Las detecciones de aves provienen del análisis automático de BirdNET, filtradas a una confianza de 0.8 o superior.",
    onCamera: "En cámara",
    bySound: "Por sonido",
    camCap: "{n} especies identificadas hasta ahora. Las especies silvestres más detectadas:",
    audCap: "Aves más detectadas en {n} grabaciones:",
    audNote:
      "Con una confianza de 0.8 o superior, BirdNET ha marcado cantos que coinciden con más de {n} especies candidatas de aves. Estas detecciones automáticas aún esperan revisión experta, así que trata la lista más amplia como un punto de partida y no como un conteo confirmado de especies.",
  },

  bonus: {
    heading: "Desde el campo",
    photosHeading: "Fotografías de cámara trampa",
    audioHeading: "Grabaciones de campo",
  },

  platform: {
    heading: "Una plataforma abierta para toda la red",
    intro:
      "FCAT está construyendo un laboratorio viviente virtual: un único portal que trae archivos crudos desde Google Drive, ejecuta detección con IA y nuestro clasificador BioCLIP afinado, permite a los biólogos verificar resultados, y los publica como datos abiertos en el estándar Camtrap DP para GBIF y el Environmental Data Initiative. El mismo sistema gestiona el calendario de campo, los registros de microclima, y el entrenamiento del propio clasificador. El objetivo es compartir lo que capturan los sensores, imágenes, sonido, clima y biodiversidad, como datos abiertos para la comunidad investigadora en general.",
    gallery: [
      {
        file: "results-by-site.jpg",
        addr: "FCAT Portal · Resultados por sitio",
        title: "Resultados por sitio",
        caption:
          "Cada instalación en un mapa coloreado por hábitat, con la preparación de cámara, temperatura y audio registrada por sitio.",
      },
      {
        file: "occupancy.jpg",
        addr: "FCAT Portal · Ocupación",
        title: "Modelamiento de ocupación en vivo",
        caption:
          "Modelos de ocupación de una y varias especies que se reajustan automáticamente a medida que llegan nuevas detecciones de cámara y audio, presentados como mapas de ocurrencia predicha.",
      },
      {
        file: "species-classifier.jpg",
        addr: "FCAT Portal · Clasificador de especies",
        title: "Clasificador de especies propio",
        caption:
          "Un modelo BioCLIP afinado integrado en el flujo de anotación de cámara trampa, versionado y evaluado por especie frente a modelos anteriores.",
      },
      {
        file: "microclimate.jpg",
        addr: "FCAT Portal · Microclima",
        title: "Registros de microclima",
        caption:
          "La serie de temperatura de cada registrador iButton, su ventana de instalación y cobertura, por sitio.",
      },
    ],
  },

  collaborate: {
    heading: "Dónde entran los colaboradores",
    intro:
      "La red está diseñada como una base compartida. Los sensores funcionan, los datos llegan a un portal abierto, y queremos que los investigadores construyan sobre ellos.",
    oppListTitle: "Oportunidades de colaboración",
    oppList: [
      {
        title: "Modelamiento de ocupación y comunidades",
        body: "Las visitas repetidas a lo largo del gradiente de uso del suelo permiten trabajos de ocupación de una y múltiples especies y de diversidad en aves, mamíferos, ranas e insectos, a partir de registros de especies de cámara trampa verificados —fechas, coordenadas e imágenes— en el estándar Camtrap DP y publicados en GBIF y el Environmental Data Initiative.",
      },
      {
        title: "Bioacústica",
        body: "Un amplio archivo acústico —grabaciones continuas de día y de noche con resultados de BirdNET— para análisis a nivel de comunidad y de especie, con conteos por puntos de experto realizados por el ornitólogo Juan Freile para validación en campo.",
      },
      {
        title: "Aprendizaje automático y visión por computadora",
        body: "Un conjunto de datos etiquetado y en crecimiento para entrenar clasificadores y evaluar detección, construyendo sobre nuestro BioCLIP afinado y MegaDetector.",
      },
      {
        title: "Carbono, hábitat y ecología de la restauración",
        body: "Datos de estructura del bosque —emparejados con series de temperatura y microclima por estación— vinculados a dos experimentos activos de restauración y agroforestería.",
      },
      {
        title: "Investigación socio-ecológica",
        body: "Trabajo en la interfaz entre el ser humano y el ambiente, junto a la investigación comunitaria y de uso del suelo de FCAT.",
      },
    ],
    network:
      "Esto se construye sobre una red ya establecida. FCAT trabaja con científicos de la computación y ecólogos de la Universidad de Tulane, investigadores de la Universidad San Francisco de Quito, el Cornell Lab of Ornithology, y la Alianza del Chocó de doce miembros, de modo que los colaboradores se conectan a un esfuerzo activo y bien vinculado.",
    ctaHeading: "Construyamos sobre esto juntos",
    ctaBody:
      "Si tu investigación podría usar datos de cámara trampa, acústicos o de microclima de un paisaje boscoso del Chocó, o quieres co-diseñar un estudio en torno a la red, nos gustaría conversar.",
    contactsHeading: "Ponte en contacto",
  },

  contacts: [
    { name: "Luke Browne", role: "Líder de monitoreo", email: "lukebrowne@fcat-ecuador.org" },
    { name: "Luis Carrasco", role: "Director de la Reserva FCAT", email: "luiscarrasco@fcat-ecuador.org" },
    { name: "Jordan Karubian", role: "Cofundador de FCAT", email: "jordankarubian@fcat-ecuador.org" },
  ],

  footer: {
    org: "Fundación para la Conservación de los Andes Tropicales",
    tagline: "Red de monitoreo de biodiversidad BioChoco · Chocó, Ecuador",
    date: "Datos actualizados al {date}",
  },

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
export const DEFAULT_LANG: Lang = "en";
