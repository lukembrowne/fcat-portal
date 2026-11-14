#!/usr/bin/env node
/**
 * Render a biochoco-anomaly-scan snapshot as a self-contained Spanish HTML
 * report with clickable links to each deployment and example image.
 *
 *   node scripts/render-anomaly-report.mjs <snapshot.json> \
 *     [--annotations notes.json] [--previous prev-snapshot.json] \
 *     [--base https://portal.fcat-ecuador.org] [--out report.html]
 *
 * annotations.json (written by Claude in the skill's judgment step):
 *   { "summary": ["frase 1", "frase 2"],
 *     "notes": { "POT-012_V1": "Texto que explica/prioriza este caso" } }
 *
 * The output has no <!doctype>/<html> wrapper: it is published as a claude.ai
 * Artifact, which supplies the document skeleton.
 *
 * Runs on the host — it reads JSON only, never the database.
 */

import { readFileSync, writeFileSync } from "node:fs";

const SEVERITY = {
  error: { label: "Revisar primero", short: "Error", blurb: "La fecha u hora de las imágenes está mal. Las detecciones de estos despliegues tienen tiempos falsos hasta corregirlas." },
  warn: { label: "Revisar", short: "Advertencia", blurb: "Algo no cuadra en parte de las imágenes o en la ventana del despliegue." },
  info: { label: "Cobertura", short: "Info", blurb: "Las fechas parecen correctas, pero la cámara empezó tarde o se detuvo antes de la recuperación. Afecta el esfuerzo de muestreo." },
};

const AUDIO_SEVERITY = {
  error: { label: "Revisar primero", blurb: "Grabaciones asignadas al sitio o al período equivocado, o una grabadora que casi no grabó." },
  warn: { label: "Revisar", blurb: "Archivos de prueba, duplicados o vacíos, huecos largos, o un reloj que parece estar en otra zona horaria." },
};

const READY_SEVERITY = {
  error: { label: "Corregir antes de modelar", blurb: "Cada uno de estos introduce días muestreados que no lo fueron, sitios contados dos veces o imágenes que el modelo nunca vio." },
  warn: { label: "Revisar", blurb: "Datos que probablemente están bien, pero cuya interpretación cambia los resultados si no lo están." },
  info: { label: "Para tener en cuenta", blurb: "No bloquean el análisis; conviene saberlo al interpretar." },
};

const STATUS_ES = {
  unscanned: "sin escanear", scanned: "escaneado", processing: "procesando", processed: "procesado",
  verified: "verificado", verified_empty: "verificado (vacío)", no_data: "sin datos",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out.positional.push(a);
  }
  return out;
}

const DAY = 86_400_000;
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Timeline strip: the ODK install→retrieve window as a band, one bar per day
 * with images. Days outside the window are drawn in the alarm colour.
 */
