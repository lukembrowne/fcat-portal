/**
 * Self-contained HTML export of the public BioChoco overview.
 *
 *   /public/biochoco-overview/download?lang=es
 *
 * Renders the active snapshot for one language into a single HTML file whose
 * copy matches the live page and whose images (hero, habitat photos, platform
 * screenshots, and any curated camera-trap photos) are inlined as base64 data
 * URIs — so it opens offline with no network calls for imagery. The interactive
 * map degrades to a static note (tiles need a network, as in the original
 * standalone report). Audio clips are linked (absolute URLs); they play online.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { db } from "@/db";
import { images } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { downloadFileToBuffer } from "@/lib/drive-client";
import { getActiveReportSnapshot } from "@/lib/public-report-snapshot";
import { log } from "@/lib/log";
import { TOLERANT_DECODE } from "@/lib/image-decode";
import { CONTENT, DEFAULT_LANG } from "../content";
import { HABITAT, HAB_ORDER } from "../lib/habitat";
import { fmt, spanLabel, tpl } from "../lib/format";
import type { Lang, ReportSnapshot } from "../lib/snapshot-types";

export const dynamic = "force-dynamic";

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

// Domestic animals excluded from the wild-species camera list (matches the page).
const DOMESTIC = new Set([
  "Gallus gallus domesticus",
  "Canis lupus familiaris",
  "Bos taurus",
  "Anas platyrhynchos domesticus",
  "Equus caballus",
  "Felis catus",
  "Sus scrofa domesticus",
]);

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Read a file under public/ and return a base64 data URI (null if missing). */
async function assetDataUri(rel: string, mime = "image/jpeg"): Promise<string | null> {
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "public", rel));
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    log.warn({ err, rel }, "[public-report-download] missing static asset");
    return null;
  }
}

async function loadOriginalBuffer(
  localPath: string | null,
  driveFileId: string | null,
): Promise<Buffer | null> {
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      // fall through to Drive
    }
  }
  if (driveFileId) {
    return await downloadFileToBuffer(driveFileId);
  }
  return null;
}

