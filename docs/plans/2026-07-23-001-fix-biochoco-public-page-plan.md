---
title: "fix: BioChoco public page — logged-out assets, spectrogram caching, team roster"
date: 2026-07-23
type: fix
status: ready
depth: standard
---

# fix: BioChoco public page — logged-out assets, spectrogram caching, team roster

## Summary

The public page at `/public/biochoco-overview` is broken for logged-out visitors — habitat photos, the Leaflet map, platform screenshots, and spectrograms all fail; they only render when signed in. Root cause is a single nginx gap: only `/public/` and `/api/public/` bypass Google OAuth, but the page loads its JavaScript from `/_next/static/*` and its static media from `/biochoco-overview/*`, both OAuth-gated. This plan fixes that gap, and folds in three requested enhancements to the same page: pre-render/cache spectrograms server-side at publish, add seven field-team members to the people section, and document screenshot placement (plus fix the missing `occupancy.jpg` tile).

Scope is the public overview surface only. No change to authenticated app behavior, no change to the public API auth model (already correctly open + snapshot/token-allowlisted).

---

## Problem Frame

**Who is affected:** anyone opening the public link without an FCAT Google session — i.e., every intended external audience (collaborators, funders, the public). The page is a recruiting/outreach artifact, so "works only when signed in" defeats its purpose.

**Observed behavior (logged out / incognito):** habitat photos broken, satellite map blank, platform screenshots broken, spectrograms absent. Audio playback works. Signed-in users see everything.

**Root cause (verified):** `nginx/portal.fcat-ecuador.org` uses longest-prefix matching. Only `location /public/` (`:69`), `location /api/public/` (`:83`), and `location = /logo-fcat.png` (`:62`) skip auth. Everything else falls to `location /` (`:115`), which runs `auth_request /oauth2/auth` + `error_page 401 = /oauth2/sign_in` (`:123-124`). The page's HTML is served from the exempt `/public/…` path, but:

- client JS lives at `/_next/static/*` → OAuth-gated → the page never hydrates → the `dynamic({ssr:false})` Leaflet map (`report-shell.tsx:12-19`) stays on its blank placeholder and the `"use client"` spectrogram canvases never run;
- hero/habitat/gallery images and `reserve.geojson` live at `/biochoco-overview/*` → OAuth-gated → broken images.

A signed-in session carries the `_fcat_portal_oauth2` cookie, so `auth_request` succeeds for those paths — hence "works for me." The public API routes are *not* the problem: `report-audio`/`report-images` are tokenless and snapshot-allowlisted (open by design), so audio streams fine. `src/proxy.ts` (app-layer auth, `:35-40`) shares the gap — its matcher excludes `_next/static`/`_next/image`/`public/`/`api/public/` but not `/biochoco-overview/`.

