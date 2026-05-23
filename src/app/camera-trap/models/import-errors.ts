/**
 * Discriminated error types for the model-import pipeline.
 *
 * Server-action returns `ActionResult<T>` (string error). Internal helpers
 * return `Result<T, ImportError>`. Tests assert on `kind`, not on Spanish copy.
 */

export type ImportError =
  | {
      kind: "invalid_dir_name";
      dirName: string;
    }
  | {
      kind: "missing_file";
      file:
        | "weights.pt"
        | "metrics.json"
        | "confusion_matrix.csv"
        | "class_mapping.json";
    }
  | {
      kind: "empty_file";
      file: string;
    }
  | {
      kind: "file_too_large";
      file: string;
      sizeBytes: number;
      maxBytes: number;
    }
  | {
      kind: "symlink_rejected";
      file: string;
    }
  | {
      kind: "invalid_json";
      file: string;
      detail: string;
    }
  | {
      kind: "contract_version_unsupported";
      got: string;
    }
  | {
      kind: "schema_violation";
      detail: string;
    }
  | {
      kind: "class_alignment_mismatch";
      index: number;
      classMapping: string;
      classListOrdered: string;
    }
  | {
      kind: "class_count_mismatch";
      classMappingCount: number;
      classListOrderedCount: number;
    }
  | {
      kind: "class_name_invalid";
      className: string;
    }
  | {
      kind: "duplicate_version";
      version: string;
    }
  | {
      kind: "unknown_training_dataset";
      contentHash: string;
    }
  | {
      kind: "confusion_matrix_shape";
      axis: "row" | "col";
      expected: number;
      got: number;
    }
  | {
      kind: "confusion_matrix_label";
      axis: "row" | "col";
      index: number;
      expected: string;
      got: string;
    }
  | {
      kind: "confusion_matrix_cell";
      row: number;
      col: number;
      raw: string;
    };

/** Spanish user-facing message for an ImportError. */
export function importErrorToSpanish(e: ImportError): string {
  switch (e.kind) {
    case "invalid_dir_name":
      return `Nombre de directorio inválido: "${e.dirName}".`;
    case "missing_file":
      return `Falta el archivo requerido: ${e.file}.`;
    case "empty_file":
      return `El archivo está vacío: ${e.file}.`;
    case "file_too_large":
      return `El archivo ${e.file} excede el tamaño máximo (${e.sizeBytes} > ${e.maxBytes} bytes).`;
    case "symlink_rejected":
      return `Enlaces simbólicos no permitidos: ${e.file}.`;
    case "invalid_json":
      return `${e.file} no es JSON válido: ${e.detail}.`;
    case "contract_version_unsupported":
      return `Contrato obsoleto (${e.got}). Re-exportá con versión v2.`;
    case "schema_violation":
      return `metrics.json no cumple el contrato v2: ${e.detail}.`;
    case "class_alignment_mismatch":
      return `Las clases no coinciden en el índice ${e.index}: class_mapping.json="${e.classMapping}" vs metrics.classListOrdered="${e.classListOrdered}".`;
    case "class_count_mismatch":
      return `class_mapping.json tiene ${e.classMappingCount} entradas, metrics.classListOrdered tiene ${e.classListOrderedCount}.`;
    case "class_name_invalid":
      return `Nombre de clase inválido: "${e.className}". Sólo letras, números, '_', '-', '.' o espacios.`;
    case "duplicate_version":
      return `Ya existe un modelo con la versión "${e.version}".`;
    case "unknown_training_dataset":
      return `trainingDatasetContentHash "${e.contentHash}" no coincide con ningún dataset registrado. Marcá "permitir dataset no registrado" para registrarlo de todos modos.`;
    case "confusion_matrix_shape":
      return `confusion_matrix.csv: dimensiones inesperadas (${e.axis} esperaba ${e.expected}, obtuvo ${e.got}).`;
    case "confusion_matrix_label":
      return `confusion_matrix.csv: etiqueta ${e.axis} ${e.index} no coincide (esperaba "${e.expected}", obtuvo "${e.got}").`;
    case "confusion_matrix_cell":
      return `confusion_matrix.csv: celda inválida en fila ${e.row}, columna ${e.col} ("${e.raw}").`;
  }
}
