/**
 * Remove audio recordings that belong to a DIFFERENT recorder than the one a
 * deployment actually ran, dated before the deployment's valid window.
 *
 * WHY. CCN-003_V1 (recorder 2MM21842) also holds 1,180 files from recorder
 * 2MM20630 dated 2025-11-17 → 11-23 — a house test uploaded alongside the
 * field retrieval, two months before the deployment's valid_start. BirdNET
 * analysed them, so their detections count toward the site, and 38 of them
 * were drawn into validation samples.
 *
 * WHAT IT DELETES. Only `audio_files` rows. Everything hanging off them goes
 * by ON DELETE CASCADE (verified against push-schema.mjs and the live
 * foreign_key_list): audio_detections → audio_identifications →
 * birdnet_validation_samples → birdnet_validation_reviews, and
 * acoustic_indices. Foreign keys are OFF by default in SQLite, so this script
 * turns them ON before anything else — without it the delete would orphan
 * every child row instead of removing it.
 *
 * Matching: the deployment by NAME (ids differ between dev and prod), the
 * filename prefix `<serial>_`, a `SERIAL_YYYYMMDD_HHMMSS.ext` filename, and a
 * filename date strictly before `--before` (default: the date part of the
 * deployment's valid_start). Refuses if valid_start is null and no --before.
 *
 * ORDER OF OPERATIONS (do not skip step 2):
 *   1. Back up the DB (db-backup-restore skill).
 *   2. Move the files OUT of the deployment's audio folder in Drive. If they
 *      stay, the next audio sync re-imports them and BirdNET re-analyses them.
 *   3. Dry run (default) and read the report — especially reviews that would
 *      be deleted and any fitted/applied thresholds on affected species.
 *   4. Re-run with --apply.
 *
 * Self-contained (better-sqlite3 only) because the prod runner image does not
 * ship src/. Run INSIDE the container — a host process against data/portal.db
 * while the container holds it open corrupts it on macOS bind mounts:
 *
 *   docker compose exec portal node scripts/remove-stray-audio.mjs \
 *     --deployment CCN-003_V1 --serial 2MM20630 [--before 2026-01-24] \
 *     [--db data/portal.db] [--actor someone@fcat-ecuador.org] [--apply]
 */

import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    [
      "Uso: node scripts/remove-stray-audio.mjs --deployment <NOMBRE> --serial <SERIAL> [opciones]",
      "",
      "  --deployment <NOMBRE>  Nombre de la instalación (p. ej. CCN-003_V1). Obligatorio.",
      "  --serial <SERIAL>      Prefijo de grabadora en el nombre de archivo (p. ej. 2MM20630). Obligatorio.",
      "  --before <YYYY-MM-DD>  Solo archivos con fecha ANTERIOR a este día.",
      "                         Por defecto: la fecha de valid_start de la instalación.",
      "  --db <ruta>            Base de datos (por defecto DB_PATH o data/portal.db).",
      "  --actor <email>        Se registra como actor_email del evento de sistema.",
      "  --apply                Borra de verdad. Sin esta opción es una simulación (dry run).",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { apply: false };
  const valued = new Set(["--deployment", "--serial", "--before", "--db", "--actor"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") usage();
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} requiere un valor`);
      out[a.slice(2)] = v;
    } else usage(`argumento desconocido: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.deployment) usage("falta --deployment");
if (!args.serial) usage("falta --serial");
if (!/^[A-Za-z0-9-]+$/.test(args.serial)) usage("--serial solo admite letras, dígitos y guiones");
if (args.before !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.before)) {
  usage("--before debe tener formato YYYY-MM-DD");
}