async function inlineCuratedImages(snapshot: ReportSnapshot): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = snapshot.images.map((i) => i.imageId);
  if (ids.length === 0) return out;

  const rows = await db
    .select({ id: images.id, path: images.path, driveFileId: images.driveFileId })
    .from(images)
    .where(inArray(images.id, ids));

  for (const row of rows) {
    try {
      const original = await loadOriginalBuffer(row.path, row.driveFileId);
      if (!original) continue;
      const jpeg = await sharp(original, { ...TOLERANT_DECODE, limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      out.set(row.id, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
    } catch (err) {
      log.warn({ err, imageId: row.id }, "[public-report-download] failed to inline image");
    }
  }
  return out;
}

interface StaticAssets {
  hero: string | null;
  habitat: Record<string, string | null>;
  gallery: (string | null)[];
}

async function loadStaticAssets(): Promise<StaticAssets> {
  const hero = await assetDataUri("biochoco-overview/hero.jpg");
  const habitat: Record<string, string | null> = {};
  for (const k of HAB_ORDER) {
    habitat[k] = await assetDataUri(`biochoco-overview/habitat/${k}.jpg`);
  }
  // Load in the same order as the gallery array so assets.gallery[i] aligns
  // with c.platform.gallery[i]. Filenames are language-independent.
  const gallery = await Promise.all(
    CONTENT[DEFAULT_LANG].platform.gallery.map((shot) =>
      assetDataUri(`biochoco-overview/gallery/${shot.file}`),
    ),
  );
  return { hero, habitat, gallery };
}

const DESIGN_CSS = `
:root{--parchment:#f4efe3;--paper:#fffdf7;--ink:#2f271b;--ink-soft:#6d6047;--line:#e4dcc9;--forest:#2f6b34;--forest-deep:#22491f;--canopy:#5f9a3f;--gold:#bd8127;--sage:#e7ecdf;--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--parchment);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6}
img{max-width:100%;display:block}
a{color:var(--forest)}
h1,h2,h3{font-family:var(--serif);font-weight:600;line-height:1.14;margin:0}
.wrap{max-width:900px;margin:0 auto;padding:0 24px}
.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12px;font-weight:700;color:var(--forest);margin:0 0 10px}
section{padding:40px 0;border-top:1px solid var(--line)}
.hero{background:var(--forest-deep);color:#fff;padding:0;border:0}
.hero img{width:100%;max-height:52vh;object-fit:cover;object-position:center 42%}
.hero .inner{padding:28px 24px}
.hero h1{font-size:clamp(38px,8vw,72px);margin:0 0 8px}
.hero .sub{font-family:var(--serif);font-size:clamp(18px,3vw,24px);max-width:34ch;color:#eef3e6}
h2{font-size:clamp(24px,4vw,34px);margin-bottom:14px}
.rule{height:3px;width:52px;background:var(--forest);border-radius:2px;margin-bottom:16px}
p{color:var(--ink-soft);max-width:64ch}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.card .num{font-family:var(--serif);color:var(--forest);font-weight:600}
.card .model{font-size:12px;color:var(--gold);font-weight:600;margin:2px 0 8px}
.card h3{font-size:18px;margin:6px 0 4px}
.card p{font-size:14px;margin:0}
.stats{background:var(--forest-deep);color:#fff;border:0}
.stats .eyebrow{color:#a9c891}.stats h2{color:#fff}.stats p{color:#cbdabc}
.stat-grid{display:flex;flex-wrap:wrap;gap:1px;background:rgba(255,255,255,.12);border-radius:12px;overflow:hidden}
.stat{background:var(--forest-deep);padding:18px 16px;flex:1 1 calc(25% - 1px)}
.stat .n{font-family:var(--serif);font-size:32px;font-weight:600;color:#fff}
.stat .l{font-size:13px;color:#c3d5b1}
.stat .s{font-size:11px;color:#8fae76}
.hc{background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.hc img{aspect-ratio:3/2;object-fit:cover;width:100%}
.hc .body{padding:12px 14px}
.hc .nm{font-family:var(--serif);font-weight:600}
.hc .ds{font-size:12px;color:var(--ink-soft)}
.hc .ct{font-size:12px;color:var(--forest);font-weight:600;margin-top:6px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.bars{list-style:none;padding:0;margin:0}
.bars li{display:flex;justify-content:space-between;gap:8px;font-size:14px;padding:3px 0;border-bottom:1px solid var(--line)}
.bars em{color:var(--ink-soft)}
.bars span{font-variant-numeric:tabular-nums;font-weight:600;color:var(--forest-deep)}
.mapnote{background:var(--paper);border:1px dashed var(--line);border-radius:12px;padding:28px;text-align:center;color:var(--ink-soft);font-size:14px}
figure{margin:0}
.shot{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:24px}
.shot .addr{font-size:12px;color:var(--ink-soft);padding:8px 12px;background:#ece5d4;border-bottom:1px solid var(--line)}
.shot .cap{padding:12px 14px}
.shot .cap b{font-family:var(--serif)}
.shot .cap span{font-size:13px;color:var(--ink-soft)}
.list{list-style:none;padding:0;margin:0}
.list li{padding:8px 0;border-bottom:1px solid var(--line)}
.list b{font-family:var(--serif);display:block}
.list span{font-size:14px;color:var(--ink-soft)}
.cta{background:linear-gradient(135deg,var(--forest-deep),var(--forest));color:#fff;border-radius:16px;padding:28px}
.cta h3{color:#fff}.cta p{color:#d3e2c5}
.contacts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}
.contact{background:rgba(255,255,255,.09);border-radius:10px;padding:12px 14px;font-size:13px}
.contact .cn{font-family:var(--serif);font-weight:600;color:#fff}
.contact .cr{color:#a9c891;font-size:12px}
.contact a{color:#fff}
footer{background:#1b3618;color:#bcd0ac;padding:28px 0;font-size:13px}
footer b{color:#fff;font-family:var(--serif)}
@media(max-width:720px){.grid2,.grid3,.two,.contacts,.stat{grid-template-columns:1fr}.stat{flex-basis:calc(50% - 1px)}}
`;

function buildHtml(
  snapshot: ReportSnapshot,
  lang: Lang,
  dataUris: Map<number, string>,
  assets: StaticAssets,
): string {
  const c = CONTENT[lang];
  const s = snapshot.stats;
  const rs = s.retrievedSensors;
  const byType = s.cameraSpeciesByType ?? {};
  const span = spanLabel(s.samplingSpan.start, s.samplingSpan.end, lang);
  const tb = (s.audio.bytes / 1e12).toFixed(2);
  const inField = Math.max(0, s.deploymentCount - s.retrievedCount);
  const publishedDate = new Date(snapshot.generatedAt).toLocaleDateString(
    lang === "es" ? "es-EC" : "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  const statVars = {
    cam: rs.cam,
    audio: rs.audio,
    climate: rs.climate,
    span,
    mammals: byType.mammal ?? 0,
    birds: byType.bird ?? 0,
    tb,
    loggers: s.ibutton.processed,
    conf: s.audioThreshold,
  };
  // Index-coupled to c.stats.tiles (content.ts) and to report-shell.tsx —
  // keep all three arrays in the same order.
  const statValues = [
    s.retrievedCount,
    s.cameraTrapDays,
    s.uploadCounts.camPhotos,
    s.totalDetections ?? 0,
    s.cameraRealSpecies,
    s.audio.files,
    s.audioDetections08 ?? 0,
    s.ibutton.readings,
  ];
  const statTiles = c.stats.tiles
    .map(
      (tile, i) =>
        `<div class="stat"><div class="n">${esc(fmt(statValues[i]))}</div><div class="l">${esc(tile.label)}</div><div class="s">${esc(tpl(tile.sub, statVars))}</div></div>`,
    )
    .join("");

  const objectives = c.learn.objectives
    .map((o) => `<div class="card"><div class="num">${esc(o.num)}</div><h3>${esc(o.title)}</h3><p>${esc(o.body)}</p></div>`)
    .join("");
  const methodCards = c.methods.cards
    .map((m) => `<div class="card"><h3>${esc(m.title)}</h3><div class="model">${esc(m.model)}</div><p>${esc(m.body)}</p></div>`)
    .join("");
  const habCards = HAB_ORDER.map((k) => {
    const count = s.habitatCounts?.[k] ?? 0;
    const word = count === 1 ? c.methods.sitesSampledOne : c.methods.sitesSampledMany;
    const uri = assets.habitat[k];
    const imgTag = uri ? `<img src="${uri}" alt="${esc(HABITAT[k].name[lang])}"/>` : "";
    return `<div class="hc">${imgTag}<div class="body"><div class="nm">${esc(HABITAT[k].name[lang])}</div><div class="ds">${esc(HABITAT[k].description[lang])}</div><div class="ct">${count} ${esc(word)}</div></div></div>`;
  }).join("");

  const camWild = s.cameraTopSpecies.filter((sp) => !DOMESTIC.has(sp.sci)).slice(0, 9);
  const cameraSpecies = camWild
    .map((sp) => {
      const name = lang === "es" ? sp.spanishName || sp.commonName || sp.sci : sp.commonName || sp.sci;
      return `<li><span class="nm">${esc(name)}${name !== sp.sci ? ` <em>${esc(sp.sci)}</em>` : ""}</span><span>${fmt(sp.detections)}</span></li>`;
    })
    .join("");
  const audioSpecies = s.audioTopSpecies
    .slice(0, 9)
    .map((sp) => `<li><em>${esc(sp.sci)}</em><span>${fmt(sp.detections)}</span></li>`)
    .join("");

  const gallery = c.platform.gallery
    .map((shot, i) => {
      const uri = assets.gallery[i];
      const imgTag = uri ? `<img src="${uri}" alt="${esc(shot.title)}"/>` : "";
      return `<figure class="shot"><figcaption class="cap"><b>${esc(shot.title)}</b><br/><span>${esc(shot.caption)}</span></figcaption><div class="addr">${esc(shot.addr)}</div>${imgTag}</figure>`;
    })
    .join("");

  const oppList = c.collaborate.oppList
    .map((it) => `<li><b>${esc(it.title)}</b><span>${esc(it.body)}</span></li>`)
    .join("");

  const contacts = c.contacts
    .map(
      (ct) =>
        `<div class="contact"><div class="cn">${esc(ct.name)}</div><div class="cr">${esc(ct.role)}</div>${
          ct.email ? `<a href="mailto:${esc(ct.email)}">${esc(ct.email)}</a>` : ""
        }</div>`,
    )
    .join("");

  // Bonus curated camera-trap media (inlined). Omitted when empty.
  const photos = snapshot.images
    .map((img) => {
      const uri = dataUris.get(img.imageId);
      if (!uri) return "";
      return `<div class="hc"><img src="${uri}" alt="${esc(img.caption[lang])}"/><div class="body"><div class="nm">${esc(img.speciesLabel)}</div><div class="ds">${esc(img.caption[lang])}</div></div></div>`;
    })
    .join("");
  const audioClips = snapshot.audio
    .map(
      (clip) =>
        `<li><em>${esc(clip.speciesLabel)}</em> — ${esc(clip.caption[lang])} · <a href="${PUBLIC_BASE_URL}/api/public/report-audio/${clip.audioId}">▶</a></li>`,
    )
    .join("");
  const bonus =
    photos || audioClips
      ? `<section><div class="wrap"><div class="rule"></div><h2>${esc(c.bonus.heading)}</h2>
    ${photos ? `<h3>${esc(c.bonus.photosHeading)}</h3><div class="grid3">${photos}</div>` : ""}
    ${audioClips ? `<h3>${esc(c.bonus.audioHeading)}</h3><ul class="bars">${audioClips}</ul>` : ""}</div></section>`
      : "";

  const heroImg = assets.hero ? `<img src="${assets.hero}" alt=""/>` : "";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(c.hero.title)} — FCAT</title>
<style>${DESIGN_CSS}</style>
</head>
<body>
  <header class="hero">
    ${heroImg}
    <div class="inner">
      <p class="eyebrow" style="color:#cfe0bd">${esc(c.hero.eyebrow)}</p>
      <h1>${esc(c.hero.title)}</h1>
      <p class="sub">${esc(c.hero.sub)}</p>
      <p style="color:#d7e3c8;font-size:13px;margin-top:16px">${esc(tpl(c.hero.liveDate, { date: publishedDate }))} · ${esc(c.hero.metaSensors)}</p>
    </div>
  </header>

  <section><div class="wrap">
    <div class="rule"></div><h2>${esc(c.learn.heading)}</h2>
    ${c.learn.intro.map((p) => `<p>${esc(p)}</p>`).join("")}
    <div class="grid2" style="margin-top:18px">${objectives}</div>
  </div></section>

  <section><div class="wrap">
    <div class="rule"></div><h2>${esc(c.methods.heading)}</h2>
    <p>${esc(c.methods.intro)}</p>
    <div class="grid2" style="margin-top:18px">${methodCards}</div>
    <h3 style="font-family:var(--serif);margin:32px 0 6px">${esc(c.methods.habitatHead.title)}</h3>
    <p>${esc(c.methods.habitatHead.body)}</p>
    <div class="grid3" style="margin-top:18px">${habCards}</div>
  </div></section>

  <section class="stats"><div class="wrap">
    <p class="eyebrow">${esc(c.stats.eyebrow)}</p><h2>${esc(c.stats.heading)}</h2>
    <p>${esc(tpl(c.stats.spanLine, { span }))}</p>
    <div class="stat-grid" style="margin-top:18px">${statTiles}</div>
    <p style="color:#c3d5b1;font-size:13px;margin-top:16px">${esc(
      tpl(c.stats.note, {
        deploymentCount: fmt(s.deploymentCount),
        retrievedCount: fmt(s.retrievedCount),
        inField: fmt(inField),
      }),
    )}</p>
  </div></section>

  <section><div class="wrap">
    <div class="rule"></div><h2>${esc(c.map.heading)}</h2>
    <p>${esc(c.map.note)}</p>
    <div class="mapnote" style="margin-top:18px">${esc(c.map.heading)} — ${esc(
      lang === "es"
        ? "el mapa interactivo está disponible en la versión en línea."
        : "the interactive map is available in the online version.",
    )}</div>
  </div></section>

  <section><div class="wrap">
    <div class="rule"></div><h2>${esc(c.species.heading)}</h2>
    <p>${esc(c.species.intro)}</p>
    <div class="two" style="margin-top:18px">
      <div><h3>${esc(c.species.onCamera)}</h3><p style="font-size:13px">${esc(tpl(c.species.camCap, { n: fmt(s.cameraRealSpecies) }))}</p><ul class="bars">${cameraSpecies}</ul></div>
      <div><h3>${esc(c.species.bySound)}</h3><p style="font-size:13px">${esc(tpl(c.species.audCap, { n: fmt(s.audio.files) }))}</p><ul class="bars">${audioSpecies}</ul></div>
    </div>
  </div></section>

  ${bonus}

  <section><div class="wrap">
    <div class="rule"></div><h2>${esc(c.platform.heading)}</h2>
    <p>${esc(c.platform.intro)}</p>
    <div style="margin-top:18px">${gallery}</div>
  </div></section>

  <section><div class="wrap">
    <div class="rule"></div><h2>${esc(c.collaborate.heading)}</h2>
    <p>${esc(c.collaborate.intro)}</p>
    <div style="margin-top:18px">
      <b style="font-family:var(--serif)">${esc(c.collaborate.oppListTitle)}</b><ul class="list">${oppList}</ul>
    </div>
    <div class="cta" style="margin-top:24px">
      <h3>${esc(c.collaborate.ctaHeading)}</h3>
      <p>${esc(c.collaborate.ctaBody)}</p>
      <div class="contacts">${contacts}</div>
    </div>
  </div></section>

  <footer><div class="wrap">
    <b>${esc(c.footer.org)}</b><br/>${esc(c.footer.tagline)}<br/>${esc(tpl(c.footer.date, { date: publishedDate }))}
  </div></footer>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const langParam = new URL(request.url).searchParams.get("lang");
  const lang: Lang = langParam === "en" || langParam === "es" ? langParam : DEFAULT_LANG;

  const snapshot = await getActiveReportSnapshot();
  if (!snapshot) {
    return NextResponse.json({ error: "Not published yet" }, { status: 404 });
  }

  const [dataUris, assets] = await Promise.all([inlineCuratedImages(snapshot), loadStaticAssets()]);
  const html = buildHtml(snapshot, lang, dataUris, assets);

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="BioChoco-${lang}.html"`,
      "Cache-Control": "no-store",
    },
  });
}
