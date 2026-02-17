/**
 * Edge case tests for parseLibroMayor CSV parser.
 *
 * Tests error paths: empty files, missing columns, malformed rows,
 * invalid dates, deduplication, and encoding.
 */

import { describe, it, expect } from "vitest";
import { parseLibroMayor } from "@/app/finance/lib/parse-libro-mayor";

const VALID_HEADER = [
  "CUENTA CóDIGO",
  "CUENTA NOMBRE",
  "FECHA",
  "# ASIENTO",
  "COMPROBANTE",
  "USUARIO",
  "DETALLE",
  "DOC.",
  "C. COSTO",
  "CENTROS DE INGRESO",
  "IDENTIFICACION",
  "ACTOR",
  "DEBE",
  "HABER",
  "SALDO ACT",
].join("\t");

/** Encode a string as ISO-8859-1 ArrayBuffer (matching real file encoding) */
function encode(text: string): ArrayBuffer {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes.buffer as ArrayBuffer;
}

function makeRow(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    codigo: "5.1.1.1.01",
    nombre: "SUELDOS Y SALARIOS",
    fecha: "2025-06-15",
    asiento: "GAS-001",
    comprobante: "001",
    usuario: "admin",
    detalle: "Pago mensual",
    doc: "",
    ccosto: "FCAT",
    centros: "GENERAL",
    identificacion: "",
    actor: "Juan Perez",
    debe: "1500.00",
    haber: "0.00",
    saldo: "1500.00",
  };
  const d = { ...defaults, ...overrides };
  return [
    d.codigo, d.nombre, d.fecha, d.asiento, d.comprobante,
    d.usuario, d.detalle, d.doc, d.ccosto, d.centros,
    d.identificacion, d.actor, d.debe, d.haber, d.saldo,
  ].join("\t");
}

describe("parseLibroMayor", () => {
  it("parses a valid file with one row", () => {
    const content = VALID_HEADER + "\n" + makeRow();
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].codigo).toBe("5.1.1.1.01");
    expect(rows[0].debe).toBe(1500);
    expect(rows[0].haber).toBe(0);
    expect(rows[0].txType).toBe("expense");
  });

  it("returns error for empty file", () => {
    const { rows, errors } = parseLibroMayor(encode(""));
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("vacío");
  });

  it("returns error for header-only file", () => {
    const { rows, errors } = parseLibroMayor(encode(VALID_HEADER));
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("vacío");
  });

  it("returns error for missing required columns", () => {
    const badHeader = "COLUMN_A\tCOLUMN_B\tCOLUMN_C";
    const content = badHeader + "\n" + "a\tb\tc";
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Columnas faltantes");
  });

  it("reports invalid date format", () => {
    const content = VALID_HEADER + "\n" + makeRow({ fecha: "15/06/2025" });
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("formato de fecha inválido");
  });

  it("skips rows without a date (saldo inicial)", () => {
    const content = VALID_HEADER + "\n" + makeRow({ fecha: "" });
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(0); // not an error, just skipped
  });

  it("deduplicates identical rows", () => {
    const row = makeRow();
    const content = VALID_HEADER + "\n" + row + "\n" + row;
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1); // second row deduplicated
  });

  it("skips malformed rows with too few fields", () => {
    const shortRow = "5.1.1.1.01\tSUELDOS"; // only 2 fields
    const content = VALID_HEADER + "\n" + makeRow() + "\n" + shortRow;
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(rows).toHaveLength(1); // only the good row
  });

  it("handles zero numeric values", () => {
    const content = VALID_HEADER + "\n" + makeRow({ debe: "0", haber: "0", saldo: "0" });
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].debe).toBe(0);
    expect(rows[0].haber).toBe(0);
    expect(rows[0].balance).toBe(0);
  });

  it("handles comma-formatted numbers", () => {
    const content = VALID_HEADER + "\n" + makeRow({ debe: "1,500.50", haber: "0.00" });
    const { rows, errors } = parseLibroMayor(encode(content));
    expect(errors).toHaveLength(0);
    expect(rows[0].debe).toBe(1500.50);
  });

  it("classifies unknown account codes as 'other'", () => {
    const content = VALID_HEADER + "\n" + makeRow({ codigo: "9.9.9.9.99", asiento: "MISC-001" });
    const { rows } = parseLibroMayor(encode(content));
    expect(rows).toHaveLength(1);
    expect(rows[0].txType).toBe("other");
  });

  it("applies recategorization rules for specific actors", () => {
    const content = VALID_HEADER + "\n" + makeRow({
      nombre: "HONORARIOS PROFESIONALES",
      actor: "FREILE ORTIZ JUAN FERNANDO",
    });
    const { rows } = parseLibroMayor(encode(content));
    expect(rows[0].cuentaNombre).toBe("SERVICIOS PERSONALES CONSULTORIA");
  });

  it("skips the specific GASTOS NO DEDUCIBLES adjustment entry", () => {
    const content = VALID_HEADER + "\n" + makeRow({
      nombre: "GASTOS NO DEDUCIBLES",
      detalle: "Ajuste Cuentas provisiones gastos",
      asiento: "DG840627",
    });
    const { rows } = parseLibroMayor(encode(content));
    expect(rows).toHaveLength(0); // should be filtered out
  });

  it("computes yearMonth correctly", () => {
    const content = VALID_HEADER + "\n" + makeRow({ fecha: "2025-11-20" });
    const { rows } = parseLibroMayor(encode(content));
    expect(rows[0].yearMonth).toBe("2025-11-01");
    expect(rows[0].year).toBe(2025);
    expect(rows[0].month).toBe(11);
  });
});