export function timelineSvg(stats, { unit = "imágenes" } = {}) {
  const days = Object.keys(stats.dayCounts ?? {}).sort();
  if (!days.length) return "";
  const firstImg = dayMs(days[0]);
  const lastImg = dayMs(days[days.length - 1]);
  const ws = stats.install ? dayMs(stats.install) : null;
  const we = stats.retrieve ? dayMs(stats.retrieve) : null;
  const lo = Math.min(firstImg, ws ?? firstImg) - 2 * DAY;
  const hi = Math.max(lastImg, we ?? lastImg) + 3 * DAY;
  const W = 640, H = 64, padX = 6, top = 8, base = 40;
  const x = (ms) => padX + ((ms - lo) / (hi - lo)) * (W - 2 * padX);
  const max = Math.max(...days.map((d) => stats.dayCounts[d]));
  const barW = Math.max(1.5, Math.min(8, (W - 2 * padX) / ((hi - lo) / DAY) - 1));
  let svg = `<svg class="tl" viewBox="0 0 ${W} ${H}" role="img" aria-label="${unit === "imágenes" ? "Imágenes" : "Grabaciones"} por día frente a la ventana de instalación">`;
  if (ws != null) {
    const x1 = x(ws), x2 = x((we ?? hi - 3 * DAY) + DAY);
    svg += `<rect class="tl-win" x="${x1.toFixed(1)}" y="${top}" width="${Math.max(2, x2 - x1).toFixed(1)}" height="${base - top}" rx="2"/>`;
  }
  for (const d of days) {
    const ms = dayMs(d);
    const inWin = ws != null && ms >= ws - DAY && (we == null || ms <= we + DAY);
    const h = Math.max(3, ((base - top - 2) * Math.sqrt(stats.dayCounts[d])) / Math.sqrt(max));
    svg += `<rect class="${inWin ? "tl-bar" : "tl-bar out"}" x="${(x(ms + DAY / 2) - barW / 2).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${d}: ${stats.dayCounts[d]} ${unit}</title></rect>`;
  }
  svg += `<line class="tl-axis" x1="${padX}" x2="${W - padX}" y1="${base}" y2="${base}"/>`;
  const labels = [];
  if (ws != null) labels.push([ws, `instalación ${stats.install}`, "start"]);
  if (we != null) labels.push([we + DAY, `recuperación ${stats.retrieve}`, "end"]);
  if (ws == null || firstImg < ws - DAY) labels.push([firstImg, days[0], "start"]);
  if (we != null && lastImg > we + DAY) labels.push([lastImg + DAY, days[days.length - 1], "end"]);
  labels.sort((a, b) => a[0] - b[0]);
  let lastRight = -Infinity;
  for (const [ms, text, anchor] of labels) {
    let px = x(ms);
    const approxW = text.length * 5.6;
    const left = anchor === "end" ? px - approxW : px;
    let row = 0;
    if (left < lastRight + 6) row = 1;
    px = Math.min(Math.max(px, anchor === "end" ? approxW + padX : padX), anchor === "end" ? W - padX : W - padX - approxW);
    svg += `<text class="tl-label" x="${px.toFixed(1)}" y="${base + 12 + row * 11}" text-anchor="${anchor}">${esc(text)}</text>`;
    if (row === 0) lastRight = (anchor === "end" ? px : px + approxW);
  }
  return svg + "</svg>";
}

function trendOf(dep, prevMap) {
  if (!prevMap) return null;
  const prev = prevMap.get(dep.name);
  if (!prev) return "nuevo";
  return "persiste";
}

function renderFinding(f, exampleHtml) {
  const ex = (f.evidence?.examples ?? []).map(exampleHtml).join("");
  const shift = f.evidence?.suggestedShiftDays;
  return `<div class="finding sev-${f.severity}">
        <h4><span class="pill sev-${f.severity}">${SEVERITY[f.severity].short}</span> ${esc(f.title)}</h4>
        <p>${esc(f.detail)}</p>
        ${shift ? `<p class="shift">Corrección sugerida: <strong class="mono">${shift > 0 ? "+" : ""}${shift} días</strong> a todas las imágenes (confirmar con la foto de instalación).</p>` : ""}
        <p class="action"><span>Qué hacer:</span> ${esc(f.action)}</p>
        ${ex ? `<details><summary>Ejemplos (${f.evidence.examples.length})</summary><ul class="examples">${ex}</ul></details>` : ""}
      </div>`;
}

function fieldNotesHtml(dep) {
  const html = [dep.fieldNotes && `<p><span>Notas de campo:</span> ${esc(dep.fieldNotes)}</p>`, dep.qaNotes && `<p><span>Notas QA:</span> ${esc(dep.qaNotes)}</p>`]
    .filter(Boolean)
    .join("");
  return html ? `<div class="fieldnotes">${html}</div>` : "";
}

