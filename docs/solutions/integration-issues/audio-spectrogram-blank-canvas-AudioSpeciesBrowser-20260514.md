---
title: "Audio detection card spectrogram stays blank"
type: bugfix
date: 2026-05-14
category: integration-issues
module: AudioSpeciesBrowser
problem_type: integration_issue
component: react_client_component
symptoms:
  - "Spectrogram canvas stays the dark-blue background while audio plays through speakers normally"
  - "Works after page refresh, fails after playing 2-3 cards on a page"
  - "First card after navigating between species pages (SPA route change) fails to paint"
  - "For detections deep into a long recording, canvas blank for tens of seconds then suddenly fills in"
  - "el.currentTime stays at 0 throughout playback even though we called el.currentTime = seekTarget"
root_cause: multiple_browser_quirks
resolution_type: code_fix
severity: medium
tags:
  - web-audio
  - audiocontext
  - mediaelementsourcenode
  - analysernode
  - flac
  - streamed-audio
  - seeking
  - spectrogram
  - canvas
  - react
  - spa-navigation
---

# Audio detection card spectrogram stays blank

## Problem

The audio species browser (`/audio/species/[slug]`) renders a row of detection cards, each with a play button and a real-time spectrogram canvas. After play, the spectrogram should paint left-to-right as audio plays — bright bands at the bird call's frequencies.

Three intersecting failure modes all produced the same visible symptom: **audio plays through the speakers, canvas stays blank**.

| Trigger | Visible pattern |
|---|---|
| 7th+ card play on the same page | Audio plays, canvas blank. Refresh resets it. |
| First card after navigating to a new species page | Audio plays, canvas blank. Refresh resets it. |
| Detection deep into a long recording (e.g., `start=41s`) | Audio plays from t=0 the whole time. Canvas blank for ~80s, then suddenly starts painting once natural playback reaches the clip window. |

## Environment

- Module: `src/app/audio/species/_components/audio-detection-card.tsx`
- Framework: Next.js 16 / React 19 / TypeScript
- Browser: Chrome (reproduced on 121+)
- Audio source: Streamed FLAC from Google Drive via `/api/audio/stream?fileId=...`
- 24 cards per page (`PAGE_SIZE = 24` in `src/app/audio/species/actions.ts`)

## Investigation

The symptom looked identical across all three failure modes, but the underlying causes were different layers of the same chain. Diagnostics had to peel them off one at a time.

### Failed attempt 1: blame `crossOrigin`

Added `crossOrigin="anonymous"` on the `<audio>` element thinking the analyser tap was being CORS-tainted. Same-origin URL — the attribute actually triggered a CORS preflight the stream API doesn't satisfy, breaking audio entirely on some browsers. Removed.

### Failed attempt 2: mount-time canvas sizing

Sized the canvas backing store in a mount-time `useEffect`. Cards rendered inside a collapsed `<details>` ("Sin ubicación") have `clientWidth = 0` at mount because the browser hides non-summary children. The backing store ended up 0×0, `putImageData` no-op'd silently. Moved sizing to `toggle()` (always called when canvas is visible). This fixed the collapsed-`<details>` case but not the others.

### Failed attempt 3: trust the `seeked` event

The code did:

```ts
el.addEventListener("seeked", onSeeked, { once: true });
el.currentTime = seekTarget;
await /* seeked promise */;
await el.play();
```

Tagged `console.debug` instrumentation showed `el.currentTime` was 0 right after the await resolved. Chrome was firing `seeked` synchronously without actually moving the playhead for streamed FLAC. Trusting the event let `play()` start from t=0 while the spectrogram correctly waited for the clip window.

### Failed attempt 4: post-play seek recovery

Reasoned that once playback was actively requesting bytes, the audio engine would be in a state where seek could succeed. Set `el.currentTime = seekTarget` right after `el.play()` resolved. Logs showed:

```
toggle: post-play seek recovery cur=0.00 -> 17.00
tick #0 cur=0.00 ... rel=-1.889 paint=rel-neg
tick #30 cur=0.00 ... rel=-1.889 paint=rel-neg
```

The assignment was accepted (no exception) but `currentTime` still didn't move. The FLAC files in this dataset lack seek tables, so Chrome has no way to map time → byte and silently ignores the assignment.

## Root cause

Three distinct browser-API quirks, layered:

### 1. Chrome caps active `AudioContext`s at ~6 per page

One context per card with 24 cards meant the 7th+ context got created but was silently inert. `createMediaElementSource` succeeded, `connect()` succeeded, `state === "running"`, but no FFT data ever flowed. Refresh killed all contexts, so the next 6 worked.

### 2. rAF loop wired to `play` event had a closure-flag race after SPA navigation

