/**
 * Parse confusion_matrix.csv from the training pipeline.
 *
 * Format (sklearn convention, written by train.py):
 *
 *   ,classA,classB,classC
 *   classA,12,1,0
 *   classB,2,30,3
 *   classC,0,1,8
 *
 * - Header row leads with an empty cell, then N class labels in the same
 *   order as classListOrdered.
 * - Each subsequent row leads with the class label, then N integer counts.
 * - Matrix is square (N×N), row = true class, column = predicted class.
 * - Cells are non-negative integers (NaN/floats rejected).
 *
 * Uses csv-parse/sync (already a production dep) for BOM / CRLF / quoting
 * safety. Hand-rolled `split(',')` would silently corrupt on any of those.
 */

import { parse } from "csv-parse/sync";

import type { ImportError } from "./import-errors";

export interface ParsedConfusionMatrix {
  readonly classes: readonly string[];
  /** matrix[trueIdx][predictedIdx] */
  readonly matrix: ReadonlyArray<ReadonlyArray<number>>;
  /** Self-describing axis convention; serialized alongside the matrix. */
  readonly axisConvention: "row=true,col=pred";
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ImportError };

export function parseConfusionMatrixCsv(
  csvText: string,
  classListOrdered: readonly string[],
): ParseResult<ParsedConfusionMatrix> {
  const N = classListOrdered.length;

  let rows: string[][];
  try {
    rows = parse(csvText, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "invalid_json",
        file: "confusion_matrix.csv",
        detail: (err as Error).message,
      },
    };
  }

  if (rows.length !== N + 1) {
    return {
      ok: false,
      error: {
        kind: "confusion_matrix_shape",
        axis: "row",
        expected: N + 1,
        got: rows.length,
      },
    };
  }

  // Header row: leading empty cell + N class labels matching classListOrdered.
  const header = rows[0];
  if (header.length !== N + 1) {
    return {
      ok: false,
      error: {
        kind: "confusion_matrix_shape",
        axis: "col",
        expected: N + 1,
        got: header.length,
      },
    };
  }
  for (let j = 0; j < N; j++) {
    if (header[j + 1] !== classListOrdered[j]) {
      return {
        ok: false,
        error: {
          kind: "confusion_matrix_label",
          axis: "col",
          index: j,
          expected: classListOrdered[j],
          got: header[j + 1] ?? "",
        },
      };
    }
  }

  // Data rows.
  const matrix: number[][] = [];
  for (let i = 0; i < N; i++) {
    const row = rows[i + 1];
    if (row.length !== N + 1) {
      return {
        ok: false,
        error: {
          kind: "confusion_matrix_shape",
          axis: "col",
          expected: N + 1,
          got: row.length,
        },
      };
    }
    if (row[0] !== classListOrdered[i]) {
      return {
        ok: false,
        error: {
          kind: "confusion_matrix_label",
          axis: "row",
          index: i,
          expected: classListOrdered[i],
          got: row[0] ?? "",
        },
      };
    }
    const cells: number[] = [];
    for (let j = 0; j < N; j++) {
      const raw = row[j + 1];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        return {
          ok: false,
          error: { kind: "confusion_matrix_cell", row: i, col: j, raw },
        };
      }
      cells.push(v);
    }
    matrix.push(cells);
  }

  return {
    ok: true,
    value: {
      classes: classListOrdered.slice(),
      matrix,
      axisConvention: "row=true,col=pred",
    },
  };
}