**Secondary issues, same page:** spectrograms regenerate via browser FFT on every load (and silently fail on iOS/Safari, which can't `decodeAudioData` FLAC); the people section needs seven more members; the `occupancy.jpg` gallery tile is referenced by `content.ts` but absent on disk.

---

## Requirements

- **R1** — Logged-out visitors can load the page's client JS and static media, so the map, screenshots, habitat photos, and spectrograms render. (fixes the core bug)
- **R2** — The fix does not weaken auth for the authenticated app or other surfaces; server actions and pages keep their permission checks.
- **R3** — Spectrograms are generated once, server-side, at publish time and served as cached images; no per-load client FFT when a cached image exists; graceful fallback to the current client FFT when it doesn't.
- **R4** — The people section shows seven new field-team members above the current three, as one combined list; members without an email render cleanly (no broken mailto, no export crash).
- **R5** — Screenshot placement is documented and the missing `occupancy.jpg` tile is resolved.
- **R6** — Existing unit tests stay green (content parity, roles).

---

## Key Technical Decisions

- **KTD1 — Exempt `/_next/static/`, `/_next/image`, and `/biochoco-overview/` at nginx (not: move assets under `/public/`).** `/_next/static` cannot be relocated (Next owns the path), so it must be exempted regardless; exposing compiled client bundles is standard for OAuth-fronted Next apps — they carry no secrets, are already delivered to every authenticated browser, and server actions retain `requirePermission`. Mirror the `/biochoco-overview/` exemption in `src/proxy.ts`.
- **KTD2 — Pre-render spectrograms server-side at publish, store base64 PNG in the snapshot (not: client-side cache).** Every render primitive except the browser `AudioContext` decode is already pure server-safe JS (`computeMagnitudes`, `binFromHz`, `renderImageData`, `COLORMAPS`); ffmpeg and `sharp` are already server-side dependencies. `public_report_snapshots.payload` is a `text` column (no blob store), so base64 travels atomically with publish and is deploy-safe (~KB × 6 clips). This also fixes iOS/Safari, which the client FFT cannot serve. Client FFT stays as a fallback for snapshots lacking the field.
- **KTD3 — Make `Contact.email` optional; keep one combined contacts grid.** Matches the request ("keep the bottom three at the bottom"); the `repeat(3,1fr)` grid flows 10 cards with no layout change; conditional mailto avoids the export crash (`esc(undefined)`).

---

## Implementation Units

### U1. Fix public-page asset auth (nginx + proxy)

**Goal:** unauthenticated requests for the page's JS and static media succeed, so the page renders logged out.
**Requirements:** R1, R2.
**Dependencies:** none. Ship first and independently.
**Files:**
- `nginx/portal.fcat-ecuador.org` — add no-auth `location` blocks (clone the `/public/` block shape, omit `auth_request` and `X-Forwarded-Email`) for `/_next/static/`, `/_next/image`, and `/biochoco-overview/`. Do not apply the tight `public_pages` (5r/s) limit to `/_next/static/` (a page pulls many chunks) — omit `limit_req` or use a generous burst.
- `src/proxy.ts` — add `biochoco-overview/` to the matcher negative-lookahead (`:38`): `"/((?!_next/static|_next/image|favicon.ico|public/|api/public/|biochoco-overview/).*)"`.

**Approach:** nginx is the front-line blocker (unmatched paths → auth-gated `location /`); `proxy.ts` is the second layer and needs the `/biochoco-overview/` exemption to match. Exposed paths are all public build artifacts or marketing media.
**Patterns to follow:** existing `location /public/` (`nginx/portal.fcat-ecuador.org:69-80`), `location /api/public/` (`:83-93`); the existing `proxy.ts` exclusion list.
**Test expectation: none** — infrastructure config; no nginx test harness. Verified manually (see Verification).
**Verification:** logged-out incognito load renders map + screenshots + habitat + spectrograms; `curl -I /_next/static/<chunk>.js` and `/biochoco-overview/hero.jpg` → 200 (not 302→sign-in). Regression: signed-in app unaffected; `/public/apply` and share links still load logged out.

---

### U2. Add field-team members (combined list, optional email)

**Goal:** show 10 people — 7 new field-team members (no email) above the 3 current emailed contacts.
**Requirements:** R4, R6.
**Dependencies:** none.
**Files:**
- `src/app/public/biochoco-overview/content.ts` — `Contact.email` → optional (`:16-20`); update the `// 3` comment (`:121`) to `// 10`; prepend 7 members to `en.contacts` (`:323-327`) and `es.contacts` (`:530-534`), keeping the existing three last. Roles (en / es): Melissa Loayza — Program Director / Directora de Programa; Karla Zambrano — Field Coordinator / Coordinadora de Campo; Luis Zambrano — Field Coordinator / Coordinador de Campo; Gregory Paladines — Local biologist (FCATero) / Biólogo local (FCATero); Gloria Loor — Local biologist (FCATera) / Bióloga local (FCATera); Julio Loor — Local biologist (FCATero) / Biólogo local (FCATero); Darwin Zambrano — Local biologist (FCATero) / Biólogo local (FCATero). New members omit `email`.
- `src/app/public/biochoco-overview/report-shell.tsx` (`:645-653`) — React key `contact.email` → `contact.name`; render the mailto `<a>` only when `contact.email` is set.
- `src/app/public/biochoco-overview/download/route.ts` (`:282-287`) — same conditional; otherwise `esc(undefined)` throws and 500s the export. (Classes here are `.cn`/`.cr`.)
- `tests/unit/biochoco-overview-content.test.ts` — `contacts.length` 3 → 10 (`:31-32`); rewrite the positional role array (`:73-77`) to all 10 roles in new order; filter to emailed contacts before the `email.endsWith("@fcat-ecuador.org")` assertion (`:78`).

**Approach:** the `.contacts` grid is `repeat(3,1fr)` (report-shell `:220`, download `:189`) and flows 10 cards automatically — no CSS change. A no-email card is simply shorter.
**Patterns to follow:** the existing contact card render + `esc()` guard style in `download/route.ts`.
**Test scenarios:**
- en and es `contacts.length === 10`.
- `en.contacts.map(c => c.role)` equals the new 10-role array in order.
- every contact that *has* an email ends with `@fcat-ecuador.org`; members without email are skipped by the filter (no `.endsWith` on undefined).
- key-shape parity test still passes.
- (manual/integration) `/public/biochoco-overview/download?lang=es` returns 200 with no-email members present (no `esc(undefined)` crash).

---

### U3. Pre-render & cache spectrograms at publish

**Goal:** each curated clip's spectrogram is generated once server-side at publish and stored in the snapshot; the page renders a cached image with no client FFT, falling back to the current client path when the field is absent.
**Requirements:** R3.
**Dependencies:** none (independent of U1/U2), but only *visible* on prod after re-publish.
**Files:**
- `src/lib/audio-pcm.ts` (new) — `decodeAudioToPcmMono(driveFileId): Promise<{ samples: Float32Array; sampleRate: number }>`; spawn ffmpeg to decode to raw mono float PCM (`-i <src> -ac 1 -f f32le -acodec pcm_f32le -`), read stdout into a `Float32Array`. Model spawn/timeout/`ffmpegBin()`/Drive-download on `src/lib/audio-transcode.ts`.
- `src/lib/spectrogram-image.ts` (new) — `renderSpectrogramPng(samples, sampleRate): Promise<Buffer>`; reuse `computeMagnitudes` + `binFromHz` (`src/lib/audio-fft.ts`), `COLORMAPS.magma` (`src/lib/spectrogram-colormaps.ts`), `renderImageData` (`src/lib/spectrogram-render.ts`), then `sharp(Buffer.from(img.data), { raw: { width, height, channels: 4 } }).png()`. Match the client knobs (`spectrogram-clip.tsx`: `DISPLAY_MAX_HZ=12000`, `FFT_SIZE=1024`, `GAIN_DB=18`, `RANGE_DB=72`) and a fixed output size so the cached image matches today's look.
- `src/app/public/biochoco-overview/lib/snapshot-types.ts` — add `spectrogramPng?: string` (base64 data URI) to `CuratedAudioClip`.
- `src/app/public/biochoco-overview/lib/build-snapshot.ts` (curated-audio resolution) **or** `publish-actions.ts` (after `buildSnapshot`) — per resolved clip: look up `audio_files.driveFileId`, decode → render → base64, attach `spectrogramPng`. Per-clip try/catch: on failure omit the field (page falls back), never fail the publish.
- `src/app/public/biochoco-overview/spectrogram-clip.tsx` — accept optional `pngSrc`; when present, render `<img src={pngSrc}>` and skip `decodeAudio`/`computeMagnitudes`/the IntersectionObserver decode; keep the `<audio preload="none">` element and rAF playhead. When absent, keep the existing client FFT path unchanged.
- `src/app/public/biochoco-overview/report-shell.tsx` (~`:576`) — pass `clip.spectrogramPng` into `<SpectrogramClip>`.

**Approach / rationale:** see KTD2. Publish is admin-gated and infrequent (6 clips) → a synchronous decode→render→encode loop is fine.
**Patterns to follow:** `src/lib/audio-transcode.ts` (ffmpeg spawn, single-flight, timeout, Drive download); `sharp` usage in `download/route.ts:95-100`; base64-data-URI inlining already used in `download/route.ts`.
**Execution note:** write the `renderSpectrogramPng` dimension/PNG test first — it pins the reusable primitive before wiring the publish path.
**Test scenarios:**
- `renderSpectrogramPng` on a synthetic PCM buffer (1 kHz sine, fixed sampleRate) returns a PNG whose `sharp(out).metadata()` reports the expected width/height — pure, no Drive/ffmpeg.
- build-snapshot attaches `spectrogramPng` when decode succeeds; omits it (no throw) when the decode step rejects.
- (manual) after re-publish the page shows the spectrogram with no client FFT; a snapshot without the field renders via the client fallback; iOS Safari shows the image.

---

### U4. Screenshot placement runbook + fix the missing occupancy tile

**Goal:** a clear placement procedure and a working occupancy tile.
**Requirements:** R5.
**Dependencies:** U1 (assets only public after the nginx fix).
**Files:** static assets under `public/biochoco-overview/gallery/`; optionally a short runbook in `docs/operations/`.
**Approach:** the gallery is filename-driven — each `content.ts` `platform.gallery[].file` names its image, served (after U1) at `/biochoco-overview/gallery/<file>`. Current entries: `results-by-site.jpg`, `occupancy.jpg`, `species-classifier.jpg`, `microclimate.jpg`. On disk: the first, third, fourth exist and are git-tracked; **`occupancy.jpg` is missing** → broken tile.

Placement procedure: (1) save the JPG into `public/biochoco-overview/gallery/` using the exact filename from the matching gallery entry (new tile → add a `content.ts` entry in en + es with the same `file`); (2) `git add` + commit (committed static assets, not runtime-generated) and deploy; (3) after U1 they're publicly visible; aim ~1400–1600px wide, browser-framed, matching the set; (4) habitat photos follow the same pattern under `public/biochoco-overview/habitat/<habitatKey>.jpg` (keys from `lib/habitat.ts`).
**Action item:** obtain/produce `occupancy.jpg` and place it (user is supplying this screenshot).
**Test expectation: none** — static assets/docs.

---

## Scope Boundaries

**In scope:** the nginx/proxy exemptions; spectrogram pre-render at publish; the 10-person combined contacts list; screenshot runbook + occupancy tile.

**Out of scope (non-goals):**
- Changing the public API auth model (already open + allowlisted, correct as-is).
- Reworking authenticated-app auth or any other public page's layout.
- A general CDN/static-asset strategy beyond the three exempted prefixes.

**Deferred to follow-up work:**
- Inlining the cached spectrogram PNG into the `download`/export HTML (currently the export links audio only) — nice-to-have, not required.
- Moving spectrogram PNGs from snapshot-base64 to a `data/`-cache + API route if payload size ever becomes a concern (not expected at 6 clips).

---

## Risks & Dependencies

- **nginx reload is an ops step.** The edited `nginx/portal.fcat-ecuador.org` must be installed on the host and `nginx -t && systemctl reload nginx` run — separate from the app deploy. Confirm how `deploy.sh` handles the nginx config. A bad `nginx -t` blocks reload; validate before reloading.
- **Exposing `/_next/static` publicly** — reviewed and accepted: compiled client bundles contain no secrets and are already delivered to authenticated browsers; server actions keep `requirePermission`.
- **ffmpeg availability at publish** — `decodeAudioToPcmMono` depends on `FFMPEG_PATH`/`ffmpeg` (same as `audio-transcode.ts`). If absent, per-clip try/catch omits the image and the page falls back to client FFT — publish never fails.
- **Snapshot payload size** — base64 PNGs enlarge the row; ~KB × 6 is negligible. Watch if clip count grows substantially.

---

## Verification (end-to-end)

1. **U1 (critical):** after nginx reload, load `/public/biochoco-overview` in a private window (logged out) — habitat, satellite map, screenshots, audio, spectrograms all render; `curl -I` on a `/_next/static/*.js` chunk and `/biochoco-overview/hero.jpg` → 200. Regression: signed-in portal, `/public/apply`, and share links unaffected.
2. **U2:** `npm run test:run` green; page shows 10 people (7 without mailto, 3 emailed last); `download?lang=es` → 200.
3. **U3:** run admin publish → snapshot payload carries `spectrogramPng` per clip; page shows the spectrogram with no client FFT; old snapshot falls back; iOS Safari renders it; unit tests pass.
4. **U4:** `occupancy.jpg` present → tile loads logged out.

**Rollout order:** U1 nginx reload → deploy app (U2/U3/U4 code + `occupancy.jpg`) → re-run admin **publish** (regenerates the snapshot with spectrogram PNGs; contacts/gallery ship with the build). U1, U2, U3, U4 are separable PRs.

---

## Sources & Research

- Root cause traced to `nginx/portal.fcat-ecuador.org:69,83,115,123-124` and `src/proxy.ts:35-40`; public API routes confirmed open/allowlisted (`api/public/report-audio|report-images/[id]/route.ts`).
- Spectrogram primitives confirmed server-safe except the browser `AudioContext` decode (`src/lib/audio-fft.ts` `decodeAudio`); `computeMagnitudes`/`binFromHz`/`renderImageData`/`COLORMAPS` are pure JS. ffmpeg pattern in `src/lib/audio-transcode.ts`; `sharp` already used in `download/route.ts`. Snapshot storage is JSON `text` in `public_report_snapshots` (`src/db/schema.ts`).
- Contacts structure, render, download route, and parity test surveyed in `content.ts`, `report-shell.tsx`, `download/route.ts`, `tests/unit/biochoco-overview-content.test.ts`.