const dbPath = args.db || process.env.DB_PATH || "data/portal.db";
const db = new Database(dbPath, { fileMustExist: true });
db.pragma("foreign_keys = ON");
if (db.pragma("foreign_keys", { simple: true }) !== 1) {
  console.error("No se pudo activar PRAGMA foreign_keys; abortando (el borrado dejaría huérfanos).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FILENAME_RE = /^([^_]+)_(\d{8})_(\d{6})\.[A-Za-z0-9]+$/;
const fmtDate = (yyyymmdd) =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const n = (x) => Number(x).toLocaleString("es-EC");

function banner(title) {
  console.log(`\n=== ${title} ===`);
}

function driveWarning() {
  console.log(
    [
      "",
      "!!! ADVERTENCIA — MOVER LOS ARCHIVOS EN DRIVE PRIMERO !!!",
      "Los archivos deben sacarse de la carpeta de audio de la instalación en Google Drive",
      "ANTES de borrar las filas. Si siguen ahí, la próxima sincronización de audio los",
      "vuelve a importar y BirdNET los vuelve a analizar.",
      "",
    ].join("\n"),
  );
}

/** Placeholder list for an IN (...) clause, chunked to stay under SQLite's variable limit. */
function inChunks(ids, size, fn) {
  for (let i = 0; i < ids.length; i += size) fn(ids.slice(i, i + size));
}

// ---------------------------------------------------------------------------
// Resolve deployment + cutoff
// ---------------------------------------------------------------------------

const deployments = db
  .prepare(`SELECT id, name, valid_start, valid_end FROM biochoco_deployments WHERE name = ?`)
  .all(args.deployment);
if (deployments.length === 0) {
  console.error(`No existe una instalación con nombre "${args.deployment}".`);
  process.exit(1);
}
if (deployments.length > 1) {
  console.error(
    `Hay ${deployments.length} instalaciones con nombre "${args.deployment}" (ids ${deployments
      .map((d) => d.id)
      .join(", ")}); abortando.`,
  );
  process.exit(1);
}
const dep = deployments[0];

let before = args.before;
if (!before) {
  if (!dep.valid_start) {
    console.error(
      `La instalación ${dep.name} no tiene valid_start; pase --before YYYY-MM-DD explícitamente.`,
    );
    process.exit(1);
  }
  before = String(dep.valid_start).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error(`valid_start "${dep.valid_start}" no empieza con YYYY-MM-DD; use --before.`);
    process.exit(1);
  }
}
const beforeCompact = before.replaceAll("-", "");

console.log(`Base de datos: ${dbPath}`);
console.log(`Modo: ${args.apply ? "APLICAR (borrado real)" : "SIMULACIÓN (dry run, no se borra nada)"}`);
console.log(
  `Instalación: ${dep.name} (id ${dep.id}) · valid_start ${dep.valid_start ?? "—"} · valid_end ${dep.valid_end ?? "—"}`,
);
console.log(`Criterio: archivo "${args.serial}_YYYYMMDD_HHMMSS.*" con fecha < ${before}`);
driveWarning();

// ---------------------------------------------------------------------------
// Match files
// ---------------------------------------------------------------------------

function findMatches() {
  const prefix = `${args.serial}_`;
  const rows = db
    .prepare(
      `SELECT id, filename FROM audio_files
        WHERE deployment_id = ? AND substr(filename, 1, ?) = ?`,
    )
    .all(dep.id, prefix.length, prefix);
  return rows.filter((r) => {
    const m = FILENAME_RE.exec(r.filename);
    return m && m[1] === args.serial && m[2] < beforeCompact;
  });
}

const matches = findMatches();
const fileIds = matches.map((r) => r.id);

// Scratch table so every count is one join, not thousands of IN lists.
db.exec(`CREATE TEMP TABLE IF NOT EXISTS stray_files (id INTEGER PRIMARY KEY)`);
db.exec(`DELETE FROM stray_files`);
{
  const ins = db.prepare(`INSERT INTO stray_files (id) VALUES (?)`);
  db.transaction((ids) => {
    for (const id of ids) ins.run(id);
  })(fileIds);
}

function report() {
  banner("Archivos que coinciden");
  if (matches.length === 0) {
    console.log("Ninguno.");
    return null;
  }
  const dates = matches.map((r) => FILENAME_RE.exec(r.filename)[2]).sort();
  const exts = {};
  for (const r of matches) {
    const ext = r.filename.split(".").pop().toLowerCase();
    exts[ext] = (exts[ext] ?? 0) + 1;
  }
  console.log(`Archivos: ${n(matches.length)}`);
  console.log(`Rango de fechas (nombre de archivo): ${fmtDate(dates[0])} → ${fmtDate(dates.at(-1))}`);
  console.log(
    `Extensiones: ${Object.entries(exts)
      .map(([e, c]) => `.${e}=${n(c)}`)
      .join(", ")}`,
  );

  const totalOnDep = db
    .prepare(`SELECT count(*) c FROM audio_files WHERE deployment_id = ?`)
    .get(dep.id).c;
  console.log(`(La instalación tiene ${n(totalOnDep)} archivos de audio en total; quedarían ${n(totalOnDep - matches.length)}.)`);

  const counts = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM audio_detections d JOIN stray_files s ON s.id = d.audio_file_id) AS detections,
         (SELECT count(*) FROM audio_identifications i
            JOIN audio_detections d ON d.id = i.audio_detection_id
            JOIN stray_files s ON s.id = d.audio_file_id) AS identifications,
         (SELECT count(*) FROM acoustic_indices a JOIN stray_files s ON s.id = a.audio_file_id) AS acoustic,
         (SELECT count(*) FROM birdnet_validation_samples vs
            JOIN audio_identifications i ON i.id = vs.audio_identification_id
            JOIN audio_detections d ON d.id = i.audio_detection_id
            JOIN stray_files s ON s.id = d.audio_file_id) AS samples,
         (SELECT count(*) FROM birdnet_validation_reviews r
            JOIN birdnet_validation_samples vs ON vs.id = r.sample_id
            JOIN audio_identifications i ON i.id = vs.audio_identification_id
            JOIN audio_detections d ON d.id = i.audio_detection_id
            JOIN stray_files s ON s.id = d.audio_file_id) AS reviews`,
    )
    .get();

  banner("Filas que se borrarían en cascada");
  console.log(`Detecciones (audio_detections):          ${n(counts.detections)}`);
  console.log(`Identificaciones (audio_identifications): ${n(counts.identifications)}`);
  console.log(`Índices acústicos (acoustic_indices):     ${n(counts.acoustic)}`);
  console.log(`Muestras de validación:                   ${n(counts.samples)}`);
  console.log(`Revisiones de validación:                 ${n(counts.reviews)}`);

  const verif = db
    .prepare(
      `SELECT i.verification_status AS status, count(*) c FROM audio_identifications i
         JOIN audio_detections d ON d.id = i.audio_detection_id
         JOIN stray_files s ON s.id = d.audio_file_id
        GROUP BY 1 ORDER BY 2 DESC`,
    )
    .all();
  if (verif.length) {
    console.log(
      `Identificaciones por estado de verificación: ${verif.map((v) => `${v.status}=${n(v.c)}`).join(", ")}`,
    );
  }

  banner("Muestras de validación por especie");
  const bySpecies = db
    .prepare(
      `SELECT c.id AS campaign_id, c.species, c.status, count(*) AS samples,
              (SELECT count(*) FROM birdnet_validation_samples all_s WHERE all_s.campaign_id = c.id) AS total
         FROM birdnet_validation_samples vs
         JOIN birdnet_validation_campaigns c ON c.id = vs.campaign_id
         JOIN audio_identifications i ON i.id = vs.audio_identification_id
         JOIN audio_detections d ON d.id = i.audio_detection_id
         JOIN stray_files s ON s.id = d.audio_file_id
        GROUP BY c.id ORDER BY samples DESC, c.species`,
    )
    .all();
  if (bySpecies.length === 0) console.log("Ninguna.");
  for (const r of bySpecies) {
    console.log(
      `  ${r.species} [${r.status}] (campaña ${r.campaign_id}): ${n(r.samples)} de ${n(r.total)} clips`,
    );
  }

  banner("Revisiones que se borrarían, por revisor");
  const byReviewer = db
    .prepare(
      `SELECT r.reviewer_email, r.outcome, count(*) c
         FROM birdnet_validation_reviews r
         JOIN birdnet_validation_samples vs ON vs.id = r.sample_id
         JOIN audio_identifications i ON i.id = vs.audio_identification_id
         JOIN audio_detections d ON d.id = i.audio_detection_id
         JOIN stray_files s ON s.id = d.audio_file_id
        GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .all();
  if (byReviewer.length === 0) console.log("Ninguna.");
  const grouped = new Map();
  for (const r of byReviewer) {
    const g = grouped.get(r.reviewer_email) ?? { total: 0, parts: [] };
    g.total += r.c;
    g.parts.push(`${r.outcome}=${n(r.c)}`);
    grouped.set(r.reviewer_email, g);
  }
  for (const [email, g] of grouped) console.log(`  ${email}: ${n(g.total)} (${g.parts.join(", ")})`);

  const reviewsBySpecies = db
    .prepare(
      `SELECT c.species, r.reviewer_email, count(*) c
         FROM birdnet_validation_reviews r
         JOIN birdnet_validation_samples vs ON vs.id = r.sample_id
         JOIN birdnet_validation_campaigns c ON c.id = vs.campaign_id
         JOIN audio_identifications i ON i.id = vs.audio_identification_id
         JOIN audio_detections d ON d.id = i.audio_detection_id
         JOIN stray_files s ON s.id = d.audio_file_id
        GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .all();
  if (reviewsBySpecies.length) {
    console.log("  Detalle por especie:");
    for (const r of reviewsBySpecies) console.log(`    ${r.species} — ${r.reviewer_email}: ${n(r.c)}`);
  }

  banner("Umbrales ajustados / aplicados en especies afectadas");
  const species = [...new Set(bySpecies.map((r) => r.species))];
  const thresholds = [];
  inChunks(species, 400, (chunk) => {
    thresholds.push(
      ...db
        .prepare(
          `SELECT t.id, t.campaign_id, t.species, t.source, t.is_active, t.threshold_conf_95,
                  t.unusable_reason, t.n_reviewed, t.fitted_at
             FROM birdnet_species_thresholds t
            WHERE t.species IN (${chunk.map(() => "?").join(",")})
            ORDER BY t.species, t.fitted_at`,
        )
        .all(...chunk),
    );
  });
  if (thresholds.length === 0) console.log("Ninguno.");
  for (const t of thresholds) {
    const when = new Date(t.fitted_at * 1000).toISOString().slice(0, 10);
    const value =
      t.threshold_conf_95 != null
        ? `umbral95=${t.threshold_conf_95.toFixed(3)}`
        : `inutilizable: ${t.unusable_reason ?? "—"}`;
    console.log(
      `  ${t.species} (campaña ${t.campaign_id}, umbral ${t.id}, ${t.source}, n=${t.n_reviewed}, ${when})` +
        ` ${value}${t.is_active ? " · APLICADO" : ""}  → se recomienda re-ajustar (re-fit recommended)`,
    );
  }

  return { ...counts, bySpecies, byReviewer: [...grouped].map(([email, g]) => ({ email, total: g.total })), thresholds };
}

// ---------------------------------------------------------------------------
// Informational: other deployments mixing recorder serials. Never acted on.
// ---------------------------------------------------------------------------

function mixedSerialReport() {
  banner("Informativo: otras instalaciones con archivos de 2+ grabadoras (no se modifican)");
  const rows = db
    .prepare(
      `SELECT d.id AS dep_id, d.name,
              substr(af.filename, 1, instr(af.filename, '_') - 1) AS serial,
              count(*) AS c,
              min(substr(af.filename, instr(af.filename, '_') + 1, 8)) AS first_date,
              max(substr(af.filename, instr(af.filename, '_') + 1, 8)) AS last_date
         FROM audio_files af
         JOIN biochoco_deployments d ON d.id = af.deployment_id
        WHERE af.filename GLOB '*_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9].*'
          AND af.deployment_id IN (
            SELECT deployment_id FROM audio_files
             WHERE filename GLOB '*_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9].*'
             GROUP BY deployment_id
            HAVING count(DISTINCT substr(filename, 1, instr(filename, '_') - 1)) >= 2)
        GROUP BY d.id, serial
        ORDER BY d.name, c DESC`,
    )
    .all()
    .filter((r) => r.dep_id !== dep.id);
  if (rows.length === 0) {
    console.log("Ninguna.");
    return;
  }
  let last = null;
  for (const r of rows) {
    if (r.dep_id !== last) {
      console.log(`  ${r.name} (id ${r.dep_id}):`);
      last = r.dep_id;
    }
    console.log(`    ${r.serial}: ${n(r.c)} archivos, ${fmtDate(r.first_date)} → ${fmtDate(r.last_date)}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const summary = report();
mixedSerialReport();

if (!args.apply) {
  console.log("\nSimulación terminada. No se borró nada. Añada --apply para borrar.");
  driveWarning();
  process.exit(0);
}

if (!summary) {
  console.log("\nNada que borrar.");
  process.exit(0);
}

banner("Aplicando");
const started = Date.now();
const deleted = db.transaction(() => {
  // Re-check FK enforcement inside the transaction (it cannot change mid-tx,
  // but a silent OFF here would orphan hundreds of child rows).
  if (db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("foreign_keys OFF");
  return db.prepare(`DELETE FROM audio_files WHERE id IN (SELECT id FROM stray_files)`).run().changes;
})();
const durationMs = Date.now() - started;

const remainingFiles = findMatches().length;
const orphans = db
  .prepare(
    `SELECT
       (SELECT count(*) FROM audio_detections d JOIN stray_files s ON s.id = d.audio_file_id) AS detections,
       (SELECT count(*) FROM acoustic_indices a JOIN stray_files s ON s.id = a.audio_file_id) AS acoustic`,
  )
  .get();

console.log(`Archivos borrados: ${n(deleted)} (esperados ${n(fileIds.length)})`);
console.log(`Archivos que aún coinciden: ${n(remainingFiles)}`);
console.log(`Detecciones restantes de esos archivos: ${n(orphans.detections)}`);
console.log(`Índices acústicos restantes de esos archivos: ${n(orphans.acoustic)}`);
console.log(`Duración: ${durationMs} ms`);

const ok = deleted === fileIds.length && remainingFiles === 0 && orphans.detections === 0 && orphans.acoustic === 0;
if (!ok) console.error("\n¡ATENCIÓN! La verificación posterior no cuadra; revise la base de datos.");

// system_events: event_type is free text (no CHECK); source 'audio' and
// severity 'warn' are in the CHECK lists. occurred_at is a Drizzle
// mode:"timestamp" column, so Unix SECONDS.
const summaryText =
  `Se eliminaron ${n(deleted)} grabaciones ajenas (grabadora ${args.serial}, antes del ${before}) ` +
  `de ${dep.name}: ${n(summary.detections)} detecciones, ${n(summary.samples)} muestras de validación, ` +
  `${n(summary.reviews)} revisiones.`;
db.prepare(
  `INSERT INTO system_events
     (occurred_at, event_type, source, severity, actor_email, project_id, target_type, target_id, summary, duration_ms, details)
   VALUES (?, ?, 'audio', 'warn', ?, 'grabaciones', 'deployment', ?, ?, ?, ?)`,
).run(
  Math.floor(Date.now() / 1000),
  "audio_stray_files_removed",
  args.actor ?? null,
  String(dep.id),
  summaryText,
  durationMs,
  JSON.stringify({
    deploymentName: dep.name,
    serial: args.serial,
    before,
    files: deleted,
    detections: summary.detections,
    identifications: summary.identifications,
    acousticIndices: summary.acoustic,
    validationSamples: summary.samples,
    validationReviews: summary.reviews,
    samplesBySpecies: summary.bySpecies.map((r) => ({ species: r.species, status: r.status, samples: r.samples })),
    reviewsByReviewer: summary.byReviewer,
    refitRecommended: [...new Set(summary.thresholds.map((t) => t.species))],
    verified: ok,
  }),
);
console.log(`\nEvento de sistema registrado: ${summaryText}`);
driveWarning();
process.exit(ok ? 0 : 1);