/** "YYYY-MM-DD[ HH:MM]" → "DD/MM/YYYY[ HH:MM]". */
const es = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(String(v ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]}` : v ?? "—";
};

function renderAudioDeployment(dep, ctx) {
  const url = `${ctx.base}/audio/${dep.id}`;
  const note = ctx.audioNotes[dep.name];
  const s = dep.stats;
  const serials = Object.entries(s.serials ?? {}).sort((a, b) => b[1] - a[1]);
  const facts = [
    ["Grabaciones", `${s.files}`],
    ["Primera", s.first ?? "—"],
    ["Última", s.last ?? "—"],
    ["Instalación → recuperación", `${s.install ?? "—"} → ${s.retrieve ?? "—"}`],
    ["Días con grabaciones", `${s.activeDays}${s.durationDays != null ? ` de ${s.durationDays}` : ""}`],
    ["Intervalo", s.scheduleMinutes != null ? `cada ${s.scheduleMinutes} min` : "—"],
    [serials.length > 1 ? "Grabadoras" : "Grabadora", serials.map(([k, v]) => (serials.length > 1 ? `${k} (${v})` : k)).join(", ") || "—"],
  ];
  const example = (e) => `<li><span class="mono">${esc(e.filename)}</span>${e.local ? ` <span class="mono muted">${esc(e.local)}</span>` : ""}</li>`;
  return `<article class="dep sev-${dep.severity}" id="aud-${dep.id}">
    <header>
      <h3><a href="${url}" target="_blank" rel="noopener">${esc(dep.name)}</a></h3>
      <a class="open" href="${url}" target="_blank" rel="noopener">Abrir audio en el portal ↗</a>
    </header>
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    <figure>${timelineSvg(s, { unit: "grabaciones" })}</figure>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join("")}</dl>
    ${dep.findings.map((f) => renderFinding(f, example)).join("")}
    ${fieldNotesHtml(dep)}
  </article>`;
}

function renderReadyDeployment(dep, ctx) {
  const url = `${ctx.base}/camera-trap/${dep.id}`;
  const note = ctx.readyNotes[dep.name];
  const findings = dep.findings
    .map((f) => {
      let extra = "";
      if (f.evidence?.otherId) {
        extra = `<p class="mono small">Otro sitio: <a href="${ctx.base}/camera-trap/${f.evidence.otherId}" target="_blank" rel="noopener">${esc(f.evidence.otherName)}</a> · ${f.evidence.distanceM} m · ${f.evidence.overlapDays} días a la vez</p>`;
      }
      if (f.evidence?.ids?.length > 1) {
        extra = `<p class="mono small">Registros: ${f.evidence.ids.map((id) => `<a href="${ctx.base}/camera-trap/${id}" target="_blank" rel="noopener">id ${id}</a>`).join(" · ")}</p>`;
      }
      return renderFinding(f, () => "").replace(/<\/div>$/, `${extra}</div>`);
    })
    .join("");
  return `<article class="dep sev-${dep.severity}" id="occ-${dep.id}">
    <header>
      <h3><a href="${url}" target="_blank" rel="noopener">${esc(dep.name)}</a></h3>
      <span class="status">${esc(STATUS_ES[dep.status] ?? dep.status ?? "")}</span>
      <a class="open" href="${url}" target="_blank" rel="noopener">Abrir en el portal ↗</a>
    </header>
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    ${findings}
  </article>`;
}

function renderDeployment(dep, ctx) {
  const url = `${ctx.base}/camera-trap/${dep.id}`;
  const note = ctx.notes[dep.name];
  const trend = trendOf(dep, ctx.prevMap);
  const s = dep.stats;
  const facts = [
    ["Imágenes", `${s.images}`],
    ["Primera", s.first ?? "—"],
    ["Última", s.last ?? "—"],
    ["Instalación → recuperación", `${s.install ?? "—"} → ${s.retrieve ?? "—"}`],
    ["Días con imágenes", `${s.activeDays}${s.durationDays != null ? ` de ${s.durationDays}` : ""}`],
  ];
  if (dep.validStart || dep.validEnd) facts.push(["Ventana válida (QA)", `${dep.validStart ?? "—"} → ${dep.validEnd ?? "—"}`]);

  const imageLink = (e) =>
    `<li><a href="${ctx.base}/camera-trap/${dep.id}/preview/${e.imageId}" target="_blank" rel="noopener">${esc(e.filename)}</a> <span class="mono">${esc(e.local ?? "")}</span></li>`;
  const findings = dep.findings.map((f) => renderFinding(f, imageLink)).join("");
  const fieldNotes = fieldNotesHtml(dep);

  return `<article class="dep sev-${dep.severity}" id="dep-${esc(dep.name)}">
    <header>
      <h3><a href="${url}" target="_blank" rel="noopener">${esc(dep.name)}</a></h3>
      <span class="status">${esc(STATUS_ES[dep.status] ?? dep.status)}</span>
      ${trend ? `<span class="trend t-${trend}">${trend}</span>` : ""}
      <a class="open" href="${url}" target="_blank" rel="noopener">Abrir en el portal ↗</a>
    </header>
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    <figure>${timelineSvg(s)}</figure>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join("")}</dl>
    ${findings}
    ${fieldNotes}
  </article>`;
}

export function renderReport(snapshot, { base = "https://portal.fcat-ecuador.org", annotations = {}, previous = null } = {}) {
  const notes = annotations.notes ?? {};
  const prevMap = previous ? new Map(previous.deployments.filter((d) => !d.excludedCamera).map((d) => [d.name, d])) : null;
  const ctx = { base: base.replace(/\/$/, ""), notes, prevMap, audioNotes: annotations.audioNotes ?? {}, readyNotes: annotations.readinessNotes ?? {} };
  const active = snapshot.deployments.filter((d) => !d.excludedCamera);
  const excluded = snapshot.deployments.filter((d) => d.excludedCamera);
  const t = snapshot.totals;

  const resolved = prevMap ? [...prevMap.keys()].filter((n) => !active.some((d) => d.name === n)) : [];

  const index = active
    .map(
      (d) =>
        `<li><a href="#dep-${esc(d.name)}"><span class="dot sev-${d.severity}"></span>${esc(d.name)}</a><span class="idx-what">${esc(d.findings[0].title)}${d.findings.length > 1 ? ` +${d.findings.length - 1}` : ""}</span></li>`,
    )
    .join("");

  const sections = ["error", "warn", "info"]
    .map((sev) => {
      const deps = active.filter((d) => d.severity === sev);
      if (!deps.length) return "";
      return `<section class="group">
        <h3 class="sub"><span class="pill sev-${sev}">${deps.length}</span> ${SEVERITY[sev].label}</h3>
        <p class="blurb">${SEVERITY[sev].blurb}</p>
        ${deps.map((d) => renderDeployment(d, ctx)).join("")}
      </section>`;
    })
    .join("");

  const summary = (annotations.summary ?? []).map((s) => `<li>${esc(s)}</li>`).join("");

  // ---- Audio --------------------------------------------------------------
  const audio = snapshot.audio ?? null;
  const aActive = audio ? audio.deployments.filter((d) => !d.excludedAudio) : [];
  const aCards = aActive.filter((d) => d.severity !== "info");
  // Recorders whose only finding is coverage: one line each, not a card.
  const aCoverage = aActive.filter((d) => d.severity === "info");
  const at = audio?.totals;
  const earlyOf = (d) => d.findings.find((f) => f.check === "audio_early_stop")?.evidence?.earlyDays ?? null;
  const allEarly = aActive.map(earlyOf).filter((x) => x != null).sort((a, b) => a - b);
  const medianEarly = allEarly.length ? allEarly[Math.floor(allEarly.length / 2)] : null;
  const schedules = Object.entries(at?.scheduleMinutes ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const audioIndex = aCards
    .map((d) => `<li><a href="#aud-${d.id}"><span class="dot sev-${d.severity}"></span>${esc(d.name)}</a><span class="idx-what">${esc(d.findings.find((f) => f.severity !== "info").title)}</span></li>`)
    .join("");
  const audioGroups = ["error", "warn"]
    .map((sev) => {
      const deps = aCards.filter((d) => d.severity === sev);
      if (!deps.length) return "";
      return `<section class="group">
        <h3 class="sub"><span class="pill sev-${sev}">${deps.length}</span> ${AUDIO_SEVERITY[sev].label}</h3>
        <p class="blurb">${AUDIO_SEVERITY[sev].blurb}</p>
        ${deps.map((d) => renderAudioDeployment(d, ctx)).join("")}
      </section>`;
    })
    .join("");
  const coverageRows = aCoverage
    .map((d) => {
      const other = d.findings.filter((f) => f.check !== "audio_early_stop");
      const early = earlyOf(d);
      return `<li><a class="mono" href="${ctx.base}/audio/${d.id}" target="_blank" rel="noopener">${esc(d.name)}</a><span class="mono">${early != null ? `${early} d antes` : "—"}</span><span class="muted">${esc([`última ${es(d.stats.last?.slice(0, 10))}`, ...other.map((f) => f.title)].join(" · "))}</span></li>`;
    })
    .join("");
  const audioSection = !audio
    ? ""
    : `<section class="part" id="audio">
    <h2>Audio</h2>
    <p class="blurb">${at.withAudio} despliegues con grabaciones. Los nombres de archivo traen la serie de la grabadora y la hora local, así que se comprueban la grabadora, el período y la continuidad sin abrir el audio.
    Las grabadoras están programadas ${schedules.map(([m, n]) => `cada ${m} min en ${n} despliegues`).join(" y ")}: no es un error, pero el esfuerzo por día cambia con el intervalo y ocupación debe usarlo como covariable de detección.</p>
    ${audioGroups}
    ${aCoverage.length ? `<section class="group">
      <h3 class="sub"><span class="pill sev-info">${aCoverage.length}</span> Solo cobertura</h3>
      <p class="blurb">Grabadoras sin otro problema que haberse detenido antes de la recuperación${medianEarly != null ? ` (mediana: ${medianEarly} días antes, en ${allEarly.length} de ${at.withAudio} despliegues)` : ""}. Ocupación ya toma la última grabación como fin del muestreo.</p>
      <ul class="cov">${coverageRows}</ul>
    </section>` : ""}
  </section>`;

  // ---- Occupancy readiness -------------------------------------------------
  const ready = snapshot.readiness ?? null;
  const rt = ready?.totals;
  const readyIndex = (ready?.deployments ?? [])
    .filter((d) => d.severity !== "info")
    .map((d) => `<li><a href="#occ-${d.id}"><span class="dot sev-${d.severity}"></span>${esc(d.name)}</a><span class="idx-what">${esc(d.findings[0].title)}${d.findings.length > 1 ? ` +${d.findings.length - 1}` : ""}</span></li>`)
    .join("");
  const readyGroups = ["error", "warn", "info"]
    .map((sev) => {
      const deps = (ready?.deployments ?? []).filter((d) => d.severity === sev);
      if (!deps.length) return "";
      return `<section class="group">
        <h3 class="sub"><span class="pill sev-${sev}">${deps.length}</span> ${READY_SEVERITY[sev].label}</h3>
        <p class="blurb">${READY_SEVERITY[sev].blurb}</p>
        ${deps.map((d) => renderReadyDeployment(d, ctx)).join("")}
      </section>`;
    })
    .join("");
  const readySection = !ready
    ? ""
    : `<section class="part" id="ocupacion">
    <h2>Preparación para ocupación</h2>
    <p class="blurb">Comprobaciones que cruzan cámaras, grabadoras, procesamiento y sitios: lo que conviene resolver antes de la próxima corrida de ocupación.
    Los sitios de BioChoco están muy juntos por diseño; ${rt.designPairs} pares de sitios distintos estuvieron instalados a la vez a entre ${rt.nearSiteM} y ${rt.designSpacingM} m. Eso no es un error de datos, pero sí una decisión de análisis (independencia entre sitios). Aquí solo se marcan los pares a menos de ${rt.nearSiteM} m, dentro del error del GPS.</p>
    ${readyGroups}
  </section>`;

  const tallyRow = (label, href, bySev, labels) =>
    `<div class="tally-row"><a href="${href}">${label}</a><span class="pills">${["error", "warn", "info"]
      .filter((k) => labels[k])
      .map((k) => `<span class="pill sev-${k}">${bySev?.[k] ?? 0} ${labels[k]}</span>`)
      .join("")}</span></div>`;

  return `<title>Anomalías de datos BioChoco</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a single reading column; one card per flagged deployment, grouped by severity, each with a window-vs-images timeline strip. */
