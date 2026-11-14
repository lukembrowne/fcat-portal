#!/usr/bin/env node
/**
 * BioChoco deployment anomaly scan — camera-trap timestamp integrity.
 *
 * Reads the portal SQLite DB READ-ONLY and prints a JSON snapshot of every
 * deployment whose image timestamps look wrong: a clock that never advanced,
 * a day↔month swap, a clock offset, stray outliers, a camera that started late
 * or stopped early. Rendered to HTML by scripts/render-anomaly-report.mjs and
 * driven by the `biochoco-anomaly-report` skill.
 *
 * Self-contained on purpose (only `better-sqlite3`, resolved from the cwd) so
 * it can be piped into the production container over SSH without a deploy:
 *
 *   ssh digitalocean "cd /root/opt/fcat-portal && \
 *     docker compose exec -T portal node --input-type=module -" \
 *     < scripts/biochoco-anomaly-scan.mjs > snapshot.json
 *
 * Options (env, since stdin-fed scripts take no argv): ANOMALY_DB (default
 * data/portal.db), ANOMALY_PROJECT (camera-trap project name, default
 * "BioChoco"), ANOMALY_TODAY (YYYY-MM-DD override for tests/replays).
 *
 * Timestamp semantics (verified on prod 2026-11-09): current BioChoco cameras
 * write dateless `HHMMSS_NNNN.jpg` filenames and NO EXIF, so the capture time
 * is `file_modified` — the camera's own clock, preserved through the SD copy
 * (the filename's HHMMSS agrees with it on 31,930 of 31,931 images). It is a
 * true instant; Ecuador local time is UTC-5 with no DST. `exif_timestamp`
 * wins when present. The `_NNNN` suffix is NOT a sequence counter — don't
 * build an ordering check on it.
 */

import { createRequire } from "node:module";

export const ECUADOR_OFFSET_MS = -5 * 3600 * 1000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Days of slack around the ODK install→retrieve window before an image counts as outside. */
export const WINDOW_TOLERANCE_DAYS = 1;
/** A deployment whose whole image set spans less than this is "collapsed". */
export const COLLAPSED_SPAN_MS = HOUR_MS;
/** Fewer images than this, all in one burst, reads as "camera died after setup", not a stuck clock. */
export const COLLAPSED_MIN_IMAGES = 10;
/** First image this many days after install → late start. */
export const LATE_START_DAYS = 3;
/** Last image this many days before retrieval → early stop. */
export const EARLY_STOP_DAYS = 5;
/** Filename HHMMSS vs stored time-of-day disagreement tolerance. */
export const FILENAME_TIME_TOLERANCE_S = 120;
/** Max example images listed per finding. */
const MAX_EXAMPLES = 8;

// ---------------------------------------------------------------------------
// Time helpers (all "local" = Ecuador wall clock, computed via UTC getters so
// the result never depends on the container's TZ — prod runs America/New_York)
// ---------------------------------------------------------------------------

/** Effective capture instant (ms) for an image row, or null. */
export function captureMs(img) {
  if (img.exifTimestamp) {
    const t = Date.parse(img.exifTimestamp);
    if (Number.isFinite(t)) return t;
  }
  if (img.fileModified != null && Number.isFinite(img.fileModified) && img.fileModified > 0) {
    return img.fileModified * 1000;
  }
  return null;
}

