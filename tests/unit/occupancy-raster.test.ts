import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function pythonReady(): boolean {
  try {
    return spawnSync("python3", ["-c", "print(1)"], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "occ-raster-"));
const okStub = path.join(dir, "stub_ok.py");
writeFileSync(
  okStub,
  `import sys, json
cfg = json.loads(sys.stdin.read())
print(json.dumps({"type":"version","rasterio":"stub"}))
sites = [{"siteId": s["siteId"], "forestCover": round(s["lat"],2), "elevation": 500 + i} for i, s in enumerate(cfg["sites"])]
print(json.dumps({"type":"sites","sites": sites}))
print(json.dumps({"type":"grid","cells":[{"lat":0.4,"lng":-79.6,"forestCover":0.5,"elevation":600}]}))
print(json.dumps({"type":"complete"}))
`,
);
const errStub = path.join(dir, "stub_err.py");
writeFileSync(
  errStub,
  `import sys, json
print(json.dumps({"type":"version","rasterio":"stub"}))
print(json.dumps({"type":"error","message":"forestRaster path required"}))
sys.exit(1)
`,
);

describe.skipIf(!pythonReady())("runForestCover bridge", () => {
  it("parses per-site + grid results from the NDJSON stream", async () => {
    const { runForestCover } = await import("@/lib/occupancy/raster");
    const res = await runForestCover(
      { forestRaster: "/x.tif", sites: [{ siteId: "1", lat: 0.4, lng: -79.6 }, { siteId: "2", lat: 0.41, lng: -79.61 }] },
      { pythonPath: "python3", scriptPath: okStub },
    );
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.sites).toHaveLength(2);
    expect(res.sites[0]).toMatchObject({ siteId: "1", elevation: 500 });
    expect(res.grid).toHaveLength(1);
    expect(res.grid[0]).toMatchObject({ forestCover: 0.5, elevation: 600 });
  });

  it("returns a failure result (never throws) when the script emits an error", async () => {
    const { runForestCover } = await import("@/lib/occupancy/raster");
    const res = await runForestCover(
      { forestRaster: "", sites: [] },
      { pythonPath: "python3", scriptPath: errStub },
    );
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("forestRaster");
  });
});
