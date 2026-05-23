import { describe, expect, it } from "vitest";

import { parseConfusionMatrixCsv } from "@/app/camera-trap/models/parse-confusion-matrix";

const classes = ["agouti", "paca", "tapir"];

function csv(lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("parseConfusionMatrixCsv", () => {
  it("parses a well-formed sklearn-convention matrix", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,12,1,0",
      "paca,2,30,3",
      "tapir,0,1,8",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.classes).toEqual(classes);
    expect(result.value.matrix).toEqual([
      [12, 1, 0],
      [2, 30, 3],
      [0, 1, 8],
    ]);
    expect(result.value.axisConvention).toBe("row=true,col=pred");
  });

  it("handles UTF-8 BOM transparently", () => {
    const text =
      "﻿" +
      csv([
        ",agouti,paca,tapir",
        "agouti,10,0,0",
        "paca,0,10,0",
        "tapir,0,0,10",
      ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(true);
  });

  it("handles CRLF line endings", () => {
    const text =
      ",agouti,paca,tapir\r\n" +
      "agouti,10,0,0\r\n" +
      "paca,0,10,0\r\n" +
      "tapir,0,0,10\r\n";
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.matrix[0][0]).toBe(10);
  });

  it("rejects non-square shape (wrong row count)", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,1,2,3",
      "paca,4,5,6",
      // missing tapir row
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("confusion_matrix_shape");
  });

  it("rejects non-square shape (wrong column count)", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,1,2,3,99", // extra column
      "paca,4,5,6",
      "tapir,7,8,9",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
  });

  it("rejects header-row label mismatch", () => {
    const text = csv([
      ",agouti,jaguar,tapir", // jaguar instead of paca
      "agouti,1,2,3",
      "paca,4,5,6",
      "tapir,7,8,9",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("confusion_matrix_label");
    if (result.error.kind !== "confusion_matrix_label") return;
    expect(result.error.axis).toBe("col");
    expect(result.error.index).toBe(1);
  });

  it("rejects row-label mismatch", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,1,2,3",
      "ocelot,4,5,6", // wrong row label
      "tapir,7,8,9",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("confusion_matrix_label");
  });

  it("rejects non-integer cell", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,1,2,3",
      "paca,4,5.5,6", // float
      "tapir,7,8,9",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("confusion_matrix_cell");
  });

  it("rejects negative cell", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,1,2,3",
      "paca,4,-1,6",
      "tapir,7,8,9",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("confusion_matrix_cell");
  });

  it("rejects malformed cell (not a number)", () => {
    const text = csv([
      ",agouti,paca,tapir",
      "agouti,1,2,3",
      "paca,4,oops,6",
      "tapir,7,8,9",
    ]);
    const result = parseConfusionMatrixCsv(text, classes);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("confusion_matrix_cell");
  });
});
