/**
 * Shared annotation domain types.
 *
 * Both camera-trap detections (image bbox) and audio detections (spectrogram
 * time/freq box) satisfy `AnnotationDetection`. Coordinate fields stay on each
 * modality's extended type; anything the shared chrome
 * (`AnnotationToolsSidebar`, `AnnotationPickerPopover`, `DetectionCardStrip`,
 * `useAnnotationPicker`) needs to read lives on this base.
 */

export interface AnnotationIdentification {
  id: number;
  species: string;
  correctedSpecies: string | null;
  /** ML confidence 0-1; null when manually created. */
  confidence: number | null;
  /** "unverified" | "verified" | "corrected" | "rejected" | "unclassified". */
  verificationStatus: string;
}

export interface AnnotationDetection {
  id: number;
  /** Camera-trap class index (0=Animal, 1=Persona, 2=Vehículo). Audio omits. */
  detectionClass?: number;
  /** ML bbox confidence 0-1. Null/undefined when manually created or unavailable. */
  detectionConfidence?: number | null;
  identification: AnnotationIdentification | null;
}
