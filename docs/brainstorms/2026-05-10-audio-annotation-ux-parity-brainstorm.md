# Audio Annotation UX Parity with Camera Trap

**Date:** 2026-05-10
**Branch context:** `feat/birdnet-audio-analysis`

## What We're Building

Bring the audio annotation page (`/audio/[id]/annotate/[fileId]`) to UX parity with the camera trap annotation page (`/camera-trap/results/[id]/images/[imageId]`) by **sharing the same React components** rather than maintaining parallel implementations. Specifically:

- **Left sidebar = detection list with species info** (mirrors camera-trap `AnnotationToolsSidebar`).
- **Species picker popover** opens when the user clicks a region/box, with typeahead, frequent-species hotkeys (1–9), `0` = last species, "add species" button, Esc to close, Backspace-to-delete on empty search, arrow nav through detections while picker is focused, Enter to verify+advance.
- **Shared keyboard shortcut behavior** for the chrome (selection, picker, verify/advance), with audio-only keys (Space, `[`/`]`, `Q`/`E`, `P`, `L`, gain, freq-max, colormap) layered on top.
- **Spectrogram canvas remains audio-specific** (`FftSpectrogram`) — the time/freq coordinate system can't share an overlay implementation with the image bbox SVG, but it emits the same `selected / drawn / clicked` events the shared chrome consumes.

## Why This Approach

The user explicitly called out drift between the two annotation surfaces as the problem to solve. Recent camera-trap fixes (popover Esc handling, `0` = last species, Backspace-deletes-bbox, arrow nav through picker focus) need to land on audio too — and the next round of fixes shouldn't require a manual port. Lift-and-share gets us a single source of truth for the annotation chrome.

Spectrogram rendering is genuinely modality-specific (canvas + dynamic FFT vs static image + SVG overlay), so we don't try to unify it. The boundary sits at "what fires when a detection is selected/created" — above that line, components are shared; below, each page owns its surface.

## Key Decisions

- **Lift & share, not adapter context.** Promote `AnnotationToolsSidebar`, `AnnotationPickerPopover`, and the chrome portion of `useAnnotationShortcuts` to shared primitives that take props (detections, callbacks, frequent-species source, `modality` flag). No context layer — YAGNI for two modalities.
- **Generic detection shape.** The shared sidebar/popover consume a minimal `AnnotationDetection` interface (id, species, displayLabel, verificationStatus, starred, confirmedBlank). Modality-specific coordinate fields (`x/y/w/h` for image, `startTime/endTime/minFreq/maxFreq` for audio) live on each page's own type and are not seen by shared components.
- **Frequent species counts are per-modality.** Camera-trap and audio maintain separate frequency tallies — the same species can hold a different number key in each surface. Shared components receive an already-resolved frequent list as a prop; the queries live with each page.
- **Audio loses its inline sidebar search.** Today's "auto-focus search field on detection select" pattern goes away in favor of the popover. The `SpeciesSidebar` component (currently used by audio for inline search) stays available; on audio it becomes a reference list, or is replaced entirely if `AnnotationToolsSidebar` covers the same need.
- **Spectrogram stays the audio bbox surface.** No attempt to port `BBoxOverlay` (image SVG) onto the spectrogram canvas. The spectrogram's existing click/draw/resize handlers wire up to the same shared select/create/edit callbacks the image overlay uses.
- **Audio-specific shortcuts layer on top.** Playback (Space, `[`/`]`, `Q`/`E`, `P`, `L`), gain (+/-), freq-max cycle (F), colormap cycle (M), shift+arrow file nav stay in `useAudioAnnotationShortcuts`. The shared hook covers Esc, Backspace, 1–9 / 0, Enter verify+advance, and arrow nav through detections.

## Open Questions

- **Detection list parity:** camera-trap's sidebar has confirmed-blank, starred, setup tags, date suggestions. Which of these does audio actually need? Audio detections may not have the same metadata model — answer this in planning before promoting the sidebar.
- **`SpeciesSidebar` vs `AnnotationToolsSidebar`:** the recent commit `573335e` re-exported `SpeciesSidebar` for the audio caller. Once `AnnotationToolsSidebar` becomes shared, does `SpeciesSidebar` survive (as a different surface) or get retired?
- **Verification flow:** camera-trap is "verify all and advance" (single action). Audio currently has per-detection verify/reject + jump-to-next-unverified. Keep both flows, or unify on one?
- **Where shared components live:** `src/components/annotation/` is the natural home. Confirm during planning.
- **`AudioBoxData` ↔ image bbox shape:** decide whether to introduce an `AnnotationDetection` base interface in `src/types/` or leave each page with its own type and pass only the fields the shared components need.

## Scope Out (for now)

- Sharing the bbox overlay/canvas itself.
- Sharing annotation server actions (`assignAudioSpecies` vs camera-trap's actions) — signatures differ enough; keep separate, just call them from shared callbacks.
- Reworking the audio detection list UI from horizontal-strip to sidebar — this falls naturally out of using `AnnotationToolsSidebar` but the visual layout shift is part of the work.

## Next Step

`/workflows:plan` to map out the refactor: which files move, how the shared component props are shaped, what audio-specific work is left after lift-and-share.