/** "YYYY-MM-DD HH:MM" Ecuador local. */
export function localStamp(ms) {
  return new Date(ms + ECUADOR_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** "YYYY-MM-DD" Ecuador local. */
export function localDay(ms) {
  return new Date(ms + ECUADOR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight (Ecuador) of a "YYYY-MM-DD…" string, as an instant; null if unparseable. */
export function dayStartMs(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const t = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t - ECUADOR_OFFSET_MS : null;
}

/** Whole local days from date string a to date string b (b - a). */
export function dayDiff(a, b) {
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / DAY_MS);
}

/** "YYYY-MM-DD" with day and month exchanged, or null when the swap is a no-op or invalid. */
export function swapDayMonth(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? "");
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo === d || Number(d) > 12) return null;
  return `${y}-${d}-${mo}`;
}

function humanDuration(ms) {
  const abs = Math.abs(ms);
  if (abs < HOUR_MS) return `${Math.round(abs / 60000)} min`;
  if (abs < 2 * DAY_MS) return `${(abs / HOUR_MS).toFixed(1)} h`;
  return `${Math.round(abs / DAY_MS)} días`;
}

function example(img, ms) {
  return { imageId: img.id, filename: img.filename, local: ms == null ? null : localStamp(ms) };
}

// ---------------------------------------------------------------------------
// The checks — pure, one deployment at a time
// ---------------------------------------------------------------------------

/**
 * @param {object} dep  deployment row: { id, name, dateStart, dateEnd, validStart, validEnd, ... }
 * @param {Array<{id, filename, exifTimestamp, fileModified}>} imgs  still images (no video frames)
 * @param {{ today: string }} opts  today as "YYYY-MM-DD" (Ecuador)
 * @returns {{ stats: object, findings: Array<object> }}
 */
export function analyzeDeployment(dep, imgs, opts) {
  const findings = [];
  const timed = [];
  for (const img of imgs) {
    const ms = captureMs(img);
    if (ms != null) timed.push({ img, ms });
  }
  timed.sort((a, b) => a.ms - b.ms || a.img.id - b.img.id);

  const n = timed.length;
  const install = dep.dateStart ? dep.dateStart.slice(0, 10) : null;
  const retrieve = dep.dateEnd ? dep.dateEnd.slice(0, 10) : null;
  const durationDays = install && retrieve ? dayDiff(install, retrieve) : null;

  const stats = {
    images: imgs.length,
    imagesWithTime: n,
    distinctTimestamps: new Set(timed.map((t) => t.ms)).size,
    first: n ? localStamp(timed[0].ms) : null,
    last: n ? localStamp(timed[n - 1].ms) : null,
    spanHours: n ? Math.round(((timed[n - 1].ms - timed[0].ms) / HOUR_MS) * 10) / 10 : null,
    activeDays: new Set(timed.map((t) => localDay(t.ms))).size,
    install,
    retrieve,
    durationDays,
    outsideWindow: null,
    /** Images per Ecuador-local day — drives the report's timeline strip. */
    dayCounts: {},
  };
  for (const t of timed) {
    const day = localDay(t.ms);
    stats.dayCounts[day] = (stats.dayCounts[day] ?? 0) + 1;
  }

  if (imgs.length > 0 && n === 0) {
    findings.push({
      check: "no_timestamps",
      severity: "error",
      title: "Imágenes sin ninguna fecha",
      detail: `Ninguna de las ${imgs.length} imágenes tiene fecha EXIF ni fecha de archivo. No se pueden ubicar en el tiempo.`,
      action: "Revisar en Drive si los archivos conservan su fecha; si no, re-subir desde la tarjeta SD original.",
      evidence: {},
    });
    return { stats, findings };
  }
  if (n === 0) return { stats, findings };

  if (n < imgs.length) {
    findings.push({
      check: "some_without_timestamp",
      severity: "warn",
      title: "Algunas imágenes sin fecha",
      detail: `${imgs.length - n} de ${imgs.length} imágenes no tienen fecha y quedan fuera de cualquier análisis temporal.`,
      action: "Revisar esas imágenes en la galería.",
      evidence: { missing: imgs.length - n },
    });
  }

  const firstMs = timed[0].ms;
  const lastMs = timed[n - 1].ms;
  const firstDay = localDay(firstMs);
  const spanMs = lastMs - firstMs;

  // -- 1. Clock never advanced: everything stamped within the same hour.
  const burst = n >= 2 && spanMs < COLLAPSED_SPAN_MS && (durationDays == null || durationDays >= 2);
  const collapsed = burst && n >= COLLAPSED_MIN_IMAGES;
  if (burst && !collapsed) {
    findings.push({
      check: "setup_burst_only",
      severity: "warn",
      title: `Solo ${n} imágenes, todas del mismo momento`,
      detail:
        `Las ${n} imágenes son del ${localStamp(firstMs)} (en ${humanDuration(spanMs)})` +
        (durationDays != null ? ` y el despliegue duró ${durationDays} días` : "") +
        ". Lo más probable es que la cámara dejara de funcionar tras la instalación; también puede ser un reloj detenido.",
      action: "Ver si las fotos son de la instalación. Si la cámara falló, registrarlo en las notas y excluir el despliegue del análisis de cámaras.",
      evidence: { examples: timed.slice(0, 3).map((t) => example(t.img, t.ms)) },
    });
  }
  if (collapsed) {
    findings.push({
      check: "timestamps_collapsed",
      severity: "error",
      title: "Todas las imágenes tienen la misma fecha y hora",
      detail:
        `Las ${n} imágenes caen dentro de ${humanDuration(spanMs)} (${stats.distinctTimestamps} marcas de tiempo distintas, ` +
        `todas el ${localStamp(firstMs)})` +
        (durationDays != null ? `, aunque la cámara estuvo instalada ${durationDays} días.` : ".") +
        " El reloj de la cámara no avanzó o las fechas se perdieron al copiar los archivos; la hora de cada detección no es real.",
      action:
        "Abrir la galería y confirmar si las fotos muestran días/noches distintos. Revisar en Drive la fecha original de los archivos y la configuración del reloj de la cámara antes de la próxima instalación.",
      evidence: {
        distinctTimestamps: stats.distinctTimestamps,
        stamp: localStamp(firstMs),
        examples: timed.slice(0, 3).map((t) => example(t.img, t.ms)),
      },
    });
  } else if (n >= 20 && durationDays != null && durationDays >= 7 && spanMs < DAY_MS) {
    findings.push({
      check: "span_under_one_day",
      severity: "warn",
      title: "Todas las imágenes en menos de un día",
      detail:
        `Las ${n} imágenes abarcan solo ${humanDuration(spanMs)} (${stats.first} → ${stats.last}) de un despliegue de ${durationDays} días. ` +
        "O la cámara dejó de funcionar ese mismo día, o el reloj se reinició repetidamente.",
      action: "Revisar en la galería si las fotos son consecutivas (un evento) o muestran días distintos.",
      evidence: { examples: [example(timed[0].img, firstMs), example(timed[n - 1].img, lastMs)] },
    });
  }

  if (!install) {
    findings.push({
      check: "window_missing",
      severity: "warn",
      title: "Sin fecha de instalación",
      detail: "El despliegue no tiene fecha de instalación (ODK), así que no se puede comprobar si las fechas de las imágenes son coherentes.",
      action: "Vincular el formulario ODK de instalación o ingresar la fecha manualmente.",
      evidence: {},
    });
    return { stats, findings };
  }

  // -- Window membership (local days, ±tolerance).
  const winStart = dayStartMs(install) - WINDOW_TOLERANCE_DAYS * DAY_MS;
  const winEnd = retrieve ? dayStartMs(retrieve) + (1 + WINDOW_TOLERANCE_DAYS) * DAY_MS : null;
  const todayEnd = dayStartMs(opts.today) + DAY_MS;
  const before = timed.filter((t) => t.ms < winStart);
  const after = timed.filter((t) => winEnd != null && t.ms >= winEnd);
  const future = timed.filter((t) => t.ms >= todayEnd);
  const outside = before.length + after.length;
  stats.outsideWindow = outside;

  const startOffsetDays = dayDiff(install, firstDay);
  let explainedShift = false;

  if (outside / n >= 0.5) {
    explainedShift = true;
    const swapped = swapDayMonth(install);
    const swapHit = swapped != null && Math.abs(dayDiff(swapped, firstDay)) <= 2;
    const yearOff = Math.round(startOffsetDays / 365);
    const isYearShift = yearOff !== 0 && Math.abs(startOffsetDays - yearOff * 365) <= 3;
    const isReset = Number(firstDay.slice(0, 4)) < 2020;

    let check, title, cause;
    if (swapHit) {
      check = "date_day_month_swapped";
      title = "Día y mes intercambiados en el reloj de la cámara";
      cause =
        `La instalación fue el ${install} pero la primera imagen dice ${firstDay} — exactamente la fecha con día y mes invertidos ` +
        `(${install.slice(8, 10)}/${install.slice(5, 7)} leído como ${install.slice(5, 7)}/${install.slice(8, 10)}). ` +
        "El reloj se configuró en formato MM/DD en lugar de DD/MM.";
    } else if (isReset) {
      check = "clock_reset";
      title = "Reloj reiniciado a fecha de fábrica";
      cause = `La primera imagen dice ${firstDay}: la cámara perdió la hora (batería agotada o cambiada) y volvió a su fecha por defecto.`;
    } else if (isYearShift) {
      check = "clock_wrong_year";
      title = "Año incorrecto en el reloj de la cámara";
      cause = `Las imágenes están desplazadas ${startOffsetDays} días (≈${yearOff} año${Math.abs(yearOff) > 1 ? "s" : ""}): mes y día coinciden con la instalación pero el año no.`;
    } else {
      check = "clock_offset";
      title = "Reloj de la cámara desfasado";
      cause = `La primera imagen (${firstDay}) está ${Math.abs(startOffsetDays)} días ${startOffsetDays > 0 ? "después" : "antes"} de la instalación (${install}).`;
    }

    findings.push({
      check,
      severity: "error",
      title,
      detail:
        `${outside} de ${n} imágenes caen fuera de la ventana de instalación ${install} → ${retrieve ?? "(sin recuperar)"}` +
        (future.length ? `, y ${future.length} tienen fecha futura` : "") +
        `. ${cause}`,
      action:
        "Confirmar con la primera foto de la galería (foto de instalación) y corregir las fechas: todas las imágenes están desplazadas el mismo intervalo, " +
        `así que restar ${startOffsetDays} días recupera la fecha real si la primera foto es la de instalación. Revisar el reloj de la cámara en campo.`,
      evidence: {
        install,
        firstImageDay: firstDay,
        swappedInstall: swapped,
        suggestedShiftDays: -startOffsetDays,
        before: before.length,
        after: after.length,
        future: future.length,
        examples: [example(timed[0].img, firstMs), example(timed[n - 1].img, lastMs)],
      },
    });
  } else if (outside > 0) {
    // -- A few strays: individual images, not the whole clock.
    const strays = [...before, ...after];
    findings.push({
      check: "outlier_timestamps",
      severity: "warn",
      title: `${outside} imagen${outside > 1 ? "es" : ""} con fecha fuera de la ventana`,
      detail:
        `La mayoría de las imágenes están bien, pero ${outside} de ${n} tienen fechas fuera de ${install} → ${retrieve ?? "(sin recuperar)"}` +
        (before.length ? ` (${before.length} antes, la más temprana ${localStamp(before[0].ms)})` : "") +
        (after.length ? ` (${after.length} después, la más tardía ${localStamp(after[after.length - 1].ms)})` : "") +
        ". Suelen ser fotos de otra tarjeta/cámara mezcladas, o un reinicio puntual del reloj.",
      action: "Abrir cada imagen listada y decidir si pertenece a este despliegue; si no, eliminarla o moverla.",
      evidence: {
        before: before.length,
        after: after.length,
        examples: strays.slice(0, MAX_EXAMPLES).map((t) => example(t.img, t.ms)),
      },
    });
  }

  if (!explainedShift && future.length > 0) {
    findings.push({
      check: "future_timestamps",
      severity: "error",
      title: "Imágenes con fecha futura",
      detail: `${future.length} imágenes tienen fecha posterior a hoy (${opts.today}).`,
      action: "Revisar el reloj de la cámara y corregir las fechas.",
      evidence: { examples: future.slice(0, MAX_EXAMPLES).map((t) => example(t.img, t.ms)) },
    });
  }

  // -- Coverage: late start / early stop (only meaningful when the clock looks right).
  if (!burst && !explainedShift) {
    if (startOffsetDays >= LATE_START_DAYS) {
      findings.push({
        check: "late_start",
        severity: startOffsetDays >= 7 ? "warn" : "info",
        title: `Primera imagen ${startOffsetDays} días después de la instalación`,
        detail:
          `Instalada el ${install}, pero la primera imagen es del ${stats.first}. Normalmente la cámara registra la foto de instalación el mismo día; ` +
          "puede ser un reloj desfasado unos días, una cámara que no se encendió, o simplemente sin disparos.",
      action: "Ver si la primera imagen es una foto de instalación (personal de campo, tablilla): si lo es, el reloj está desfasado.",
        evidence: { lateDays: startOffsetDays, examples: [example(timed[0].img, firstMs)] },
      });
    }
    if (retrieve) {
      const lastDay = localDay(lastMs);
      const earlyDays = dayDiff(lastDay, retrieve);
      if (earlyDays >= EARLY_STOP_DAYS && retrieve <= opts.today) {
        findings.push({
          check: "early_stop",
          severity: "info",
          title: `Última imagen ${earlyDays} días antes de la recuperación`,
          detail:
            `Recuperada el ${retrieve}, pero la última imagen es del ${stats.last}. Probable batería agotada o memoria llena; ` +
            `el esfuerzo de muestreo real es ~${Math.max(0, (durationDays ?? 0) - earlyDays)} de ${durationDays} días.`,
          action: "Confirmar con las notas de campo de la recuperación; registrar la ventana válida (QA) para que el esfuerzo se calcule bien.",
          evidence: { earlyDays, examples: [example(timed[n - 1].img, lastMs)] },
        });
      }
    }
  }

  // -- Filename HHMMSS vs stored time-of-day (dateless camera names carry the clock time).
  const fnRe = /^(\d{2})(\d{2})(\d{2})_\d+\./;
  const mismatched = [];
  for (const t of timed) {
    const m = fnRe.exec(t.img.filename ?? "");
    if (!m) continue;
    const fs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const local = new Date(t.ms + ECUADOR_OFFSET_MS);
    const ls = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
    let diff = Math.abs(fs - ls);
    diff = Math.min(diff, 86400 - diff);
    if (diff > FILENAME_TIME_TOLERANCE_S) mismatched.push(t);
  }
  if (mismatched.length > 0) {
    findings.push({
      check: "filename_time_mismatch",
      severity: "warn",
      title: "La hora del nombre de archivo no coincide con la fecha guardada",
      detail:
        `${mismatched.length} imagen${mismatched.length > 1 ? "es" : ""} tienen una hora en el nombre (HHMMSS) distinta de la hora registrada. ` +
        "La fecha del archivo se alteró después de la captura (editado, re-guardado o copiado sin conservar fechas).",
      action: "Revisar estas imágenes; la hora del nombre es la de la cámara.",
      evidence: { examples: mismatched.slice(0, MAX_EXAMPLES).map((t) => example(t.img, t.ms)) },
    });
  }

  // -- QA window sanity (reviewer-tagged valid_start/valid_end).
  if (dep.validStart && dep.validEnd) {
    if (dep.validStart > dep.validEnd) {
      findings.push({
        check: "qa_window_inverted",
        severity: "warn",
        title: "Ventana válida (QA) invertida",
        detail: `Inicio válido ${dep.validStart} es posterior al fin válido ${dep.validEnd}.`,
        action: "Corregir la ventana válida en la sección QA del despliegue.",
        evidence: {},
      });
    } else if (dep.validStart === dep.validEnd && !burst) {
      findings.push({
        check: "qa_window_zero",
        severity: "warn",
        title: "Ventana válida (QA) de duración cero",
        detail: `Inicio y fin válidos son el mismo instante (${dep.validStart}); el despliegue no aporta esfuerzo de muestreo.`,
        action: "Revisar las fotos etiquetadas como instalación/recuperación.",
        evidence: {},
      });
    }
  }

  return { stats, findings };
}

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

/** Highest severity across findings, or null. */
export function worstSeverity(findings) {
  let best = null;
  for (const f of findings) {
    if (best == null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[best]) best = f.severity;
  }
  return best;
}

// ---------------------------------------------------------------------------
// DB gather + main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
/** "YYYY-MM-DD[ HH:MM]" → "DD/MM/YYYY[ HH:MM]" for Spanish prose. */
export function esDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(String(s ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]}` : (s ?? "—");
}

// AUDIO — recorder files. Filenames are `SERIAL_YYYYMMDD_HHMMSS.(wav|flac)`:
// recorder serial + Ecuador-local wall clock (verified on prod 2026-11-09:
// every one of 562,266 names parses). Parsed through Date.UTC, never a local Date.
// ---------------------------------------------------------------------------

const AUDIO_NAME_RE = /^([A-Za-z0-9]+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\./;
/** Below this a recording is a stub, not a minute of audio. */
export const AUDIO_TINY_BYTES = 10_000;
/** Consecutive in-window recordings further apart than this = a gap. */
export const AUDIO_GAP_MS = DAY_MS;
/** Deployment-wide BirdNET identifications needed before the clock-profile check speaks. */
export const AUDIO_CLOCK_MIN_IDS = 200;

/** Parse a recorder filename → { serial, ms (true instant) } or null. */
export function parseAudioName(filename) {
  const m = AUDIO_NAME_RE.exec(filename ?? "");
  if (!m) return null;
  const [, serial, y, mo, d, h, mi, se] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const check = new Date(wall);
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23) return null;
  return { serial, ms: wall - ECUADOR_OFFSET_MS };
}

function normalize24(v) {
  const s = v.reduce((a, b) => a + b, 0);
  return s > 0 ? v.map((x) => x / s) : v.slice();
}

function pearson(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}

/**
 * Compare a deployment's 24-h BirdNET activity profile against the project-wide
 * profile at every circular lag. A recorder whose clock is in the wrong zone
 * matches the reference only after shifting by that many hours.
 * Returns { lag, best, atZero } (lag in hours: + = this recorder's labels run late).
 */
export function clockLag(hourCounts, reference) {
  const p = normalize24(hourCounts);
  let best = -2, lag = 0, atZero = 0;
  for (let L = -11; L <= 12; L++) {
    const shifted = reference.map((_, i) => reference[(((i - L) % 24) + 24) % 24]);
    const c = pearson(p, shifted);
    if (L === 0) atZero = c;
    if (c > best) { best = c; lag = L; }
  }
  return { lag, best: Math.round(best * 100) / 100, atZero: Math.round(atZero * 100) / 100 };
}

function audioExample(f) {
  const parsed = parseAudioName(f.filename);
  return { fileId: f.id, filename: f.filename, local: parsed ? localStamp(parsed.ms) : null };
}

/**
 * @param dep  { id, name, dateStart, dateEnd }
 * @param files  [{ id, filename, fileSize }]
 * @param opts  { today, hourCounts?: number[24], referenceProfile?: number[24] }
 */
export function analyzeAudioDeployment(dep, files, opts) {
  const findings = [];
  const install = dep.dateStart ? dep.dateStart.slice(0, 10) : null;
  const retrieve = dep.dateEnd ? dep.dateEnd.slice(0, 10) : null;
  const durationDays = install && retrieve ? dayDiff(install, retrieve) : null;

  const parsed = [];
  const unparsed = [];
  for (const f of files) {
    const p = parseAudioName(f.filename);
    if (p) parsed.push({ f, ...p });
    else unparsed.push(f);
  }
  parsed.sort((a, b) => a.ms - b.ms || a.f.id - b.f.id);
  const n = parsed.length;

  const stats = {
    files: files.length,
    install,
    retrieve,
    durationDays,
    first: n ? localStamp(parsed[0].ms) : null,
    last: n ? localStamp(parsed[n - 1].ms) : null,
    activeDays: new Set(parsed.map((p) => localDay(p.ms))).size,
    serials: {},
    scheduleMinutes: null,
    clock: null,
    dayCounts: {},
  };
  for (const p of parsed) {
    const day = localDay(p.ms);
    stats.dayCounts[day] = (stats.dayCounts[day] ?? 0) + 1;
    stats.serials[p.serial] = (stats.serials[p.serial] ?? 0) + 1;
  }
  if (!files.length) return { stats, findings };

  if (unparsed.length) {
    findings.push({
      check: "audio_unparsed_names",
      severity: "warn",
      title: `${unparsed.length} archivo${unparsed.length > 1 ? "s" : ""} sin fecha en el nombre`,
      detail: "El nombre no sigue el formato SERIE_AAAAMMDD_HHMMSS de la grabadora, así que no se pueden ubicar en el tiempo.",
      action: "Revisar si son archivos renombrados o de otro equipo.",
      evidence: { examples: unparsed.slice(0, MAX_EXAMPLES).map(audioExample) },
    });
  }
  if (!n) return { stats, findings };

  // -- More than one recorder in the folder.
  const serialEntries = Object.entries(stats.serials).sort((a, b) => b[1] - a[1]);
  if (serialEntries.length > 1) {
    const [major] = serialEntries[0];
    const minority = parsed.filter((p) => p.serial !== major);
    findings.push({
      check: "audio_mixed_recorders",
      severity: "error",
      title: "Archivos de más de una grabadora",
      detail:
        `La mayoría de los archivos (${serialEntries[0][1]}) son de la grabadora ${major}, pero ` +
        serialEntries.slice(1).map(([s, c]) => `${c} ${c > 1 ? "son" : "es"} de la ${s}`).join(", ") +
        ". Probablemente se mezclaron tarjetas SD; las detecciones de esos archivos quedan asignadas al sitio equivocado.",
      action: "Comprobar a qué despliegue pertenecen esos archivos en Drive y moverlos.",
      evidence: { majority: major, examples: minority.slice(0, MAX_EXAMPLES).map((p) => audioExample(p.f)) },
    });
  }

  // -- Duplicates and stubs.
  const byName = new Map();
  for (const f of files) byName.set(f.filename, (byName.get(f.filename) ?? 0) + 1);
  const dupNames = [...byName.entries()].filter(([, c]) => c > 1);
  if (dupNames.length) {
    findings.push({
      check: "audio_duplicate_files",
      severity: "warn",
      title: `${dupNames.length} grabaci${dupNames.length > 1 ? "ones subidas" : "ón subida"} dos veces`,
      detail: "El mismo archivo aparece más de una vez. BirdNET cuenta sus detecciones por duplicado y las horas de grabación quedan infladas.",
      action: "Eliminar los duplicados en Drive y volver a sincronizar.",
      evidence: { examples: dupNames.slice(0, MAX_EXAMPLES).map(([name]) => ({ fileId: null, filename: name, local: null })) },
    });
  }
  const tiny = files.filter((f) => f.fileSize != null && f.fileSize < AUDIO_TINY_BYTES);
  if (tiny.length) {
    findings.push({
      check: "audio_tiny_files",
      severity: "warn",
      title: `${tiny.length} archivo${tiny.length > 1 ? "s" : ""} casi vacío${tiny.length > 1 ? "s" : ""}`,
      detail: "Pesan menos de 10 KB: una grabación de un minuto pesa varios MB. Suelen ser archivos cortados o corruptos.",
      action: "Revisar si el archivo original en la tarjeta está completo.",
      evidence: { examples: tiny.slice(0, MAX_EXAMPLES).map(audioExample) },
    });
  }

  if (!install) {
    findings.push({
      check: "window_missing",
      severity: "warn",
      title: "Sin fecha de instalación",
      detail: "Sin fecha de instalación (ODK) no se puede comprobar si las grabaciones son del período correcto.",
      action: "Vincular el formulario ODK de instalación.",
      evidence: {},
    });
    return { stats, findings };
  }

  const winStart = dayStartMs(install) - WINDOW_TOLERANCE_DAYS * DAY_MS;
  const winEnd = retrieve ? dayStartMs(retrieve) + (1 + WINDOW_TOLERANCE_DAYS) * DAY_MS : null;
  const before = parsed.filter((p) => p.ms < winStart);
  const after = parsed.filter((p) => winEnd != null && p.ms >= winEnd);
  const inside = parsed.filter((p) => p.ms >= winStart && (winEnd == null || p.ms < winEnd));
  stats.before = before.length;
  stats.after = after.length;

  if (before.length) {
    findings.push({
      check: "audio_before_install",
      severity: "warn",
      title: `${before.length} grabaci${before.length > 1 ? "ones anteriores" : "ón anterior"} a la instalación`,
      detail:
        `La instalación fue el ${esDate(install)}, pero hay grabaciones desde el ${esDate(localStamp(before[0].ms))}. ` +
        "Suelen ser pruebas de la grabadora antes de salir al campo; el modelo de ocupación ya las descarta, pero conviene confirmar que la fecha de instalación es la correcta.",
      action: "Si son pruebas, eliminarlas de la carpeta del despliegue. Si no, corregir la fecha de instalación en ODK.",
      evidence: { examples: before.slice(0, 3).map((p) => audioExample(p.f)) },
    });
  }
  if (after.length) {
    const share = after.length / n;
    findings.push({
      check: "audio_after_retrieval",
      severity: share >= 0.1 ? "error" : "warn",
      title: `${after.length} grabaci${after.length > 1 ? "ones posteriores" : "ón posterior"} a la recuperación`,
      detail:
        `La recuperación (ODK) fue el ${esDate(retrieve)}, pero la grabadora siguió grabando hasta el ${esDate(localStamp(after[after.length - 1].ms))} ` +
        `(${Math.round(share * 100)}% de los archivos). O la fecha de recuperación está mal, o esos archivos son de otro lugar.`,
      action: "Confirmar la fecha real de recuperación de la grabadora con el equipo de campo y corregir ODK o mover los archivos.",
      evidence: { share: Math.round(share * 1000) / 1000, examples: after.slice(0, 3).map((p) => audioExample(p.f)) },
    });
  }

  // -- Schedule (detection covariate, not an error) + gaps, on in-window files.
  const intervals = new Map();
  const gaps = [];
  for (let i = 1; i < inside.length; i++) {
    const g = inside[i].ms - inside[i - 1].ms;
    const mins = Math.round(g / 60000);
    if (mins > 0) intervals.set(mins, (intervals.get(mins) ?? 0) + 1);
    if (g > AUDIO_GAP_MS) gaps.push({ from: inside[i - 1], to: inside[i], ms: g });
  }
  if (intervals.size) stats.scheduleMinutes = [...intervals.entries()].sort((a, b) => b[1] - a[1])[0][0];

  if (!inside.length) return { stats, findings };
  const firstIn = inside[0].ms;
  const lastIn = inside[inside.length - 1].ms;
  const coveredDays = (lastIn - firstIn) / DAY_MS;

  if (durationDays != null && durationDays >= 7 && coveredDays < 2) {
    findings.push({
      check: "audio_died_early",
      severity: "error",
      title: "La grabadora dejó de grabar casi enseguida",
      detail:
        `Solo hay ${inside.length} grabaciones dentro del despliegue, entre ${esDate(localStamp(firstIn))} y ${esDate(localStamp(lastIn))}, ` +
        `en un despliegue de ${durationDays} días.`,
      action: "Registrar la falla en las notas y excluir el despliegue del análisis de audio si no hay más archivos en la tarjeta.",
      evidence: { examples: [audioExample(inside[0].f), audioExample(inside[inside.length - 1].f)] },
    });
  } else {
    if (gaps.length) {
      gaps.sort((a, b) => b.ms - a.ms);
      const g = gaps[0];
      findings.push({
        check: "audio_gap",
        severity: "warn",
        title: `Hueco de ${humanDuration(g.ms)} sin grabaciones`,
        detail:
          `No hay grabaciones entre ${esDate(localStamp(g.from.ms))} y ${esDate(localStamp(g.to.ms))}` +
          (gaps.length > 1 ? ` (y ${gaps.length - 1} hueco${gaps.length > 2 ? "s" : ""} más de más de 24 h)` : "") +
          ". Si ocupación cuenta esos días como muestreados, se convierten en ausencias falsas.",
        action: "Ver si faltan carpetas en Drive para esas fechas o si la grabadora estuvo apagada.",
        evidence: {
          gaps: gaps.slice(0, 5).map((x) => ({ from: localStamp(x.from.ms), to: localStamp(x.to.ms), hours: Math.round(x.ms / HOUR_MS) })),
          examples: [audioExample(g.from.f), audioExample(g.to.f)],
        },
      });
    }
    if (retrieve && retrieve <= opts.today) {
      const earlyDays = dayDiff(localDay(lastIn), retrieve);
      if (earlyDays >= EARLY_STOP_DAYS) {
        findings.push({
          check: "audio_early_stop",
          severity: "info",
          title: `Última grabación ${earlyDays} días antes de la recuperación`,
          detail: `Recuperada el ${esDate(retrieve)}, pero la última grabación es del ${esDate(localStamp(lastIn))}. Probablemente se agotó la batería o se llenó la tarjeta.`,
          action: "El modelo de ocupación usa la última grabación como fin; basta con confirmarlo en las notas de campo.",
          evidence: { earlyDays, examples: [audioExample(inside[inside.length - 1].f)] },
        });
      }
    }
  }

  // -- Clock zone via the BirdNET daily activity profile.
  if (opts.hourCounts && opts.referenceProfile) {
    const total = opts.hourCounts.reduce((a, b) => a + b, 0);
    if (total >= AUDIO_CLOCK_MIN_IDS) {
      const r = clockLag(opts.hourCounts, opts.referenceProfile);
      const peakHour = opts.hourCounts.indexOf(Math.max(...opts.hourCounts));
      stats.clock = { identifications: total, peakHour, ...r };
      if (Math.abs(r.lag) >= 2 && r.best >= 0.6 && r.best - r.atZero >= 0.25) {
        findings.push({
          check: "audio_clock_zone",
          severity: "warn",
          title: `Reloj posiblemente ${r.lag > 0 ? "adelantado" : "atrasado"} ${Math.abs(r.lag)} h`,
          detail:
            `En el resto del proyecto el coro del amanecer cae entre las 06 y las 09; en esta grabadora el pico de actividad está a las ${String(peakHour).padStart(2, "0")}:00. ` +
            `Su patrón diario coincide con el del proyecto solo si se corre ${Math.abs(r.lag)} h ` +
            `(correlación ${r.best} corrido frente a ${r.atZero} sin correr, sobre ${total.toLocaleString("es")} identificaciones de BirdNET). ` +
            (r.lag === 5 ? "Un adelanto de exactamente 5 h es la firma de un reloj configurado en UTC." : "El reloj probablemente se configuró en otra zona horaria o con la hora equivocada."),
          action: "Revisar la configuración horaria de la grabadora. Si se confirma, las horas de todas las detecciones están desplazadas.",
          evidence: { ...r, peakHour },
        });
      } else if (r.atZero < 0.3) {
        findings.push({
          check: "audio_atypical_daily_pattern",
          severity: "info",
          title: "Patrón horario de actividad atípico",
          detail:
            `La actividad por hora no se parece a la del resto del proyecto (correlación ${r.atZero}) y ningún desplazamiento la explica bien. ` +
            "Puede ser ruido (insectos, lluvia, ranas) que BirdNET confunde con aves, o un reloj inestable.",
          action: "Escuchar algunos clips de las horas con más detecciones.",
          evidence: r,
        });
      }
    }
  }

  return { stats, findings };
}

// ---------------------------------------------------------------------------
// OCCUPANCY READINESS — cross-stream checks a person should clear before the
// next occupancy run. Pure: takes per-deployment facts gathered by scan().
// Coordinates are read to compute distances but NEVER emitted.
// ---------------------------------------------------------------------------

/**
 * Distinct sites closer than this, deployed at the same time, are flagged.
 * Calibrated on prod 2026-11-09: BioChoco packs sites densely by design (median
 * nearest other site 200–250 m; 117 of 147 under 500 m), so 500 m flags the design
 * itself. The same site revisited (V1 vs V2) lands within 115 m in 50 of 52
 * cases — that is the GPS noise floor, and two different sites inside it can't
 * be told apart from one site recorded twice.
 */
export const NEAR_SITE_M = 150;
/** Pairs between NEAR_SITE_M and this are counted (design spacing), not flagged. */
export const DESIGN_SPACING_M = 500;
export const BBOX_PAD_DEG = 0.2;
export const UNVERIFIED_SHARE = 0.5;

export function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
  const y = (bLat - aLat) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

/**
 * @param facts  per deployment: { id, name, status, latitude, longitude, dateStart, dateEnd,
 *   validStart, validEnd, excludedCamera, excludedAudio, hasCamera, hasAudio,
 *   cameraChecks: string[], lastImageDay, lastAudioDay,
 *   uploadCameraCount, videoCount, mlProcessed, dbImages, blanksDeleted,
 *   identifications, unverifiedIdentifications }
 * @returns { deployments: [{ id, name, severity, findings }] }
 */
export function analyzeReadiness(facts, opts) {
  const out = new Map();
  const add = (d, f) => {
    if (!out.has(d.id)) out.set(d.id, { id: d.id, name: d.name, status: d.status, findings: [] });
    out.get(d.id).findings.push(f);
  };
  const withData = facts.filter((d) => d.hasCamera || d.hasAudio);
  let designPairs = 0;

  // -- The same deployment name registered twice: its data is counted twice.
  const byName = new Map();
  for (const d of facts) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  for (const [name, rows] of byName) {
    if (rows.length < 2) continue;
    const withRows = rows.filter((d) => d.hasCamera || d.hasAudio);
    const first = withRows[0] ?? rows[0];
    const parts = rows.map((d) => `id ${d.id} (${d.dbImages ?? 0} imágenes, ${d.audioFiles ?? 0} grabaciones)`);
    const doubled = withRows.length > 1;
    add(first, {
      check: "ready_duplicate_deployment",
      severity: doubled ? "error" : "warn",
      title: `El despliegue ${name} está registrado ${rows.length} veces`,
      detail:
        `Hay ${rows.length} filas con el mismo nombre: ${parts.join("; ")}. ` +
        (doubled
          ? "Más de una tiene datos: las grabaciones o imágenes se cuentan dos veces en ocupación y en los totales por sitio."
          : "Solo una tiene datos, así que no se cuenta nada dos veces, pero la fila vacía aparece como despliegue sin datos y puede recibir datos por error en la próxima sincronización."),
      action: doubled
        ? "Decidir cuál es el registro bueno y eliminar el otro (con sus archivos duplicados) desde la administración."
        : "Eliminar la fila vacía desde la administración de despliegues.",
      evidence: { ids: rows.map((d) => d.id) },
    });
  }
  const coords = withData.filter((d) => d.latitude != null && d.longitude != null);
  const medLat = median(coords.map((d) => d.latitude));
  const medLon = median(coords.map((d) => d.longitude));
  const CLOCK_BROKEN = new Set(["timestamps_collapsed", "date_day_month_swapped", "clock_reset", "clock_wrong_year", "clock_offset", "setup_burst_only"]);

  for (const d of withData) {
    const camChecks = new Set(d.cameraChecks ?? []);

    // -- Camera stopped early but the QA window still says it sampled to retrieval.
    if (d.hasCamera && !d.excludedCamera) {
      if ((camChecks.has("early_stop") || camChecks.has("span_under_one_day")) && !d.validEnd) {
        add(d, {
          check: "ready_dead_days_counted",
          severity: "error",
          title: "Cámara detenida antes de tiempo sin fin de ventana válida",
          detail:
            `La cámara dejó de tomar fotos antes de la recuperación (última imagen ${esDate(d.lastImageDay ?? "—")}), pero el despliegue no tiene «fin válido» en QA. ` +
            "Ocupación cuenta los días sin cámara como días muestreados sin detección: ausencias falsas que bajan la probabilidad de detección y de ocupación.",
          action: "Etiquetar la última foto válida como «recuperación» o ingresar el fin válido en la sección QA.",
          evidence: { lastImageDay: d.lastImageDay, dateEnd: d.dateEnd },
        });
      }
      if (camChecks.has("late_start") && !d.validStart) {
        add(d, {
          check: "ready_late_start_no_window",
          severity: "warn",
          title: "Cámara empezó tarde sin inicio de ventana válida",
          detail: "La primera imagen es varios días posterior a la instalación y no hay «inicio válido» en QA, así que esos días cuentan como muestreados.",
          action: "Confirmar si la cámara estaba funcionando; si no, ingresar el inicio válido.",
          evidence: {},
        });
      }
    }

    // -- Processing coverage: did ML see everything uploaded?
    if (d.hasCamera && !d.excludedCamera && d.uploadCameraCount && ["processed", "verified", "verified_empty"].includes(d.status)) {
      const expected = d.uploadCameraCount - (d.videoCount ?? 0);
      const seen = d.mlProcessed ?? 0;
      if (expected > 0 && seen < 0.9 * expected) {
        add(d, {
          check: "ready_incomplete_processing",
          severity: "error",
          title: `Solo ${seen} de ${expected} imágenes pasaron por el modelo`,
          detail:
            `Drive tiene ${d.uploadCameraCount} archivos de cámara${d.videoCount ? ` (${d.videoCount} videos)` : ""}, pero el procesamiento solo vio ${seen}. ` +
            "Las imágenes no procesadas no tienen detecciones y ocupación las trata como ausencias.",
          action: "Ejecutar el procesamiento incremental del despliegue.",
          evidence: { upload: d.uploadCameraCount, videos: d.videoCount, mlProcessed: seen, dbImages: d.dbImages },
        });
      } else if (d.blanksDeleted > 0 && d.dbImages < 0.9 * expected) {
        add(d, {
          check: "ready_blanks_deleted",
          severity: "info",
          title: `${d.blanksDeleted} imágenes eliminadas como vacías`,
          detail:
            `El procesamiento vio las ${seen} imágenes, y luego la eliminación masiva de vacías borró ${d.blanksDeleted}. ` +
            "Esa eliminación también incluye imágenes con detecciones no verificadas; si alguna tenía un animal, se perdió esa detección.",
          action: "Nada que hacer si se revisaron antes de borrar. Para el futuro, eliminar solo las confirmadas como vacías.",
          evidence: { mlProcessed: seen, blanksDeleted: d.blanksDeleted, dbImages: d.dbImages },
        });
      }
    }

    // -- Unverified identifications on a deployment marked verified.
    if (d.hasCamera && !d.excludedCamera && d.status === "verified" && d.identifications >= 10) {
      const share = d.unverifiedIdentifications / d.identifications;
      if (share > UNVERIFIED_SHARE) {
        add(d, {
          check: "ready_unverified",
          severity: "info",
          title: `${Math.round(share * 100)}% de las identificaciones sin verificar`,
          detail: `${d.unverifiedIdentifications} de ${d.identifications} identificaciones de especie no tienen revisión humana, aunque el despliegue está marcado como verificado.`,
          action: "Revisar las especies raras o inesperadas antes de usarlas en ocupación.",
          evidence: { identifications: d.identifications, unverified: d.unverifiedIdentifications },
        });
      }
    }

    // -- Coordinates.
    if (d.latitude == null || d.longitude == null) {
      add(d, {
        check: "ready_missing_coordinates",
        severity: "error",
        title: "Sin coordenadas",
        detail: "Ocupación descarta los sitios sin coordenadas: no se les pueden asignar covariables ni ubicarlos en el mapa.",
        action: "Completar el sitio en ODK y volver a vincular.",
        evidence: {},
      });
    } else if (medLat != null && (Math.abs(d.latitude - medLat) > BBOX_PAD_DEG || Math.abs(d.longitude - medLon) > BBOX_PAD_DEG)) {
      add(d, {
        check: "ready_implausible_coordinates",
        severity: "error",
        title: "Coordenadas fuera del área de estudio",
        detail: `El sitio está a ${Math.round(distanceM(d.latitude, d.longitude, medLat, medLon) / 1000)} km del centro del proyecto. Probablemente latitud/longitud invertidas, un signo perdido o un error de tipeo.`,
        action: "Revisar las coordenadas del sitio en ODK.",
        evidence: {},
      });
    }

    // -- Camera vs recorder end dates at the same deployment.
    // Stray images after retrieval are already reported by the camera checks;
    // they would otherwise read as "the camera ran on".
    const camOk = d.hasCamera && !d.excludedCamera && ![...camChecks].some((c) => CLOCK_BROKEN.has(c) || c === "outlier_timestamps" || c === "future_timestamps");
    if (camOk && d.hasAudio && !d.excludedAudio && d.lastImageDay && d.lastAudioDay && d.dateEnd) {
      const end = d.dateEnd.slice(0, 10);
      const audioLater = dayDiff(d.lastImageDay, d.lastAudioDay);
      if (audioLater > 3 && dayDiff(end, d.lastAudioDay) > 1) {
        add(d, {
          check: "ready_sensor_dates_disagree",
          severity: "warn",
          title: "La grabadora siguió grabando después que la cámara y que la recuperación",
          detail: `Última imagen ${esDate(d.lastImageDay)}, recuperación (ODK) ${esDate(end)}, última grabación ${esDate(d.lastAudioDay)}. Una de las dos fechas está mal o los sensores se recuperaron en días distintos.`,
          action: "Confirmar con el equipo de campo cuándo se recuperó cada sensor.",
          evidence: { lastImageDay: d.lastImageDay, lastAudioDay: d.lastAudioDay, dateEnd: end },
        });
      } else if (audioLater < -3 && dayDiff(end, d.lastImageDay) > 1) {
        add(d, {
          check: "ready_sensor_dates_disagree",
          severity: "warn",
          title: "La cámara siguió tomando fotos después que la grabadora y que la recuperación",
          detail: `Última grabación ${esDate(d.lastAudioDay)}, recuperación (ODK) ${esDate(end)}, última imagen ${esDate(d.lastImageDay)}.`,
          action: "Confirmar con el equipo de campo cuándo se recuperó cada sensor.",
          evidence: { lastImageDay: d.lastImageDay, lastAudioDay: d.lastAudioDay, dateEnd: end },
        });
      }
    }
  }

  // -- Pairs: different site codes, too close, genuinely overlapping in time.
  const siteCode = (name) => name.slice(0, 7);
  const span = (d) => {
    const s = d.dateStart ? dayMs0(d.dateStart) : null;
    const e = d.dateEnd ? dayMs0(d.dateEnd) : dayMs0(opts.today);
    return s != null && e != null ? [s, e] : null;
  };
  const sameSpot = new Map();
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const key = `${a.latitude},${a.longitude}`;
    if (!sameSpot.has(key)) sameSpot.set(key, []);
    sameSpot.get(key).push(a);
    for (let j = i + 1; j < coords.length; j++) {
      const b = coords[j];
      if (siteCode(a.name) === siteCode(b.name)) continue;
      const sa = span(a), sb = span(b);
      if (!sa || !sb) continue;
      const overlapDays = (Math.min(sa[1], sb[1]) - Math.max(sa[0], sb[0])) / DAY_MS;
      if (overlapDays < 1) continue;
      if (a.name === b.name) continue;
      const dist = distanceM(a.latitude, a.longitude, b.latitude, b.longitude);
      if (dist >= DESIGN_SPACING_M) continue;
      if (dist >= NEAR_SITE_M) {
        designPairs++;
        continue;
      }
      const [first, second] = a.name < b.name ? [a, b] : [b, a];
      add(first, {
        check: "ready_sites_too_close",
        severity: "warn",
        title: `A ${Math.round(dist)} m de ${second.name}, al mismo tiempo`,
        detail:
          `${first.name} y ${second.name} son sitios distintos pero estuvieron instalados a la vez durante ${Math.round(overlapDays)} días a ${Math.round(dist)} m. ` +
          "Esa distancia está dentro del error del GPS: el mismo sitio medido en dos visitas suele diferir hasta ~115 m. O las coordenadas de uno están mal, o son en la práctica el mismo punto y ocupación los cuenta como dos sitios independientes.",
        action: "Verificar las coordenadas de ambos sitios; si son correctas, decidir si se agrupan.",
        evidence: { otherId: second.id, otherName: second.name, distanceM: Math.round(dist), overlapDays: Math.round(overlapDays) },
      });
    }
  }
  for (const group of sameSpot.values()) {
    const codes = new Set(group.map((d) => siteCode(d.name)));
    if (new Set(group.map((d) => d.name)).size < 2) continue;
    if (codes.size < 2) continue;
    const names = group.map((d) => d.name).sort();
    const first = group.find((d) => d.name === names[0]);
    add(first, {
      check: "ready_identical_coordinates",
      severity: "warn",
      title: "Coordenadas idénticas a las de otro sitio",
      detail: `${names.join(", ")} tienen exactamente las mismas coordenadas siendo sitios distintos. Lo más probable es que se copiaron las de otro sitio.`,
      action: "Corregir las coordenadas en ODK.",
      evidence: { others: names.slice(1) },
    });
  }

  const deployments = [...out.values()].map((d) => ({ ...d, severity: worstSeverity(d.findings) }));
  deployments.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.name.localeCompare(b.name));
  return { deployments, designPairs };
}

function dayMs0(dateStr) {
  const t = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

function tally(list, excludedKey) {
  const bySeverity = { error: 0, warn: 0, info: 0 };
  const byCheck = {};
  for (const d of list) {
    if (excludedKey && d[excludedKey]) continue;
    bySeverity[d.severity]++;
    for (const f of d.findings) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  }
  return { bySeverity, byCheck };
}

export function scan(db, { projectName = "BioChoco", today }) {
  const project = db.prepare("SELECT id, name FROM ct_projects WHERE name = ?").get(projectName);
  if (!project) throw new Error(`Camera-trap project not found: ${projectName}`);

  const deps = db
    .prepare(
      `SELECT id, name, status, date_start AS dateStart, date_end AS dateEnd,
              valid_start AS validStart, valid_end AS validEnd,
              excluded_camera AS excludedCamera, excluded_audio AS excludedAudio,
              field_notes AS fieldNotes, qa_notes AS qaNotes,
              total_images AS totalImages, total_videos AS totalVideos,
              latitude, longitude, upload_camera_count AS uploadCameraCount
         FROM biochoco_deployments
        WHERE ct_project_id = ? AND is_external = 0
        ORDER BY name`,
    )
    .all(project.id);

  const imgStmt = db.prepare(
    `SELECT id, filename, exif_timestamp AS exifTimestamp, file_modified AS fileModified
       FROM biochoco_images
      WHERE deployment_id = ? AND video_id IS NULL`,
  );
  const audioStmt = db.prepare(
    `SELECT id, filename, file_size AS fileSize FROM audio_files WHERE deployment_id = ?`,
  );
  const videoCountStmt = db.prepare(`SELECT count(*) AS n FROM biochoco_videos WHERE deployment_id = ?`);
  const mlStmt = db.prepare(
    `SELECT id, job_type AS jobType, processed_images AS processed FROM biochoco_processing_jobs
      WHERE deployment_id = ? AND status = 'completed' AND job_type IN ('ml', 'ml_incremental')`,
  );
  const idStmt = db.prepare(
    `SELECT count(*) AS total, sum(CASE WHEN i.verification_status = 'unverified' THEN 1 ELSE 0 END) AS unverified
       FROM biochoco_identifications i
       JOIN biochoco_detections d ON d.id = i.detection_id
       JOIN biochoco_images im ON im.id = d.image_id
      WHERE im.deployment_id = ?`,
  );

  // Bulk "delete blanks" events carry the ML job id → per-deployment deletions.
  const blanksByJob = new Map();
  for (const e of db.prepare(`SELECT details FROM system_events WHERE event_type = 'bulk_delete_blanks'`).all()) {
    try {
      const det = JSON.parse(e.details ?? "{}");
      if (det.jobId != null) blanksByJob.set(det.jobId, (blanksByJob.get(det.jobId) ?? 0) + (det.deleted ?? 0));
    } catch {
      /* malformed details — ignore */
    }
  }

  // BirdNET hourly profile per deployment (file start hour; clips are ≤60 s).
  const hourRows = db
    .prepare(
      `SELECT f.deployment_id AS dep, f.filename AS fn, count(*) AS n
         FROM audio_identifications i
         JOIN audio_detections a ON a.id = i.audio_detection_id
         JOIN audio_files f ON f.id = a.audio_file_id
        WHERE coalesce(i.confidence, 0) >= 0.5
        GROUP BY f.id`,
    )
    .all();
  const hourCounts = new Map();
  for (const r of hourRows) {
    const p = parseAudioName(r.fn);
    if (!p) continue;
    const h = new Date(p.ms + ECUADOR_OFFSET_MS).getUTCHours();
    if (!hourCounts.has(r.dep)) hourCounts.set(r.dep, Array(24).fill(0));
    hourCounts.get(r.dep)[h] += r.n;
  }
  const projectIds = new Set(deps.map((d) => d.id));
  const ref = Array(24).fill(0);
  for (const [dep, v] of hourCounts) {
    if (!projectIds.has(dep)) continue;
    normalize24(v).forEach((x, i) => (ref[i] += x));
  }
  const referenceProfile = normalize24(ref);

  const deployments = [];
  const audioDeployments = [];
  const facts = [];
  let scanned = 0, withImages = 0, withAudio = 0;
  for (const d of deps) {
    const imgs = imgStmt.all(d.id);
    const files = audioStmt.all(d.id);
    scanned++;
    if (imgs.length) withImages++;
    if (files.length) withAudio++;

    const cam = analyzeDeployment(d, imgs, { today });
    if (cam.findings.length) {
      deployments.push({
        id: d.id, name: d.name, status: d.status, excludedCamera: !!d.excludedCamera,
        fieldNotes: d.fieldNotes ?? null, qaNotes: d.qaNotes ?? null,
        validStart: d.validStart ?? null, validEnd: d.validEnd ?? null,
        severity: worstSeverity(cam.findings), stats: cam.stats, findings: cam.findings,
      });
    }

    const aud = analyzeAudioDeployment(d, files, { today, hourCounts: hourCounts.get(d.id), referenceProfile });
    if (aud.findings.length) {
      audioDeployments.push({
        id: d.id, name: d.name, status: d.status, excludedAudio: !!d.excludedAudio,
        fieldNotes: d.fieldNotes ?? null, qaNotes: d.qaNotes ?? null,
        severity: worstSeverity(aud.findings), stats: aud.stats, findings: aud.findings,
      });
    }

    const jobs = mlStmt.all(d.id);
    const fullMax = Math.max(0, ...jobs.filter((j) => j.jobType === "ml").map((j) => j.processed));
    const incr = jobs.filter((j) => j.jobType === "ml_incremental").reduce((s, j) => s + j.processed, 0);
    const ids = imgs.length ? idStmt.get(d.id) : { total: 0, unverified: 0 };
    const camDays = Object.keys(cam.stats.dayCounts ?? {}).sort();
    const audDays = Object.keys(aud.stats.dayCounts ?? {}).sort();
    facts.push({
      id: d.id, name: d.name, status: d.status,
      latitude: d.latitude, longitude: d.longitude,
      dateStart: d.dateStart, dateEnd: d.dateEnd, validStart: d.validStart, validEnd: d.validEnd,
      excludedCamera: !!d.excludedCamera, excludedAudio: !!d.excludedAudio,
      hasCamera: imgs.length > 0, hasAudio: files.length > 0, audioFiles: files.length,
      cameraChecks: cam.findings.map((f) => f.check),
      lastImageDay: camDays.at(-1) ?? null, lastAudioDay: audDays.at(-1) ?? null,
      uploadCameraCount: d.uploadCameraCount, videoCount: videoCountStmt.get(d.id).n,
      mlProcessed: fullMax + incr, dbImages: imgs.length,
      blanksDeleted: jobs.reduce((s, j) => s + (blanksByJob.get(j.id) ?? 0), 0),
      identifications: ids.total ?? 0, unverifiedIdentifications: ids.unverified ?? 0,
    });
  }

  const order = (key) => (a, b) =>
    Number(a[key]) - Number(b[key]) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.name.localeCompare(b.name);
  deployments.sort(order("excludedCamera"));
  audioDeployments.sort(order("excludedAudio"));

  const readiness = analyzeReadiness(facts, { today });

  const cameraTally = tally(deployments, "excludedCamera");
  const audioTally = tally(audioDeployments, "excludedAudio");
  const schedules = {};
  // Schedule distribution across ALL audio deployments (not only flagged ones).
  for (const d of deps) {
    const files = audioStmt.all(d.id);
    if (!files.length || d.excludedAudio) continue;
    const { stats } = analyzeAudioDeployment({ ...d }, files, { today });
    if (stats.scheduleMinutes != null) schedules[stats.scheduleMinutes] = (schedules[stats.scheduleMinutes] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    today,
    project: project.name,
    totals: {
      deployments: scanned,
      withImages,
      flagged: deployments.filter((d) => !d.excludedCamera).length,
      flaggedExcluded: deployments.filter((d) => d.excludedCamera).length,
      ...cameraTally,
    },
    deployments,
    audio: {
      totals: {
        withAudio,
        flagged: audioDeployments.filter((d) => !d.excludedAudio).length,
        flaggedExcluded: audioDeployments.filter((d) => d.excludedAudio).length,
        excluded: deps.filter((d) => d.excludedAudio && audioStmt.all(d.id).length).map((d) => d.name),
        scheduleMinutes: schedules,
        referenceProfile: referenceProfile.map((x) => Math.round(x * 1000) / 1000),
        ...audioTally,
      },
      deployments: audioDeployments,
    },
    readiness: {
      totals: { flagged: readiness.deployments.length, designPairs: readiness.designPairs, nearSiteM: NEAR_SITE_M, designSpacingM: DESIGN_SPACING_M, ...tally(readiness.deployments) },
      deployments: readiness.deployments,
    },
  };
}

function main() {
  const require = createRequire(`${process.cwd()}/`);
  const Database = require("better-sqlite3");
  const dbPath = process.env.ANOMALY_DB || "data/portal.db";
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const today = process.env.ANOMALY_TODAY || localDay(Date.now());
  const snapshot = scan(db, { projectName: process.env.ANOMALY_PROJECT || "BioChoco", today });
  process.stdout.write(JSON.stringify(snapshot, null, 1) + "\n");
  db.close();
}

if (!process.env.VITEST) main();
