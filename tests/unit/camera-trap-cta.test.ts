import { describe, it, expect } from "vitest";

// Extract the CTA logic to test it. This mirrors the per-status empty-state /
// action branches of src/app/camera-trap/[id]/page.tsx (the page no longer has
// a literal getCta function) — keep them in sync.
function getCta(
  status: string,
  totalDetections: number,
  latestCompletedJobId: number | null,
  latestJobId: number | null,
  canEdit: boolean,
) {
  if (!canEdit) {
    if (latestCompletedJobId) {
      return { text: "Ver Resultados", href: `/camera-trap/results/${latestCompletedJobId}`, variant: "outline" as const };
    }
    return null;
  }

  switch (status) {
    case "unscanned":
    case "scanned":
      return { text: "Procesar", action: "process" as const, variant: "default" as const };
    case "processing":
      return {
        text: "Procesando... (Ver progreso)",
        href: latestJobId ? `/camera-trap/process?jobId=${latestJobId}` : undefined,
        variant: "secondary" as const,
        disabled: true,
      };
    case "processed":
      if (totalDetections > 0 && latestCompletedJobId) {
        return {
          text: `Revisar ${totalDetections.toLocaleString()} Detecciones`,
          href: `/camera-trap/results/${latestCompletedJobId}`,
          variant: "default" as const,
          className: "bg-orange-500 hover:bg-orange-600",
        };
      }
      return { text: "Verificar (Sin Detecciones)", action: "verify-empty" as const, variant: "outline" as const };
    case "verified":
      if (latestCompletedJobId) {
        return { text: "Ver Resultados", href: `/camera-trap/results/${latestCompletedJobId}`, variant: "outline" as const };
      }
      return null;
    case "verified_empty":
      return null;
    case "no_data":
      // Terminal: nothing to process, no results to view.
      return null;
    default:
      return null;
  }
}

describe("getCta (deployment detail CTA state machine)", () => {
  describe("viewer role (canEdit=false)", () => {
    it("returns results link when completed job exists", () => {
      const cta = getCta("processed", 10, 42, 42, false);
      expect(cta).toEqual({
        text: "Ver Resultados",
        href: "/camera-trap/results/42",
        variant: "outline",
      });
    });

    it("returns null when no completed job", () => {
      expect(getCta("scanned", 0, null, null, false)).toBeNull();
    });
  });

  describe("editor role (canEdit=true)", () => {
    it("returns Procesar for unscanned", () => {
      const cta = getCta("unscanned", 0, null, null, true);
      expect(cta).toEqual({ text: "Procesar", action: "process", variant: "default" });
    });

    it("returns Procesar for scanned", () => {
      const cta = getCta("scanned", 0, null, null, true);
      expect(cta).toEqual({ text: "Procesar", action: "process", variant: "default" });
    });

    it("returns progress link for processing", () => {
      const cta = getCta("processing", 0, null, 99, true);
      expect(cta).toMatchObject({
        text: "Procesando... (Ver progreso)",
        href: "/camera-trap/process?jobId=99",
        disabled: true,
      });
    });

    it("returns review link for processed with detections", () => {
      const cta = getCta("processed", 52, 42, 42, true);
      expect(cta).toMatchObject({
        text: "Revisar 52 Detecciones",
        href: "/camera-trap/results/42",
        variant: "default",
      });
    });

    it("returns verify empty for processed with 0 detections", () => {
      const cta = getCta("processed", 0, 42, 42, true);
      expect(cta).toEqual({
        text: "Verificar (Sin Detecciones)",
        action: "verify-empty",
        variant: "outline",
      });
    });

    it("returns results link for verified", () => {
      const cta = getCta("verified", 30, 42, 42, true);
      expect(cta).toEqual({
        text: "Ver Resultados",
        href: "/camera-trap/results/42",
        variant: "outline",
      });
    });

    it("returns null for verified_empty", () => {
      expect(getCta("verified_empty", 0, null, null, true)).toBeNull();
    });

    it("returns null for no_data", () => {
      expect(getCta("no_data", 0, null, null, true)).toBeNull();
    });

    it("returns null for no_data as viewer with no job", () => {
      expect(getCta("no_data", 0, null, null, false)).toBeNull();
    });

    it("returns null for unknown status", () => {
      expect(getCta("unknown_status", 0, null, null, true)).toBeNull();
    });
  });
});
