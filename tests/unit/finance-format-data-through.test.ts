import { describe, it, expect } from "vitest";
import { formatDataThrough } from "@/app/finance/lib/format-data-through";

describe("formatDataThrough", () => {
  it("formats a full ISO date into a Spanish caption", () => {
    expect(formatDataThrough("2026-06-30")).toBe(
      "Datos actualizados hasta el 30 jun 2026 · Libro Mayor"
    );
  });

  it("drops a leading zero on the day", () => {
    expect(formatDataThrough("2025-01-05")).toBe(
      "Datos actualizados hasta el 5 ene 2025 · Libro Mayor"
    );
  });

  it("returns an empty-state caption when there is no date", () => {
    expect(formatDataThrough(null)).toBe(
      "Sin datos del Libro Mayor en este período"
    );
  });

  it("falls back to the raw string for an unexpected format", () => {
    expect(formatDataThrough("2026")).toBe(
      "Datos actualizados hasta el 2026 · Libro Mayor"
    );
  });
});
