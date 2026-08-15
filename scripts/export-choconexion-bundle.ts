#!/usr/bin/env npx tsx
/**
 * Build the Choconexión bundle from the command line.
 *
 * Same code path as the admin page (`src/app/admin/choconexion-export/`), minus
 * the job row, the permission check and the tarball — this exists so the bundle
 * can be regenerated on a laptop against a snapshot of the production database,
 * without deploying the portal first. The admin page remains the way to produce
 * a bundle from *inside* production; this is the way to produce one from
 * *outside* it.
 *
 * Must run inside the dev container: better-sqlite3 and sharp are native
 * modules built for that image, and ffmpeg lives there too.
 *
 *   docker compose exec portal npx tsx scripts/export-choconexion-bundle.ts
 *
 * `scripts/refresh-choconexion-bundle.sh` is the wrapper that pulls the
 * production snapshot, invokes this, and installs the result into the
 * Choconexión checkout. Prefer that over calling this directly.
 *
 * Options:
 *   --db PATH         Database to read (default: $DB_PATH, else data/portal.db)
 *   --version NAME    Bundle version/directory name (default: today, or today-N)
 *
 * NODE_OPTIONS must carry `--conditions=react-server` so that `server-only`
 * resolves to its empty stub instead of the module that throws on import; the
 * export core is a server module and says so. The wrapper sets this for you.
 */

import path from "node:path";

import { buildBundle, nextVersion } from "@/lib/choconexion/export-core";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  // Set before anything touches the DB singleton — it reads DB_PATH once, at
  // first connection, and caches the handle for the life of the process.
  const dbOverride = flag("db");
  if (dbOverride) process.env.DB_PATH = dbOverride;
  const dbPath = process.env.DB_PATH || "data/portal.db";

  const now = new Date();
  const version = flag("version") ?? (await nextVersion(now));

  console.log(`[choconexion] database : ${dbPath}`);
  console.log(`[choconexion] version  : ${version}`);
  console.log("");

  let lastLine = "";
  const result = await buildBundle({
    version,
    now,
    onProgress: (done, total, message) => {
      // One rewritten line rather than a page of them; this runs interactively.
      const line = `  ${message}`.padEnd(lastLine.length, " ");
      process.stdout.write(`\r${line}`);
      lastLine = line;
      if (done === total) process.stdout.write("\n");
    },
  });

  const photos = result.bundle.sites.reduce((n, s) => n + s.photos.length, 0);
  const clips = result.bundle.sites.reduce((n, s) => n + s.soundscapes.length, 0);
  const sitesWithAudio = result.bundle.sites.filter((s) => s.soundscapes.length > 0).length;
  const withResults = result.bundle.sites.filter((s) => s.state === "results").length;

  console.log("");
  console.log(`  sites      : ${result.bundle.sites.length} (${withResults} with results)`);
  console.log(`  species    : ${result.bundle.species.length}`);
  console.log(`  photos     : ${photos}`);
  console.log(`  soundscapes: ${clips} (across ${sitesWithAudio} sites)`);
  console.log(`  size       : ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);

  if (result.warnings.length > 0) {
    console.log("");
    console.log(`  ${result.warnings.length} warning(s):`);
    for (const w of result.warnings) console.log(`    · ${w}`);
  }

  // Machine-readable, and last: the wrapper greps this to find what to install.
  console.log("");
  console.log(`BUNDLE_DIR=${path.relative(process.cwd(), result.dir)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error("[choconexion] export failed:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
