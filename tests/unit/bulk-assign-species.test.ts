/**
 * Static guard tests for the `bulkAssignSpecies` server action.
 *
 * The repo's camera-trap action tests are grep-style structural invariants
 * (see tests/unit/species-actions.test.ts) rather than DB-hitting integration
 * tests. These confirm the security + semantic invariants that, if broken,
 * would create a permission leak or silently change verify semantics:
 *
 * 1. Permission is enforced before any Drizzle query.
 * 2. Per-deployment access is verified.
 * 3. Empty input is a no-op returning count 0 (no DB write).
 * 4. The verify/correct branch is inherited from assignSpecies.
 * 5. The action returns an ActionResult shape.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ACTIONS_FILE = join(process.cwd(), "src/app/camera-trap/actions.ts");
const SOURCE = readFileSync(ACTIONS_FILE, "utf-8");

function extractActionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start === -1) throw new Error(`Action ${name} not found in source`);
  // Slice up to the next top-level `export async function` (or a large window).
  const rest = source.slice(start + 1);
  const nextExport = rest.indexOf("\nexport async function ");
  return nextExport === -1
    ? source.slice(start)
    : source.slice(start, start + 1 + nextExport);
}

describe("bulkAssignSpecies — security + semantic invariants", () => {
  const body = extractActionBody(SOURCE, "bulkAssignSpecies");

  it("enforces editor permission before any query", () => {
    expect(body).toMatch(/requirePermission\("camera-trap", "editor"\)/);
    // requirePermission must appear before the first db call.
    const permIndex = body.indexOf("requirePermission");
    const dbIndex = body.indexOf("db\n") >= 0 ? body.indexOf("db\n") : body.indexOf("db.");
    expect(permIndex).toBeGreaterThanOrEqual(0);
    expect(permIndex).toBeLessThan(dbIndex);
  });

  it("verifies per-deployment access", () => {
    expect(body).toMatch(/requireDeploymentAccess\(user, row\.deploymentId\)/);
  });

  it("short-circuits empty input to count 0", () => {
    expect(body).toMatch(/detectionIds\.length === 0/);
    expect(body).toMatch(/success: true, data: \{ count: 0 \}/);
  });

  it("inherits assignSpecies verify/correct semantics", () => {
    // match ML prediction -> verified; otherwise -> corrected
    expect(body).toMatch(/isMatch \? "verified" : "corrected"/);
    expect(body).toMatch(/newSpecies === row\.identSpecies/);
  });

  it("returns an ActionResult with a count on success and an error string on failure", () => {
    expect(body).toMatch(/return \{ success: true, data: \{ count \} \}/);
    expect(body).toMatch(/success: false/);
    expect(body).toMatch(/Error al asignar especie en lote/);
  });

  it("revalidates the camera-trap path", () => {
    expect(body).toMatch(/revalidatePath\(CAMERA_TRAP_PATH\)/);
  });
});
