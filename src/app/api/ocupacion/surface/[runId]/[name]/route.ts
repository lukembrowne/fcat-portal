/**
 * Occupancy surface PNG route.
 *
 * Serves the colorized raster surfaces (per-species ψ, plus the shared
 * `_forest` / `_elevation` covariate layers) rendered by the occupancy build
 * into `data/occupancy-models/{runId}/`. Those live under `data/` (outside
 * `public/`), so they need an authenticated route rather than a static asset.
 *
 *   /api/ocupacion/surface/{runId}/{name}   →  data/occupancy-models/{runId}/{name}.png
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getCurrentUser, hasProjectAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; name: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Occupancy is gated on the camera-trap project (matches the /ocupacion pages).
  if (!hasProjectAccess(user, "camera-trap")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId, name } = await params;
  if (!/^\d+$/.test(runId) || !NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const base = path.join(process.cwd(), "data", "occupancy-models", runId);
  const file = path.join(base, `${name}.png`);
  // Defence in depth against traversal (the regexes already forbid `.`/`/`).
  if (!path.resolve(file).startsWith(path.resolve(base) + path.sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const data = await fs.readFile(file);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(data.length),
        // Surfaces are immutable per run; the URL carries the runId.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
