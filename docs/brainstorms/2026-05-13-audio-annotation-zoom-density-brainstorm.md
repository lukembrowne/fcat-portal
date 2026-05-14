# Audio Annotation — Spectrogram Zoom & Detection Density

**Date:** 2026-05-13
**Status:** Brainstorm
**Related work:** `src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx`, `src/components/annotation-tools-sidebar.tsx`

## What We're Building

A set of viewport-density improvements to the audio annotation page so that
recordings with many overlapping BirdNET detections (the screenshot case
showed ~25 boxes crammed into a 60-second view) remain readable and
navigable. Four concrete changes, rolled out incrementally:

1. **Taller default spectrogram + user-resizable height.** Bump from 256 px to ~350 px default, with a Compacto / Cómodo / Alto toggle persisted per-user.
2. **Time-axis zoom + horizontal scroll.** Discrete zoom levels (1× / 2× / 4× / 8×) via dropdown, scroll-wheel (with modifier), and `+`/`-` keyboard shortcuts. When zoomed in, the spectrogram becomes a horizontally scrollable strip with a sticky frequency-axis gutter on the left and a sticky time-axis at the bottom.
3. **Smart label handling.** At low zoom, species labels collapse to a colored tab (just the color stripe, no text); at high zoom the full text reappears. Hover reveals the full label as a tooltip regardless of zoom. Card click in the sidebar auto-scrolls the box into the centered viewport and pulses it briefly.
4. **Lane stacking for overlapping detections.** Since BirdNET emits every box as 0–15 kHz, all boxes literally stack at the same vertical band today. Detections whose time ranges overlap get assigned to tiered y-lanes (piano-roll style) so each gets its own visible y-band. Lane assignment is greedy / first-fit per chunk, recomputed when zoom changes the effective time density.

## Why This Approach

The user reported four simultaneous frictions when many detections are
present: labels overlap, boxes pile up in time, the 256 px spectrogram is
too short to read fine structure, and clicking a sidebar card doesn't
visually surface its box. Approach A (vertical-stretch only) addresses
only spectrogram readability; Approach B (zoom only) doesn't help the
"everything is at 15 kHz" stacking. Combined, plus lane stacking, addresses
all four pains and gives each verifier a tool that scales to denser
recordings without changing the underlying detection data model.

The existing render pipeline is friendly to zoom: the SVG box layer uses
`viewBox="0 0 1 1" preserveAspectRatio="none"` with `vectorEffect="non-scaling-stroke"`,
so boxes scale cleanly under horizontal zoom. Labels are HTML divs
positioned with percent-based `left`, so only their viewport offset needs
recomputation. This means we can ship zoom without rewriting the rendering
core.

## Key Decisions

- **Zoom is discrete, not continuous.** 1× / 2× / 4× / 8× snap levels — simpler state, predictable label-collapse thresholds, no per-pixel cursor drift bugs.
- **Frequency axis stays linear and full-range.** No vertical zoom in v1. The existing `displayMaxHz` cycle (5/8/12/15 kHz) already covers vertical framing.
- **Time-axis and freq-axis gutters stay sticky** while the spectrogram body scrolls. Otherwise scale references disappear.
- **Lane stacking is computed client-side**, per-file, based on rendered detection set. No schema change. Detections keep their true frequency range as data; lanes are a visual artifact only.
- **Card-click → auto-scroll** uses `scrollIntoView({ block: 'nearest', inline: 'center' })` with a brief highlight pulse (CSS animation, not data).
- **Playback cursor auto-follows** when zoomed: when the cursor moves outside the visible viewport during playback, the viewport scrolls to keep it centered. User can disable via a "Seguir reproducción" toggle.
- **User preferences (zoom level, height, follow-playback)** persist in `localStorage` keyed per-user. No DB roundtrip.
- **Phased rollout:** ship vertical-stretch first (smallest diff, immediate win), then zoom+scroll, then label-collapse, then lane-stacking. Each phase is independently useful and can be gated on feedback from the field team.

## Open Questions

- **Touchpad gesture support?** Pinch-to-zoom on Mac trackpads is nice-to-have but adds event-handling complexity. Keep zoom keyboard/dropdown-only in v1?
- **Mini-map / overview strip?** When zoomed in 8×, the user loses sight of where they are in the minute. A small overview strip above the main spectrogram (showing the full minute with a viewport indicator) could help — but adds another rendering pass. Worth considering for v2.
- **Lane labels** — when boxes are stacked into y-lanes, should each lane display the species name on the left (turning the view into a piano-roll proper) or stay purely visual?
- **Detection density threshold for auto-stacking.** Always lane-stack, or only when boxes overlap in time? Probably "only when overlapping" — preserves the current visual at low density.
- **Maximum zoom level?** 8× turns a 60 s clip into a 480 s-equivalent strip. For longer clips (5-minute deployments) we may want a different max or a logarithmic zoom scale.
- **Performance ceiling.** Each zoom level keeps the source spectrogram canvas the same size; we just stretch it via CSS. At 8× on a 1500 px viewport, the canvas is rendered at ~12000 px CSS width. Does FFT recomputation per-zoom give sharper detail, or is CSS scaling fine? Decide during planning.
- **Spec download / screenshot use case** — does anyone export the current view as a PNG? If so, the zoom level needs to be encoded in the export.

## Next

Run `/workflows:plan` to break Phase 1 (vertical stretch + height toggle) into implementation tasks, or continue brainstorming if more design questions surface.
