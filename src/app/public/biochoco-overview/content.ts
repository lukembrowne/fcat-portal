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
  /** Optional — field-team members are listed without a contact email. */
  email?: string;
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

export interface AckEntry {
  name: string;
  /** Optional sub-line — award number, kind of support, etc. */
  note?: string;
}

export interface AckGroup {
  title: string;
  /** Optional line framing what this group's support is. */
  body?: string;
  entries: AckEntry[];
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
    /** Rendered one `<p>` per entry, in order. Last entry leads into `objectives`. */
    intro: string[];
    objectives: { num: string; title: string; body: string }[]; // 4
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
  };

  bonus: {
    heading: string;
    photosHeading: string;
    audioHeading: string;
  };

  platform: {
    heading: string;
    intro: string;
    gallery: GalleryShot[]; // 5
    bulletsTitle: string;
    bullets: string[];
  };

  collaborate: {
    heading: string;
    intro: string;
    oppListTitle: string;
    oppList: TitledBody[]; // 7
    ctaHeading: string;
    ctaBody: string;
    contactsHeading: string;
  };

  contacts: Contact[]; // 10 (7 field-team members + 3 emailed contacts)

  acknowledgements: {
    heading: string;
    /**
     * Order is load-bearing: [0] funders, [1] institutional support. MAATE
     * supports and permits this work but does not fund it, so it must never
     * sit in the funders group — the unit test asserts that split.
     */
    groups: AckGroup[]; // 2
  };

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
    intro: [
      "The Chocó is one of the most biodiverse rainforests on Earth, and more than 95% of its original forest is already gone. What remains is a mosaic of forest, cacao farms, and pasture. How does biodiversity respond to these shifts in land use? How can we design conservation interventions to maximize benefits for local communities and biodiversity? FCAT is working to answer these questions.",
      "BioChocó is one part of a broader, community-led conservation and research program led by FCAT since 2003, employing two dozen local residents, pairing field research with education and capacity building, and protecting >750 ha and ~50 endangered species with a multi-use field station that receives hundreds of visitors per year. Our approach has produced more than 50 peer-reviewed scientific papers with local coauthors and awards including the Whitley Prize for Nature. BioChocó is run by four local field biologists — known as FCATero/as — and works with 50 local farmers who host monitoring stations on their land.",
      "Our main objectives are to:",
    ],
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
        title: "Elevate the Chocó locally & globally",
        body: "Raise local & global awareness of and engagement with this understudied rainforest through personalized farmer-reports and an open, real-time data platform.",
      },
    ],
  },

  methods: {
    heading: "How each biodiversity monitoring station works",
    intro:
      "Every biodiversity monitoring station within the Biochocó network is built around a stack of automated sensors paired with field observations, so a single visit captures multiple aspects of biodiversity, local microclimate, and forest structure together.",
    cards: [
      {
        title: "Motion-activated camera",
        model: "Trail camera · photo mode",
        body: "Runs at least 30 days per deployment. We pass photos through a custom species classifier we fine-tuned for the Chocó and each image is reviewed and verified.",
      },
      {
        title: "Passive acoustic recorder",
        model: "Song Meter Micro 2 · 48 kHz",
        body: "Records soundscapes to capture calls and songs from birds, mammals, frogs, and insects, recording one minute in every ten.",
      },
      {
        title: "Microclimate logger",
        model: "iButton Thermochron",
        body: "Logs temperature at 30 minute intervals through the deployment, giving a paired record of the microclimate each camera and recorder experienced.",
      },
      {
        title: "Habitat structure",
        model: "Field survey · drone overflight",
        body: "The field team measures canopy cover, tree size and density, and forest cover around each station, then links structure to what the sensors detect.",
      },
    ],
    habitatHead: {
      title: "What types of habitats are we monitoring?",
      body: "Monitoring stations are spread across the full gradient of land use types in the region, from primary and regenerating forest to open pasture, along with three cacao farming systems.",
    },
    sitesSampledOne: "site sampled",
    sitesSampledMany: "sites sampled",
  },

  stats: {
    eyebrow: "",
    heading: "Where the network stands today",
    spanLine: "",
    tiles: [
      { label: "monitoring deployments", sub: "{cam} camera · {audio} audio · {climate} climate" },
      { label: "camera-trap days", sub: "{span}" },
      { label: "camera-trap photos", sub: "collected in the field" },
      { label: "animal detections", sub: "animals found in photos" },
      { label: "species on camera", sub: "{mammals} mammals · {birds} birds" },
      { label: "audio recordings", sub: "{tb} TB of sound" },
      { label: "bird detections by sound", sub: "BirdNET at ≥{conf} confidence" },
      { label: "microclimate readings", sub: "{loggers} temperature loggers" },
    ],
    note: "",
  },

  map: {
    heading: "Where we are working",
    note: "On the map below, each point is a monitoring site, colored by habitat type, spanning a network of ~50 local farms. Pan and zoom to explore; the dashed line marks the FCAT reserve boundary.",
    legendTitle: "Habitat",
  },

  species: {
    heading: "Species detections",
    intro:
      "Camera identifications are verified or corrected by FCAT biologists. Bird detections come from automated BirdNET analysis, filtered to a confidence of 0.8 or higher.",
    onCamera: "On camera",
    bySound: "By sound",
    camCap: "{n} species identified so far. The most-detected wild species:",
    audCap: "Most-detected birds across {n} recordings:",
  },

  bonus: {
    heading: "From the field",
    photosHeading: "Camera-trap photographs",
    audioHeading: "Field recordings",
  },

  platform: {
    heading: "An integrated end-to-end platform",
    intro:
      "FCAT has built an end-to-end platform that integrates raw sensor files into verified biodiversity data to share with local residents and the broader public. Camera traps, passive audio recorders, and microclimate loggers all feed a single pipeline, where our custom camera trap species classifier and BirdNET propose identifications, biologists verify the results, and species habitat use models refit as new data is processed. The data flows both back to the landowners hosting the sensors through their own personalized site pages and also to the global research and conservation community via standardized data outputs (e.g., Camtrap DP).",
    gallery: [
      {
        file: "species-classifier.jpg",
        addr: "FCAT Portal · Clasificador de especies",
        title: "Custom species classifier",
        caption:
          "A fine-tuned BioCLIP model for the species of the Chocó is built into a custom camera-trap annotation pipeline to review and correct identifications.",
      },
      {
        file: "bioacoustics.jpg",
        addr: "FCAT Portal · Audio",
        title: "Bioacoustics with BirdNET",
        caption:
          "Continuous day-and-night recordings run through BirdNET, with an interactive spectrogram for verifying species identifications.",
      },
      {
        file: "occupancy.jpg",
        addr: "FCAT Portal · Ocupación",
        title: "Live habitat use modeling",
        caption:
          "Single-species occupancy models that refit automatically as new camera and audio detections arrive, rendered as predicted-occurrence maps.",
      },
      {
        file: "landowner-pages.jpg",
        addr: "FCAT Portal · Fichas por sitio",
        title: "Personalized landowner pages",
        caption:
          "Each participating landowner gets their own page that includes species recorded on their land and information about species' ecological role management.",
      },
    ],
    bulletsTitle: "Also in the platform",
    bullets: [
      "Open-data export in the Camtrap DP standard, published to GBIF and the Environmental Data Initiative.",
      "Per-station microclimate records from iButton loggers — temperature series, deployment window, and coverage.",
      "A field schedule that tracks every sensor installation and retrieval across the network."
    ],
  },

  collaborate: {
    heading: "Where collaborators come in",
    intro:
      "We designed the BioChocó network as a shared foundation for researchers. FCAT collaborates with computer scientists and ecologists at Tulane University, researchers at Universidad San Francisco de Quito, Virginia Tech University, University of Hawaii, the Cornell Lab of Ornithology, among many others, so collaborators plug into an active, well-connected effort.",
    oppListTitle: "Opportunities for collaboration",
    oppList: [
      {
        title: "Occupancy and community modeling",
        body: "Repeated visits across the land-use gradient support single- and multi-species occupancy and biodiversity studies on birds, mammals, frogs, and insects, drawing on verified species records from camera traps and passive audio recorders.",
      },
      {
        title: "Restoration and corridor outcomes over time",
        body: "FCAT is building a biodiversity corridor and running two large-scale restoration and agroforestry projects now, with monitoring stations already in the ground. Collaborators get a before-and-after record with the land-use gradient as built-in reference sites, which supports work on how quickly animal communities recover and whether a new corridor promotes the movement it was designed for.",
      },
      {
        title: "Machine learning across images and audio",
        body: "A labeled, growing image dataset for classifier training and detection benchmarks, built on our fine-tuned BioCLIP and MegaDetector, plus terabytes of day-and-night audio recordings.",
      },
      {
        title: "Agroforestry and sustainable farm design",
        body: "Monitoring stations sit on roughly 50 working farms, spanning three cacao management systems alongside forest and pasture. That setup can show which agricultural practices promote biodiversity on the farm while still being profitable: shade tree composition, canopy structure, patch size, distance to remaining forest.",
      },
      {
        title: "Microclimate and thermal ecology",
        body: "Every station logs temperature every 30 minutes for the length of its deployment, alongside its own camera, audio, and forest-structure record. That pairing supports work on how much heat cacao shade and forest canopy buffer compared to open pasture, and where thermal refugia sit for frogs and insects as the Chocó warms.",
      },
      {
        title: "People and land-use decisions",
        body: "Roughly 50 landowners host stations and receive a personalized page showing what lives on their land. What practices can help promote and incentivize biodiversity-friendly land-use decisions?",
      },
      {
        title: "Additional taxa or sensors!",
        body: "We've built the network of 50 farms with landowner agreements in place, and a resident field team that visits every station on a schedule. Collaborators can add a method to sites that already run, whether that is eDNA sampling, bat detectors, arthropod traps, or vegetation plots, and build on the paired camera, audio, microclimate, and structure data at each one.",
      },
    ],
    ctaHeading: "Get in touch!",
    ctaBody:
      "If your research could use camera-trap, acoustic, or microclimate data from a Chocó forest landscape, or you want to co-design a study around the network, please reach out.",
    contactsHeading: "Get in touch",
  },

  contacts: [
    { name: "Luke Browne", role: "Monitoring lead", email: "lukebrowne@fcat-ecuador.org" },
    { name: "Luis Carrasco", role: "FCAT Reserve Director", email: "luiscarrasco@fcat-ecuador.org" },
    { name: "Jordan Karubian", role: "FCAT co-founder", email: "jordankarubian@fcat-ecuador.org" },
    { name: "Melissa Loayza", role: "Program Director", email: "melissaloayza@fcat-ecuador.org" },
    { name: "Karla Zambrano", role: "Field Coordinator" },
    { name: "Luis Zambrano", role: "Field Coordinator" },
    { name: "Gregory Paladines", role: "Local biologist (FCATero)" },
    { name: "Gloria Loor", role: "Local biologist (FCATera)" },
    { name: "Julio Loor", role: "Local biologist (FCATero)" },
    { name: "Darwin Zambrano", role: "Local biologist (FCATero)" },
  ],

  acknowledgements: {
    heading: "Funders and acknowledgements",
    groups: [
      {
        title: "Funders",
        body: "Support for the BioChocó monitoring network comes from:",
        entries: [
          { name: "Wedgetail Foundation" },
          { name: "National Science Foundation" },
          { name: "Private donors" },
        ],
      },
      {
        title: "Institutional support",
        entries: [
          {
            name: "Ministry of the Environment, Water and Ecological Transition (MAATE)",
            note: "Research permitting and institutional support",
          },
        ],
      },
    ],
  },

  footer: {
    org: "Fundación para la Conservación de los Andes Tropicales",
    tagline: "BioChocó biodiversity monitoring network · Chocó, Ecuador",
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
    eyebrow: "",
    title: "BioChocó",
    sub: "Una red integrada de monitoreo de biodiversidad a lo largo de un paisaje de bosque a finca en el Chocó del occidente de Ecuador.",
    liveDate: "Datos al {date}",
    metaSensors: "Cámaras trampa · acústica pasiva · hábitat · especies amenazadas",
  },

  learn: {
    heading: "Objetivos",
    intro: [
      "El Chocó es uno de los bosques lluviosos más biodiversos de la Tierra, y más del 95% de su bosque original ya se ha perdido. Lo que queda es un mosaico de bosque, fincas de cacao y pastizal. ¿Cómo responde la biodiversidad a estos cambios en el uso del suelo? ¿Cómo podemos diseñar intervenciones de conservación que maximicen los beneficios para las comunidades locales y la biodiversidad? FCAT trabaja para responder estas preguntas.",
      "BioChocó es una parte de un programa de conservación e investigación más amplio y liderado por la comunidad: FCAT trabaja aquí desde 2003, emplea a dos docenas de residentes locales, combina la investigación de campo con educación y desarrollo de capacidades, y protege más de 750 ha y ~50 especies amenazadas con una estación de campo de uso múltiple que recibe cientos de visitantes al año. Ese enfoque ha producido más de 50 artículos revisados por pares con coautores locales y reconocimientos como el Premio Whitley para la Naturaleza. BioChocó lo llevan cuatro biólogos de campo locales —conocidos como FCATero/as— y trabaja con 50 agricultores locales que albergan estaciones de monitoreo en sus tierras.",
      "Nuestros objetivos principales son:",
    ],
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
        body: "Proveer evaluaciones de uso de hábitat científicamente rigurosas para las especies amenazadas y clave del Chocó, en aves, mamíferos, ranas e insectos.",
      },
      {
        num: "04",
        title: "Elevar el Chocó a escala local y global",
        body: "Aumentar la conciencia y la participación local y global en torno a este bosque poco estudiado mediante informes personalizados para los agricultores y una plataforma de datos abierta y en tiempo real.",
      },
    ],
  },

  methods: {
    heading: "Cómo funciona cada estación de monitoreo de biodiversidad",
    intro:
      "Cada estación de monitoreo de biodiversidad dentro de la red BioChocó se construye alrededor de un conjunto de sensores automáticos combinados con observaciones de campo, de modo que una sola visita captura en conjunto múltiples aspectos de la biodiversidad, el microclima local y la estructura del bosque.",
    cards: [
      {
        title: "Cámara activada por movimiento",
        model: "Cámara trampa · modo foto",
        body: "Funciona al menos 30 días por instalación. Pasamos las fotos por un clasificador de especies propio, afinado para el Chocó, y cada imagen es revisada y verificada.",
      },
      {
        title: "Grabadora acústica pasiva",
        model: "Song Meter Micro 2 · 48 kHz",
        body: "Graba paisajes sonoros para capturar cantos y llamados de aves, mamíferos, ranas e insectos, grabando un minuto de cada diez.",
      },
      {
        title: "Registrador de microclima",
        model: "iButton Thermochron",
        body: "Registra la temperatura a intervalos de 30 minutos durante toda la instalación, dando un registro emparejado del microclima que experimentó cada cámara y grabadora.",
      },
      {
        title: "Estructura del hábitat",
        model: "Muestreo de campo · sobrevuelo con dron",
        body: "El equipo de campo mide la cobertura del dosel, el tamaño y densidad de los árboles, y la cobertura boscosa alrededor de cada estación, y luego vincula la estructura con lo que detectan los sensores.",
      },
    ],
    habitatHead: {
      title: "¿Qué tipos de hábitat estamos monitoreando?",
      body: "Las estaciones de monitoreo se distribuyen por todo el gradiente de tipos de uso del suelo de la región, desde bosque primario y en regeneración hasta pastizal abierto, junto con tres sistemas de cultivo de cacao.",
    },
    sitesSampledOne: "sitio muestreado",
    sitesSampledMany: "sitios muestreados",
  },

  stats: {
    eyebrow: "",
    heading: "Dónde se encuentra la red hoy",
    spanLine: "",
    tiles: [
      { label: "instalaciones de monitoreo", sub: "{cam} cámara · {audio} audio · {climate} clima" },
      { label: "días-cámara-trampa", sub: "{span}" },
      { label: "fotos de cámara trampa", sub: "recolectadas en el campo" },
      { label: "detecciones de animales", sub: "animales encontrados en las fotos" },
      { label: "especies en cámara", sub: "{mammals} mamíferos · {birds} aves" },
      { label: "grabaciones de audio", sub: "{tb} TB de sonido" },
      { label: "detecciones de aves por sonido", sub: "BirdNET con confianza ≥{conf}" },
      { label: "registros de microclima", sub: "{loggers} registradores de temperatura" },
    ],
    note: "",
  },

  map: {
    heading: "Dónde estamos trabajando",
    note: "En el mapa de abajo, cada punto es un sitio de monitoreo, coloreado por tipo de hábitat, abarcando una red de ~50 fincas locales. Desplázate y haz zoom para explorar; la línea discontinua marca el límite de la reserva de FCAT.",
    legendTitle: "Hábitat",
  },

  species: {
    heading: "Detecciones de especies",
    intro:
      "Las identificaciones de cámara son verificadas o corregidas por biólogos de FCAT. Las detecciones de aves provienen del análisis automático de BirdNET, filtradas a una confianza de 0.8 o superior.",
    onCamera: "En cámara",
    bySound: "Por sonido",
    camCap: "{n} especies identificadas hasta ahora. Las especies silvestres más detectadas:",
    audCap: "Aves más detectadas en {n} grabaciones:",
  },

  bonus: {
    heading: "Desde el campo",
    photosHeading: "Fotografías de cámara trampa",
    audioHeading: "Grabaciones de campo",
  },

  platform: {
    heading: "Una plataforma integrada de extremo a extremo",
    intro:
      "FCAT ha construido una plataforma de extremo a extremo que integra los archivos crudos de los sensores en datos de biodiversidad verificados para compartir con los residentes locales y el público en general. Las cámaras trampa, las grabadoras de audio pasivas y los registradores de microclima alimentan un único flujo, donde nuestro clasificador propio de especies de cámara trampa y BirdNET proponen identificaciones, los biólogos verifican los resultados, y los modelos de uso de hábitat de las especies se reajustan a medida que se procesan nuevos datos. Los datos fluyen tanto de vuelta a los propietarios que albergan los sensores, a través de sus propias páginas personalizadas por sitio, como hacia la comunidad global de investigación y conservación mediante salidas de datos estandarizadas (por ejemplo, Camtrap DP).",
    gallery: [
      {
        file: "species-classifier.jpg",
        addr: "FCAT Portal · Clasificador de especies",
        title: "Clasificador de especies propio",
        caption:
          "Un modelo BioCLIP afinado para las especies del Chocó está integrado en un flujo propio de anotación de cámara trampa para revisar y corregir identificaciones.",
      },
      {
        file: "bioacoustics.jpg",
        addr: "FCAT Portal · Audio",
        title: "Bioacústica con BirdNET",
        caption:
          "Grabaciones continuas de día y de noche procesadas con BirdNET, con un espectrograma interactivo para verificar identificaciones de especies.",
      },
      {
        file: "occupancy.jpg",
        addr: "FCAT Portal · Ocupación",
        title: "Modelamiento de uso de hábitat en vivo",
        caption:
          "Modelos de ocupación de una sola especie que se reajustan automáticamente a medida que llegan nuevas detecciones de cámara y audio, presentados como mapas de ocurrencia predicha.",
      },
      {
        file: "landowner-pages.jpg",
        addr: "FCAT Portal · Fichas por sitio",
        title: "Páginas personalizadas para propietarios",
        caption:
          "Cada propietario participante recibe su propia página, que incluye las especies registradas en su terreno e información sobre el papel ecológico de las especies y su manejo.",
      },
    ],
    bulletsTitle: "También en la plataforma",
    bullets: [
      "Exportación de datos abiertos en el estándar Camtrap DP, publicados en GBIF y el Environmental Data Initiative.",
      "Registros de microclima por estación desde registradores iButton: serie de temperatura, ventana de instalación y cobertura.",
      "Un calendario de campo que rastrea cada instalación y retiro de sensores en toda la red.",
    ],
  },

  collaborate: {
    heading: "Dónde entran los colaboradores",
    intro:
      "Diseñamos la red BioChocó como una base compartida para investigadores. FCAT trabaja con científicos de la computación y ecólogos de la Universidad de Tulane, investigadores de la Universidad San Francisco de Quito, Virginia Tech University, la Universidad de Hawái y el Cornell Lab of Ornithology, entre muchos otros, de modo que los colaboradores se conectan a un esfuerzo activo y bien vinculado.",
    oppListTitle: "Oportunidades de colaboración",
    oppList: [
      {
        title: "Modelamiento de ocupación y comunidades",
        body: "Las visitas repetidas a lo largo del gradiente de uso del suelo permiten trabajos de ocupación de una y múltiples especies y de diversidad en aves, mamíferos, ranas e insectos, a partir de registros verificados de especies provenientes de cámaras trampa y grabadoras de audio pasivas.",
      },
      {
        title: "Resultados de la restauración y los corredores a lo largo del tiempo",
        body: "FCAT está construyendo un corredor de biodiversidad y ejecutando dos proyectos de restauración y agroforestería a gran escala, con estaciones de monitoreo ya instaladas en el terreno. Los colaboradores obtienen un registro de antes y después, con el gradiente de uso del suelo como sitios de referencia incorporados, lo que permite estudiar qué tan rápido se recuperan las comunidades animales y si un corredor nuevo promueve el movimiento para el que fue diseñado.",
      },
      {
        title: "Aprendizaje automático con imágenes y audio",
        body: "Un conjunto de imágenes etiquetado y en crecimiento para entrenar clasificadores y evaluar detección, construido sobre nuestro BioCLIP afinado y MegaDetector, además de terabytes de grabaciones de audio de día y de noche.",
      },
      {
        title: "Agroforestería y diseño de fincas sostenibles",
        body: "Las estaciones de monitoreo están ubicadas en unas 50 fincas en producción, que abarcan tres sistemas de manejo de cacao junto con bosque y pastizal. Ese diseño permite identificar qué prácticas agrícolas favorecen la biodiversidad en la finca sin dejar de ser rentables: composición de árboles de sombra, estructura del dosel, tamaño del parche y distancia al bosque remanente.",
      },
      {
        title: "Microclima y ecología térmica",
        body: "Cada estación registra la temperatura cada 30 minutos durante toda su instalación, junto con su propio registro de cámara, audio y estructura del bosque. Esa combinación permite estudiar cuánto calor amortiguan la sombra del cacao y el dosel del bosque frente al pastizal abierto, y dónde se ubican los refugios térmicos para ranas e insectos a medida que el Chocó se calienta.",
      },
      {
        title: "Personas y decisiones de uso del suelo",
        body: "Unos 50 propietarios albergan estaciones y reciben una página personalizada que muestra qué especies viven en sus tierras. ¿Qué prácticas pueden promover e incentivar decisiones de uso del suelo favorables a la biodiversidad?",
      },
      {
        title: "¡Taxones o sensores adicionales!",
        body: "Ya construimos la red de 50 fincas con acuerdos con los propietarios y un equipo de campo residente que visita cada estación de forma programada. Los colaboradores pueden sumar un nuevo método a sitios que ya están en funcionamiento, sea muestreo de ADN ambiental, detectores de murciélagos, trampas de artrópodos o parcelas de vegetación, y construir sobre los datos pareados de cámara, audio, microclima y estructura de cada uno.",
      },
    ],
    ctaHeading: "¡Ponte en contacto!",
    ctaBody:
      "Si tu investigación podría usar datos de cámara trampa, acústicos o de microclima de un paisaje boscoso del Chocó, o quieres co-diseñar un estudio en torno a la red, por favor escríbenos.",
    contactsHeading: "Ponte en contacto",
  },

  contacts: [
    { name: "Luke Browne", role: "Líder de monitoreo", email: "lukebrowne@fcat-ecuador.org" },
    { name: "Luis Carrasco", role: "Director de la Reserva FCAT", email: "luiscarrasco@fcat-ecuador.org" },
    { name: "Jordan Karubian", role: "Cofundador de FCAT", email: "jordankarubian@fcat-ecuador.org" },
    { name: "Melissa Loayza", role: "Directora de Programa", email: "melissaloayza@fcat-ecuador.org" },
    { name: "Karla Zambrano", role: "Coordinadora de Campo" },
    { name: "Luis Zambrano", role: "Coordinador de Campo" },
    { name: "Gregory Paladines", role: "Biólogo local (FCATero)" },
    { name: "Gloria Loor", role: "Bióloga local (FCATera)" },
    { name: "Julio Loor", role: "Biólogo local (FCATero)" },
    { name: "Darwin Zambrano", role: "Biólogo local (FCATero)" },
  ],

  acknowledgements: {
    heading: "Financiadores y agradecimientos",
    groups: [
      {
        title: "Financiadores",
        body: "El apoyo a la red de monitoreo BioChocó proviene de:",
        entries: [
          { name: "Wedgetail Foundation" },
          { name: "National Science Foundation" },
          { name: "Donantes privados" },
        ],
      },
      {
        title: "Apoyo institucional",
        entries: [
          {
            name: "Ministerio del Ambiente, Agua y Transición Ecológica (MAATE)",
            note: "Permisos de investigación y apoyo institucional",
          },
        ],
      },
    ],
  },

  footer: {
    org: "Fundación para la Conservación de los Andes Tropicales",
    tagline: "Red de monitoreo de biodiversidad BioChocó · Chocó, Ecuador",
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
