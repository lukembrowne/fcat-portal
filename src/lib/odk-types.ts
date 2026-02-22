// ============================================================
// GIZ Tree Planting (form: siembra_arboles, project: 2)
// ============================================================

export interface OdkGeoPoint {
  type: "Point";
  coordinates: [number, number, number]; // [lon, lat, elevation]
  properties?: { accuracy?: number };
}

/** Raw submission from ODK Central OData API — siembra_arboles */
export interface OdkTreeSubmission {
  __id: string;
  codigo_ficha: string | null;
  fecha_siembra: string | null;
  codigo_social: string | null;
  dueno: string | null;
  nombre_especie: string | null;
  altura_inicial: number | null;
  condicion_inicial: string | null;
  supervivencia: string | null;
  extensionista: string | null;
  notas: string | null;
  gps: OdkGeoPoint | null;
  foto_superior: string | null;
  foto_lateral: string | null;
  foto_hoja: string | null;
}

/** Cleaned tree record for the UI */
export interface TreeRecord {
  id: string;
  code: string;
  date: string | null;
  farm: string;
  owner: string;
  species: string;
  height: number | null;
  condition: string;
  survival: string;
  worker: string;
  notes: string;
  lat: number | null;
  lng: number | null;
  photoTop: string | null;
  photoSide: string | null;
  photoLeaf: string | null;
}

export interface TreeDashboardMetrics {
  totalTrees: number;
  uniqueSpecies: number;
  uniqueFarms: number;
  survivalRate: number;
}

export interface TreeFilterState {
  farm: string;
  species: string;
  extensionista: string;
  survival: string;
  dateFrom: string;
  dateTo: string;
}

// ============================================================
// GIZ Cacao Monitoring (form: monitoreo_cacao_v1, project: 2)
// ============================================================

/** Raw submission — monitoreo_cacao_v1. GPS is WKT POINT format. */
export interface OdkCacaoSubmission {
  __id: string;
  identificacion_codigo_finca: string | null;
  identificacion_nombre_propietario: string | null;
  identificacion_comunidad: string | null;
  identificacion_fecha_siembra: string | null;
  metadata_fecha_monitoreo: string | null;
  metadata_ubicacion: string | null; // WKT "POINT(lon lat elevation)"
  datos_plantas_num_plantas_sembradas: number | null;
  datos_plantas_num_plantas_vivas: number | null;
  datos_plantas_tasa_sobrevivencia: number | null;
  manejo_num_limpiezas: number | null;
  manejo_realizo_fertilizacion: string | null;
  observaciones_comentarios_propietario: string | null;
  observaciones_notas_monitor: string | null;
  num_plantas_muertas: number | null;
  dias_desde_siembra: number | null;
}

/** Cleaned cacao record for the UI */
export interface CacaoRecord {
  id: string;
  farmCode: string;
  ownerName: string;
  community: string;
  plantingDate: string | null;
  monitoringDate: string | null;
  lat: number | null;
  lng: number | null;
  plantsPlanted: number | null;
  plantsAlive: number | null;
  survivalRate: number | null;
  numCleanings: number | null;
  fertilized: string | null;
  ownerComments: string | null;
  monitorNotes: string | null;
  plantsDead: number | null;
  daysSincePlanting: number | null;
}

export interface CacaoMetrics {
  totalFarms: number;
  totalPlants: number;
  plantsAlive: number;
  avgSurvivalRate: number;
  communities: number;
}

export interface CacaoFilterState {
  community: string;
  farmCode: string;
  fertilized: string;
  survivalMin: number;
  survivalMax: number;
}

// ============================================================
// Monitoreo Programático — Social Activities
// (form: actividades_sociales_fcat, project: 11)
// ============================================================

/** Raw submission — actividades_sociales_fcat (flattened). */
export interface OdkSocialActivitySubmission {
  __id: string;
  fecha: string | null;
  tipo_evento: string | null;
  area_desarrollo: string | null;
  tema_evento: string | null;
  institucion_organizadora: string | null;
  nombre_capacitadores: string | null;
  lugar_evento: string | null;
  tipo_participantes: string | null;
  comunidades_instituciones: string | null;
  grupo_num_participantes_num_mujeres: number | null;
  grupo_num_participantes_num_hombres: number | null;
  grupo_num_participantes_num_ninos: number | null;
  grupo_num_participantes_num_adolescentes: number | null;
  grupo_num_participantes_num_otros_participantes: number | null;
  grupo_num_participantes_total_participantes: string | null;
  foto_lista_participantes: string | null;
  foto_registro_2: string | null;
  pdf_registro_participantes: string | null;
  grupo_fotos_evento_foto_evento_1: string | null;
  grupo_fotos_evento_foto_evento_2: string | null;
  grupo_fotos_evento_foto_evento_3: string | null;
  grupo_fotos_evento_foto_evento_4: string | null;
  proyecto_fcat: string | null;
  nombre_encuestador: string | null;
}

/** Cleaned social activity record for the UI */
export interface SocialActivityRecord {
  id: string;
  fecha: string | null;
  tipoEvento: string;
  tipoEventoLabel: string;
  areasDesarrollo: string[];
  areasDesarrolloLabels: string[];
  temaEvento: string;
  institucionOrganizadora: string;
  nombreCapacitadores: string;
  lugarEvento: string;
  lugarEventoLabel: string;
  tipoParticipantes: string[];
  tipoParticipantesLabels: string[];
  comunidadesInstituciones: string;
  numMujeres: number;
  numHombres: number;
  numNinos: number;
  numAdolescentes: number;
  numOtros: number;
  totalParticipantes: number;
  proyectosFcat: string[];
  proyectosFcatLabels: string[];
  nombreEncuestador: string;
  fotoListaParticipantes: string | null;
  fotoRegistro2: string | null;
  fotoEvento1: string | null;
  fotoEvento2: string | null;
  fotoEvento3: string | null;
  fotoEvento4: string | null;
  hasPhotos: boolean;
}

export interface SocialActivityMetrics {
  totalEventos: number;
  totalParticipantes: number;
  totalMujeres: number;
  porcentajeMujeres: number;
  comunidadesAlcanzadas: number;
  promedioParticipantes: number;
}

export interface SocialActivityFilterState {
  dateFrom: string;
  dateTo: string;
  tipoEvento: string[];
  areaDesarrollo: string[];
  proyectoFcat: string[];
  lugarEvento: string[];
}

// ============================================================
// BioChoco (project: 8)
// ============================================================

/** ODK entity from monitoring_sites entity list */
export interface OdkSiteEntity {
  uuid: string;
  label: string;
  site_id: string;
  site_name: string;
  habitat_type: string;
  latitude: string | null;
  longitude: string | null;
  [key: string]: unknown;
}

/** Raw deploy submission — instalar_sensores */
export interface OdkDeploySubmission {
  __id: string;
  deployment_id: string | null;
  site_id: string | null;
  fecha_instalacion: string | null;
  [key: string]: unknown;
}

/** Raw retrieve submission — retrieve_sensors */
export interface OdkRetrieveSubmission {
  __id: string;
  deployment_id: string | null;
  site_id: string | null;
  fecha_recuperacion: string | null;
  [key: string]: unknown;
}