:root {
  --bg: #f6f7f4; --surface: #ffffff; --fg: #1d2420; --muted: #5d6a62; --line: #d9ded8;
  --accent: #2f6b4f; --win: #dbe9df;
  --err: #b3261e; --err-bg: #fbe9e7; --warn: #8a5a00; --warn-bg: #fdf1d8; --info: #3c5a86; --info-bg: #e7eef8;
  --f-body: "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #121614; --surface: #1a201d; --fg: #e4e9e5; --muted: #9aa69f; --line: #2c3530;
  --accent: #7fc4a0; --win: #22392c;
  --err: #ff8a80; --err-bg: #3a1f1d; --warn: #f0c060; --warn-bg: #362b14; --info: #9db8e8; --info-bg: #1d2738; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #121614; --surface: #1a201d; --fg: #e4e9e5; --muted: #9aa69f; --line: #2c3530;
  --accent: #7fc4a0; --win: #22392c;
  --err: #ff8a80; --err-bg: #3a1f1d; --warn: #f0c060; --warn-bg: #362b14; --info: #9db8e8; --info-bg: #1d2738; color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 var(--f-body); }
main { max-width: 860px; margin: 0 auto; padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 28px; }
h1, h2, h3, h4 { text-wrap: balance; margin: 0; line-height: 1.25; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.25rem; display: flex; align-items: center; gap: 10px; }
p { margin: 0; }
a { color: var(--accent); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mono { font-family: var(--f-mono); font-size: 0.86em; font-variant-numeric: tabular-nums; }
.meta { color: var(--muted); font-size: 0.9rem; }
.pill { display: inline-flex; align-items: center; padding: 1px 9px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em; }
.pill.sev-error { background: var(--err-bg); color: var(--err); }
.pill.sev-warn { background: var(--warn-bg); color: var(--warn); }
.pill.sev-info { background: var(--info-bg); color: var(--info); }
.summary { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; display: grid; gap: 8px; }
.summary ul { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.howto { color: var(--muted); font-size: 0.9rem; display: grid; gap: 6px; }
.legend { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 14px; height: 10px; border-radius: 2px; display: inline-block; }
.index { columns: 2 280px; column-gap: 24px; padding: 0; margin: 0; list-style: none; }
.index li { break-inside: avoid; padding: 3px 0; display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.index a { font-weight: 600; text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.idx-what { color: var(--muted); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.sev-error { background: var(--err); } .dot.sev-warn { background: var(--warn); } .dot.sev-info { background: var(--info); }
.group { display: grid; gap: 14px; }
.blurb { color: var(--muted); max-width: 65ch; }
.dep { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 6px; padding: 16px 20px; display: grid; gap: 12px; min-width: 0; scroll-margin-top: 16px; }
.dep.sev-error { border-left-color: var(--err); } .dep.sev-warn { border-left-color: var(--warn); } .dep.sev-info { border-left-color: var(--info); }
.dep header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.dep h3 { font-size: 1.2rem; font-family: var(--f-mono); font-weight: 500; }
.dep h3 a { color: var(--fg); }
.status { color: var(--muted); font-size: 0.85rem; }
.trend { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
.trend.t-nuevo { color: var(--accent); border-color: var(--accent); }
.open { margin-left: auto; font-weight: 600; font-size: 0.9rem; }
.note { border-left: 3px solid var(--accent); padding-left: 12px; }
figure { margin: 0; overflow-x: auto; }
.tl { width: 100%; min-width: 420px; height: auto; display: block; }
.tl-win { fill: var(--win); }
.tl-bar { fill: var(--accent); } .tl-bar.out { fill: var(--err); }
.tl-axis { stroke: var(--line); stroke-width: 1; }
.tl-label { fill: var(--muted); font: 10px var(--f-mono); }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px 16px; margin: 0; }
.facts div { min-width: 0; }
.facts dt { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.finding { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--line); }
.finding h4 { font-size: 1rem; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.finding p { max-width: 70ch; }
.action span, .fieldnotes span { font-weight: 600; }
.shift { color: var(--fg); }
details summary { cursor: pointer; color: var(--accent); font-size: 0.9rem; }
.examples { margin: 6px 0 0; padding-left: 20px; display: grid; gap: 2px; }
.fieldnotes { background: var(--bg); border-radius: 4px; padding: 10px 12px; font-size: 0.9rem; display: grid; gap: 4px; }
.part { display: grid; gap: 18px; scroll-margin-top: 16px; }
.part > h2 { font-size: 1.45rem; padding-bottom: 6px; border-bottom: 2px solid var(--fg); }
h3.sub { font-size: 1.05rem; display: flex; align-items: center; gap: 8px; }
h3.sub a { color: var(--fg); }
.toc { display: grid; gap: 10px; }
.tally { display: grid; gap: 6px; }
.tally-row { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); align-items: baseline; gap: 8px; }
.tally-row > a { font-weight: 600; text-decoration: none; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.muted { color: var(--muted); }
.small { font-size: 0.82rem; }
.cov { list-style: none; margin: 0; padding: 0; display: grid; border-top: 1px solid var(--line); }
.cov li { display: grid; grid-template-columns: 9em 7em minmax(0, 1fr); gap: 4px 12px; padding: 6px 2px; border-bottom: 1px solid var(--line); align-items: baseline; font-size: 0.92rem; }
@media (max-width: 520px) { .cov li { grid-template-columns: 1fr auto; } .cov li .muted { grid-column: 1 / -1; } }
.foot { color: var(--muted); font-size: 0.85rem; display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 16px; }
</style>
<main>
  <header style="display:grid;gap:8px">
    <h1>Revisión de datos de los despliegues — ${esc(snapshot.project)}</h1>
    <p class="meta">Generado ${esc(es(snapshot.today))} · ${t.deployments} despliegues revisados · ${t.withImages} con imágenes${at ? ` · ${at.withAudio} con grabaciones` : ""}</p>
    <div class="tally">
      ${tallyRow("Cámaras", "#camaras", t.bySeverity, { error: "revisar primero", warn: "revisar", info: "cobertura" })}
      ${at ? tallyRow("Audio", "#audio", at.bySeverity, { error: "revisar primero", warn: "revisar", info: "cobertura" }) : ""}
      ${rt ? tallyRow("Ocupación", "#ocupacion", rt.bySeverity, { error: "corregir", warn: "revisar", info: "info" }) : ""}
      ${prevMap ? `<div class="tally-row"><span class="pill" style="border:1px solid var(--line)">${resolved.length} resueltos desde la revisión anterior</span></div>` : ""}
    </div>
  </header>

  ${summary ? `<section class="summary"><h2>Resumen</h2><ul>${summary}</ul></section>` : ""}

  <section class="howto">
    <p>Cada tarjeta enlaza al despliegue en el portal; las imágenes de ejemplo abren la foto directamente. La franja muestra las imágenes por día:
    <span class="legend"><span class="swatch" style="background:var(--win)"></span>ventana instalación → recuperación (ODK)</span>,
    <span class="legend"><span class="swatch" style="background:var(--accent)"></span>días con imágenes dentro</span>,
    <span class="legend"><span class="swatch" style="background:var(--err)"></span>fuera de la ventana</span>.</p>
    <p>Horas en hora local de Ecuador (UTC−5).</p>
  </section>

  <nav class="toc" aria-label="Índice">
    <h2>Índice</h2>
    <h3 class="sub"><a href="#camaras">Cámaras</a></h3><ul class="index">${index}</ul>
    ${audioIndex ? `<h3 class="sub"><a href="#audio">Audio</a></h3><ul class="index">${audioIndex}</ul>${aCoverage.length ? `<p class="meta">+ ${aCoverage.length} grabadoras con solo cobertura, al final de Audio.</p>` : ""}` : ""}
    ${readyIndex ? `<h3 class="sub"><a href="#ocupacion">Preparación para ocupación</a></h3><ul class="index">${readyIndex}</ul>` : ""}
  </nav>

  <section class="part" id="camaras">
    <h2>Cámaras trampa</h2>
    ${sections}
  </section>

  ${audioSection}

  ${readySection}

  ${resolved.length ? `<section class="group"><h2>Resueltos desde la revisión anterior</h2><p class="blurb">${resolved.map(esc).join(", ")}</p></section>` : ""}

  <footer class="foot">
    ${excluded.length ? `<p>Excluidos del análisis de cámaras (no listados arriba): ${excluded.map((d) => esc(d.name)).join(", ")}.</p>` : ""}
    <p>Fuente: base de datos de producción del portal (solo lectura). Fecha de cada imagen = EXIF si existe, si no la fecha del archivo (reloj de la cámara). Ventana = fechas de instalación y recuperación de ODK, ±1 día de tolerancia.</p>
    ${at?.excluded?.length ? `<p>Excluidos del análisis de audio (no listados arriba): ${at.excluded.map(esc).join(", ")}.</p>` : ""}
    <p>Cámaras — las comprobaciones: reloj que no avanza (≥10 imágenes en menos de 1 h), cámara que solo tomó las fotos de instalación, día/mes intercambiados, reloj desfasado o con año incorrecto, imágenes sueltas fuera de la ventana, fechas futuras, hora del nombre de archivo distinta, inicio tardío (≥3 días) y parada temprana (≥5 días antes de recuperar).</p>
    ${at ? `<p>Audio — hora tomada del nombre del archivo (SERIE_AAAAMMDD_HHMMSS, hora local de la grabadora): grabaciones antes de la instalación o después de la recuperación (±1 día; error si son ≥10 %), más de una grabadora en la carpeta, huecos de más de 24 h, grabadora que dejó de grabar en menos de 2 días, parada temprana (≥5 días), archivos repetidos, archivos de menos de 10 KB, y reloj desfasado según el patrón diario de BirdNET comparado con el del proyecto (desde 200 identificaciones con confianza ≥0,5).</p>` : ""}
    ${rt ? `<p>Ocupación — cámara detenida antes de tiempo sin fin de ventana válida, inicio tardío sin inicio válido, procesamiento incompleto (&lt;90 % de las imágenes subidas pasaron por el modelo), imágenes eliminadas como vacías después del procesamiento, despliegue registrado dos veces, sitios distintos a menos de ${rt.nearSiteM} m instalados a la vez (≥1 día), coordenadas faltantes o fuera del área de estudio (±0,2° de la mediana), coordenadas idénticas entre sitios, fechas finales de cámara y grabadora que no coinciden (&gt;3 días y después de la recuperación), y más de la mitad de las identificaciones sin verificar en un despliegue verificado. El informe no incluye coordenadas.</p>` : ""}
  </footer>
</main>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [snapPath] = args.positional;
  if (!snapPath) {
    console.error("usage: render-anomaly-report.mjs <snapshot.json> [--annotations f] [--previous f] [--base url] [--out f]");
    process.exit(2);
  }
  const snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
  const annotations = args.annotations ? JSON.parse(readFileSync(args.annotations, "utf8")) : {};
  const previous = args.previous ? JSON.parse(readFileSync(args.previous, "utf8")) : null;
  const html = renderReport(snapshot, { base: args.base, annotations, previous });
  if (args.out) {
    writeFileSync(args.out, html);
    console.error(`wrote ${args.out}`);
  } else process.stdout.write(html);
}

if (!process.env.VITEST) main();
