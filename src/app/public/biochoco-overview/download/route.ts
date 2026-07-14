/**
 * Self-contained HTML export of the public BioChoco overview.
 *
 *   /public/biochoco-overview/download?lang=es
 *
 * Renders the active snapshot for one language into a single HTML file with the
 * curated images inlined as base64 data URIs — so it opens offline with no
 * network calls for imagery. Audio clips are linked (absolute URLs), since
 * inlining audio would bloat the file; they play when online.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import sharp from "sharp";
import { db } from "@/db";
import { images } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { downloadFileToBuffer } from "@/lib/drive-client";
import { getActiveReportSnapshot } from "@/lib/public-report-snapshot";
import { log } from "@/lib/log";
import { CONTENT, DEFAULT_LANG } from "../content";
import type { Lang, ReportSnapshot } from "../lib/snapshot-types";

export const dynamic = "force-dynamic";

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
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

async function inlineCuratedImages(
  snapshot: ReportSnapshot,
): Promise<Map<number, string>> {
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
      const jpeg = await sharp(original, { limitInputPixels: 100_000_000 })
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

function buildHtml(snapshot: ReportSnapshot, lang: Lang, dataUris: Map<number, string>): string {
  const c = CONTENT[lang];
  const s = snapshot.stats;
  const rs = s.retrievedSensors;
  const subWords = c.statLabels.deploymentsSub.split(" · ");
  const deploymentsSub = `${rs.cam} ${subWords[0]} · ${rs.audio} ${subWords[1]} · ${rs.climate} ${subWords[2]}`;

  const stat = (n: string, label: string, sub?: string) =>
    `<div class="stat"><span class="n">${esc(n)}</span><span class="l">${esc(label)}</span>${
      sub ? `<span class="s">${esc(sub)}</span>` : ""
    }</div>`;

  const cameraSpecies = s.cameraTopSpecies
    .map(
      (sp) =>
        `<li><em>${esc(sp.sci)}</em>${sp.spanishName ? ` · ${esc(sp.spanishName)}` : ""} <span>${fmt(sp.detections)}</span></li>`,
    )
    .join("");
  const audioSpecies = s.audioTopSpecies
    .map((sp) => `<li><em>${esc(sp.sci)}</em> <span>${fmt(sp.detections)}</span></li>`)
    .join("");

  const photos = snapshot.images
    .map((img) => {
      const uri = dataUris.get(img.imageId);
      if (!uri) return "";
      return `<figure><img src="${uri}" alt="${esc(img.caption[lang])}"/><figcaption>${esc(img.caption[lang])}</figcaption></figure>`;
    })
    .join("");

  const audioClips = snapshot.audio
    .map(
      (clip) =>
        `<li><em>${esc(clip.speciesLabel)}</em> — ${esc(clip.caption[lang])}<br/><a href="${PUBLIC_BASE_URL}/api/public/report-audio/${clip.audioId}">${esc(c.media.audioHeading)}</a></li>`,
    )
    .join("");

  const contacts = c.contacts
    .map(
      (ct) =>
        `<li><strong>${esc(ct.name)}</strong> · ${esc(ct.role)} · <a href="mailto:${esc(ct.email)}">${esc(ct.email)}</a></li>`,
    )
    .join("");

  const publishedDate = new Date(snapshot.generatedAt).toLocaleDateString(
    lang === "es" ? "es-EC" : "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(c.title)} — FCAT</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: #1a1a1a; line-height: 1.5; }
  .eyebrow { text-transform: uppercase; letter-spacing: .18em; font-size: .8rem; color: #666; }
  h1 { font-size: 2rem; margin: .3rem 0; }
  h2 { font-size: 1.3rem; margin-top: 2.2rem; }
  h3 { font-size: 1rem; margin: 1rem 0 .3rem; }
  .subtitle { font-size: 1.15rem; color: #444; }
  p { color: #333; max-width: 42rem; }
  .stats { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.5rem 0; }
  .stat { flex: 1 1 calc(25% - .75rem); min-width: 7rem; border: 1px solid #e2e2e2; border-radius: .75rem; padding: .75rem 1rem; display: flex; flex-direction: column; }
  .stat .n { font-size: 1.5rem; font-weight: 700; }
  .stat .l { font-size: .85rem; color: #555; }
  .stat .s { font-size: .72rem; color: #888; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  ul { list-style: none; padding: 0; }
  li { display: flex; justify-content: space-between; gap: .5rem; font-size: .9rem; padding: .1rem 0; }
  .species li span { color: #777; }
  .caveat { font-size: .75rem; color: #888; }
  figure { margin: 0; }
  .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; }
  .photos img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: .5rem; }
  figcaption { font-size: .72rem; color: #777; margin-top: .2rem; }
  footer { margin-top: 3rem; border-top: 1px solid #e2e2e2; padding-top: 1rem; font-size: .75rem; color: #777; }
  a { color: #1a5; }
</style>
</head>
<body>
  <p class="eyebrow">${esc(c.eyebrow)} · ${esc(c.ui.publishedAt)} ${esc(publishedDate)}</p>
  <h1>${esc(c.title)}</h1>
  <p class="subtitle">${esc(c.subtitle)}</p>
  <p>${esc(c.intro)}</p>

  <div class="stats">
    ${stat(fmt(s.retrievedCount), c.statLabels.deployments, deploymentsSub)}
    ${stat(fmt(s.distinctSites), c.statLabels.sites)}
    ${stat(fmt(s.cameraRealSpecies), c.statLabels.cameraSpecies)}
    ${stat(fmt(s.audioSpeciesCount), c.statLabels.audioSpecies, c.statLabels.audioSpeciesSub)}
    ${stat(fmt(s.totalDetections), c.statLabels.detections)}
    ${stat(fmt(s.cameraTrapDays), c.statLabels.cameraTrapDays)}
    ${stat(fmt(s.ibutton.readings), c.statLabels.iButtonReadings)}
  </div>

  <h2>${esc(c.learn.heading)}</h2>
  ${c.learn.body.map((p) => `<p>${esc(p)}</p>`).join("")}

  <h2>${esc(c.methods.heading)}</h2>
  ${c.methods.body.map((p) => `<p>${esc(p)}</p>`).join("")}

  <h2>${esc(c.species.heading)}</h2>
  <div class="cols species">
    <div><h3>${esc(c.species.cameraHeading)}</h3><ul>${cameraSpecies}</ul></div>
    <div><h3>${esc(c.species.audioHeading)}</h3><ul>${audioSpecies}</ul><p class="caveat">${esc(c.species.audioCaveat)}</p></div>
  </div>

  ${
    photos || audioClips
      ? `<h2>${esc(c.media.heading)}</h2>
    ${photos ? `<h3>${esc(c.media.photosHeading)}</h3><div class="photos">${photos}</div>` : ""}
    ${audioClips ? `<h3>${esc(c.media.audioHeading)}</h3><ul>${audioClips}</ul>` : ""}`
      : ""
  }

  <h2>${esc(c.collaborate.heading)}</h2>
  ${c.collaborate.body.map((p) => `<p>${esc(p)}</p>`).join("")}
  <h3>${esc(c.collaborate.contactsHeading)}</h3>
  <ul>${contacts}</ul>

  <footer>${esc(c.footer)}</footer>
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

  const dataUris = await inlineCuratedImages(snapshot);
  const html = buildHtml(snapshot, lang, dataUris);

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="BioChoco-${lang}.html"`,
      "Cache-Control": "no-store",
    },
  });
}