The original code started the spectrogram rAF loop via `el.addEventListener("play", onPlay)` where `onPlay` set a closure-scoped `running = true` and called `requestAnimationFrame(tick)`. After an SPA route change, the `play` event sometimes dispatched in a window where the awaited `el.play()` promise had already resolved but the `running` flag was unreachable from the new render's closures, leaving the rAF unstarted.

### 3. Chrome silently ignores `el.currentTime = N` for streamed FLAC without seek tables

For a FLAC file that doesn't contain a `SEEKTABLE` metadata block, Chrome can't map time positions to byte offsets. Setting `el.currentTime` is accepted but has no effect on the actual playhead. `seeked` fires anyway, deceiving caller code into thinking the seek worked. Audio plays from t=0 regardless of what was assigned.

## Solution

Four commits, each addressing one layer:

### `cb8d9ad` — Module-level singleton AudioContext

```ts
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext && sharedAudioContext.state !== "closed") {
    return sharedAudioContext;
  }
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    sharedAudioContext = new Ctor();
    return sharedAudioContext;
  } catch {
    return null;
  }
}
```

All cards reuse this single context. Each card still owns its own `MediaElementAudioSourceNode` and `AnalyserNode` (one per `<audio>` element), but they all feed into the same context. Per-card unmount disconnects the source/analyser; the context stays alive.

### `a7528e3` — Start rAF directly from `toggle()`, not from `play` event

```ts
try {
  await el.play();
  playbackStartRef.current = el.currentTime;
  setPlaying(true);
  startRaf();  // <-- direct call, no event-listener race
} catch {
  setPlaying(false);
}
```

The rAF tick self-stops when `el.paused || el.ended`, so no event-listener teardown is needed for the loop itself. A small `useEffect` still mirrors external pause/end into `setPlaying(false)`.

### `be22be3` — Map spectrogram to elapsed playback time, not file currentTime

This is the workaround for failure mode 3. We can't make the seek work without re-encoding the FLAC files. Instead, snapshot `el.currentTime` right after `el.play()` resolves and drive the spectrogram off `elapsed = el.currentTime - snapshot`:

```ts
const playbackStartRef = useRef(0);

// In toggle:
await el.play();
playbackStartRef.current = el.currentTime;  // 0 if seek failed, start if it worked
setPlaying(true);
startRaf();

// In rAF tick:
const elapsed = el.currentTime - playbackStartRef.current;
if (cl > 0 && elapsed >= cl) {
  el.pause();          // end-of-clip
  setPlaying(false);
  return;
}
paintColumn(canvas, byteData, elapsed / cl);
```

`paintColumn` now takes `rel: number` (0..1) directly instead of `(currentTime, start, clipLength)`. The painted columns always advance smoothly with what the user actually hears.

**Trade-off:** for cards where the seek silently failed, the user hears the start of the file (not the detection region) AND sees its spectrogram. Audio and visuals stay in sync; just not necessarily the detection. The deeper fix would be to re-encode the FLAC files with `--seektable` enabled.

## Prevention

- **Web Audio + many media elements: use one shared `AudioContext`.** Chrome's cap is ~6/page. One-per-component breaks silently after a handful of plays. Module-level singleton is the standard pattern.
- **Don't trust the `seeked` event for streamed audio.** It can fire without `currentTime` actually moving. Either verify (`el.currentTime` close to `seekTarget`) or design visualizations to not depend on file-position accuracy.
- **For visualizations of streamed audio, prefer elapsed-playback-time over file-currentTime.** It works regardless of whether seeks succeeded.
- **Don't tie rAF loops to media events when an awaited `play()` promise exists.** Browser ordering between the promise and the `play` event is inconsistent across SPA navigations. Call the rAF starter inline.
- **For seekable streamed audio: FLAC files MUST be encoded with a `SEEKTABLE` block.** When BIOCHOCO_Data FLAC files are re-encoded, ensure encoder writes one (`flac --best` does by default; many transcoding pipelines disable it).

## Verification

After all four commits:

1. Open `/audio/species/[any-slug]`, expand a site, play 10+ cards in sequence. All paint reliably; no Chrome context cap.
2. Navigate between species pages. First card on each new page paints from tick #0.
3. Play a card whose detection is deep in a long file (e.g., `detection.startTime > 30s`). Audio starts from the file's beginning (because seek fails), but the canvas paints normally as audio plays. Stops at `clipLength` seconds of elapsed playback.
4. No `[spec ctx]` or `[spec <id>]` console output (diagnostics were removed in `b8557ec`).

## Related

- `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md` — server-side spectrogram issue in the annotation system, same domain but different layer (Python subprocess explosion, not Web Audio).
