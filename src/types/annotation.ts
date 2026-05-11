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
  /** Optional modality-specific header subtitle on the detection card.
   *  Takes precedence over the camera-trap class label when present.
   *  Audio uses this to show the time/freq range, e.g. `0.5s–2.3s · 1.2–8.0 kHz`. */
  subtitle?: string | null;
  identification: AnnotationIdentification | null;
}
