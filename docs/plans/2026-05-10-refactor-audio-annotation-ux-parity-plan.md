---
title: Audio annotation UX parity with camera-trap (lift-and-share chrome)
type: refactor
date: 2026-05-10
brainstorm: docs/brainstorms/2026-05-10-audio-annotation-ux-parity-brainstorm.md
---

# refactor: Audio annotation UX parity with camera-trap

## Overview

Bring the audio annotation page (`/audio/[id]/annotate/[fileId]`) to UX parity with the camera-trap annotation page (`/camera-trap/results/[id]/images/[imageId]`) by **reusing** camera-trap's annotation chrome instead of maintaining parallel implementations. The chrome is the left-side detection list (`AnnotationToolsSidebar`), the click-bbox species picker (`AnnotationPickerPopover`), and the chrome keyboard shortcuts (`useAnnotationShortcuts`). Spectrogram canvas rendering stays audio-specific; everything around it converges.

The brainstorm answered WHAT. This plan answers HOW: which files change, what new server actions land, what migrations the audio page needs, and what behavior changes audio users will see.

## Problem Statement

After recent camera-trap UX work (popover-on-bbox-click, `0`=last species, Esc handling, Backspace-deletes-bbox, arrow-nav while picker focused), the audio page has drifted:

- Audio still uses `SpeciesSidebar` (a now-orphaned component kept alive only for audio) with an inline-search-on-detection-select pattern. Camera-trap moved to `AnnotationToolsSidebar` + popover.
- Audio's keyboard shortcuts use a parallel `useAudioAnnotationShortcuts` hook that diverges from camera-trap's chrome semantics (`0` = "species #10" instead of last-species, arrow-keys seek instead of navigating files, no last-species tracking, no popover Esc handling).
- Audio passes `frequentSpecies={[]}` because no audio frequent-species pipeline is wired (the `getRecentAudioSpecies` action exists but isn't called from the page).
- Every camera-trap fix to the annotation chrome currently requires a manual port to audio. The latest round (popover Esc/0/Backspace/arrow-nav fixes) hasn't landed on audio at all.

Goal: a single source of truth for the annotation chrome so future fixes propagate to both modalities.

## Proposed Solution

**Lift-and-share, not adapter context.** Camera-trap's chrome components are already callback-only and stateless — promote them by lifting their type contract to a generic `AnnotationDetection` interface that both pages satisfy, and reuse the components verbatim on audio. The spectrogram stays audio-specific but exposes an anchor element for the popover.

Boundary stays at "detection selected / created / deleted" events. Above the line, components are shared. Below, each page owns its surface (image bbox SVG vs spectrogram canvas).

## Technical Approach

### Architecture

**Shared (lifted into `src/components/annotation/` or kept in their current paths):**
- `AnnotationToolsSidebar` (`src/components/annotation-tools-sidebar.tsx`) — already stateless, already feature-flag-by-callback. **No code change required**, only a type generalization.
- `AnnotationPickerPopover` (`src/components/annotation-picker-popover.tsx`) — already controlled, takes pre-resolved `hotkeySlots: Species[]` and `lastSpecies: Species | null`. **No code change required**, only a type generalization.
- `useAnnotationShortcuts` (`src/hooks/use-annotation-shortcuts.ts`) — already callback-driven. The audio page calls it for chrome keys; audio-specific keys (Space, Q/E, `[`/`]`, P, L, F, M, +/-, V, R) move into a separate `useAudioPlaybackShortcuts` hook that runs alongside.

**Audio-specific (stays in place):**
- `FftSpectrogram` (`src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx`) — gains a `selectedBoxAnchorRef` ref attached to a 0×0 overlay positioned at the selected box's pixel rect. The popover mounts there via `<PopoverAnchor asChild>`.
- `useAudioPlaybackShortcuts` (new, `src/hooks/use-audio-playback-shortcuts.ts`) — extracts the audio-only keys from today's `useAudioAnnotationShortcuts`.

**New / reshaped types:**
- `AnnotationDetection` interface (`src/types/annotation.ts` or similar) — minimal shape both pages satisfy.
- `AudioDetectionData` reshaped to nest `identification` (matching the DB shape and camera-trap's `DetectionWithIdentification`).

**New server action:**
- `getFrequentAudioSpecies(deploymentId, limit = 9)` in `src/app/audio/annotation-actions.ts` — joins `audioIdentifications ⨝ audioDetections ⨝ audioFiles`, mirrors camera-trap's `getFrequentSpecies` shape and verified/corrected filter, pads with all-species fallback by `FREQUENT_SPECIES_TYPE_ORDER`. (Don't try to add a `modality` switch to `getFrequentSpecies` — the disjoint table joins are clearer as a parallel function.)

### Implementation Phases

#### Phase 1 — Generalize the shared component types

**Goal:** lift the shape contract so both pages can satisfy it. No behavior change, no audio touch yet.

- [x] Create `src/types/annotation.ts` (or extend existing `src/types/`) with `AnnotationIdentification` and `AnnotationDetection`. Camera-only fields (`detectionClass`, `detectionConfidence`) live as optional on the base so audio can omit them.
- [x] In `src/components/annotation-tools-sidebar.tsx`, type the `detections` prop as `AnnotationDetection[]`.
- [x] In `src/components/annotation-picker-popover.tsx`, type `selectedDetection` as `AnnotationDetection | null`.
- [x] Also retype `src/components/detection-card-strip.tsx` and `src/hooks/use-annotation-picker.ts` (both consume detections). Strip's class label + confidence reads guarded behind null/undefined checks for audio.
- [x] `DetectionWithIdentification` now extends `AnnotationDetection` with narrowed camera-trap fields (bbox + required class/confidence).
- [x] Verified `npx tsc --noEmit` clean.

**Success criteria:** lint+typecheck green, no behavior change, camera-trap visually identical.

#### Phase 2 — Audio data plumbing

**Goal:** stand up the data the shared chrome needs (frequent species, last species).

- [x] Add `getFrequentAudioSpecies(deploymentId: number | null, limit = 9)` in `src/app/audio/annotation-actions.ts`. Mirrors `getFrequentSpecies` over audio tables; uses bird-first type order (more natural for audio).
- [x] `src/app/audio/[id]/annotate/[fileId]/page.tsx` calls `getFrequentAudioSpecies(deploymentId, 9)` and passes through.
- [x] `annotation-client.tsx` has `lastSpeciesName` sessionStorage state keyed by `fcat:lastAudioSpecies:${deploymentId}`, updated on every assignment.
- [x] `lastSpecies: Species | null` resolved via `speciesMap`. Currently unused; consumed by the popover in Phase 6.

**Success criteria:** audio page shows a populated frequent-species hotkey row when navigating to a deployment with verified audio identifications; `lastSpeciesName` persists across audio file navigation in the same browser session.

#### Phase 3 — Reshape `AudioDetectionData` to satisfy `AnnotationDetection`

**Goal:** audio detections nest `identification` like the DB schema and like camera-trap.

- [x] `AudioDetectionData` already has nested `identification` (`annotation-client.tsx:69-84`) — verified it satisfies `AnnotationDetection`.
- [x] Renamed `AudioDetectionData.confidence` → `detectionConfidence` (page.tsx mapping updated) so the field name aligns with the shared `AnnotationDetection` contract.
- [x] `AudioBoxData` in `fft-spectrogram.tsx` stays flat — it's a view-model for canvas rendering, not the annotation data contract. The page maps `AudioDetectionData → AudioBoxData` at the render boundary.
- [x] All identification-id reads (assignAudioSpecies, verifyAudioIdentification, etc.) already go through `det.identification.id` — no change needed.
- [x] `getSpeciesColor()` unchanged (keyed by species name).

**Success criteria:** existing audio annotation flow works identically; type matches `AnnotationDetection`.

#### Phase 4 — Spectrogram popover anchor

**Goal:** mount the popover anchored to the selected bbox on the spectrogram canvas.

- [x] `FftSpectrogram` gained `onSpecSizeChange` prop — fires whenever spec area pixel size updates.
- [x] Audio annotation-client tracks `specPx` in state and computes the anchor's pixel rect via the same linear transforms (`timeToNX = t/duration`, `hzToNY = 1 - hz/maxHz`) — offset by `FREQ_AXIS_WIDTH = 70` for the freq-axis gutter.
- [x] `<Popover>` root wraps the layout. Open state = `selectedDetectionId !== null`. Anchor is an absolute 0-rect div under the spectrogram container; `<AnnotationPickerPopover>` renders as sibling of the layout div.
- [x] Approach: render the anchor inside a `relative` wrapper around the spectrogram so it scrolls/resizes with the canvas.

**Success criteria:** clicking a detection box on the spectrogram opens the species picker anchored over it. Popover follows the box during scroll/zoom/freq-axis changes. Closes on Esc, outside click, or deselect.

#### Phase 5 — Server-action adapter (assign species)

**Goal:** let the shared popover call a uniform `onAssignSpecies(detectionId, newSpecies)` callback without changing the server-action signature.

- [x] `handleSelectSpecies(scientificName)` already does the lookup-and-call pattern (also updates `lastSpeciesName` sessionStorage). The popover's `onAssignSpecies` callback receives the scientific name only.
- [x] `handleAssignSpeciesByIndex(index)` and `handleAssignLastSpecies()` added; both delegate through `handleSelectSpecies`.
- [x] `assignAudioSpecies` signature unchanged. The adapter pattern hides the identificationId-vs-detectionId divergence from the shared popover.

**Success criteria:** popover hotkey assignment, last-species (`0`), and add-species flow all work on audio.

#### Phase 6 — Replace audio sidebar and shortcuts

**Goal:** swap `SpeciesSidebar` for `AnnotationToolsSidebar`; split shortcuts into shared chrome + audio-specific layer.

- [x] `<SpeciesSidebar>` replaced by `<AnnotationToolsSidebar>`. Camera-only callbacks (`onToggleConfirmedBlank`, `onToggleStarred`, `onToggleSetupDeployment`, `onToggleSetupRetrieval`, `onApplyDateSuggestion`) are omitted; sidebar hides them on undefined.
- [x] Horizontal detection card strip on top of the spectrogram removed (sidebar replaces it).
- [x] Inline-search-on-detection-select effect removed.
- [x] `searchQuery` state + `getVisibleSpecies` helper removed; popover provides its own typeahead.
- [x] `src/hooks/use-audio-playback-shortcuts.ts` created with audio-only keys (Space, [/], Q/E, P, L, N, V, R, F, M, +/-). Editable-field guard preserved. `isPickerOpen` early-return added so playback keys don't fire while picker is open.
- [x] `useAudioAnnotationShortcuts` replaced by `useAnnotationShortcuts` (chrome) + `useAudioPlaybackShortcuts` (playback). Hooks bind disjoint key sets.
- [x] Deletion of `use-audio-annotation-shortcuts.ts` deferred to Phase 7.

**Behavior changes for audio users (document in PR):**
- Plain ArrowLeft/Right now navigates files (was: seek). Use Q/E for fine seek and `[`/`]` for coarse seek.
- `0` key now assigns the last-used species (was: assign species at slot index 10).
- Esc with picker open closes the picker (was: clear search field). Esc with no picker open deselects the box.
- Backspace on empty picker search deletes the selected box.

**Success criteria:** audio page renders the camera-trap-style left sidebar with detection list. Clicking a box opens the popover. All chrome shortcuts behave identically to camera-trap. Audio-only playback shortcuts still work.

#### Phase 7 — Cleanup

- [x] Deleted `src/components/species-sidebar.tsx` (orphaned). Its three reused exports (`NameDisplay`, `DISPLAY_KEY`, `getStoredDisplay`) were already duplicated in `src/lib/species-display.tsx` — updated the 4 importers to point there.
- [x] Deleted `src/hooks/use-audio-annotation-shortcuts.ts` (replaced by `useAnnotationShortcuts` + `useAudioPlaybackShortcuts`).
- [x] Audio client now uses `useNameDisplay()` from `src/lib/species-display`, matching camera-trap (cross-tab sync via custom event).
- [x] `npx tsc --noEmit` clean.
- [x] `npm run lint` clean for touched files (only pre-existing warnings remain).
- [x] `npm run test:run` — 638/639 passing. One unrelated failure in `tests/integration/camera-trap-verification.test.ts > updateSpecies cascades scientificName change to identifications` exists on the pre-change tree (verified via `git stash`) — not caused by this work.
- [ ] E2E smoke test (load audio page → click box → assign species hotkey → verify) — manual verification needed in a browser; not added to automated suite in this PR.

## Alternative Approaches Considered

- **Adapter / context layer.** Same end state, but shared components consume an `AnnotationContext` provider. Cleaner for >2 modalities; YAGNI for two. Rejected.
- **Copy-and-tweak per page.** Duplicate camera-trap chrome into audio-specific files. Drift returns immediately. Explicitly rejected by the brainstorm.
- **Add `modality` param to `getFrequentSpecies`.** Camera-trap's joins are hard-wired to `identifications/detections/images`; audio tables are disjoint (`audioIdentifications/audioDetections/audioFiles`). A `modality` switch becomes a giant if/else inside one function — a parallel `getFrequentAudioSpecies` is clearer.
- **Promote `AnnotationToolsSidebar` and the popover into a new `src/components/annotation/` directory.** Worth doing eventually for discoverability, but not required for the refactor — leave the move for a separate cleanup PR.

## Acceptance Criteria

### Functional Requirements

- [ ] Audio annotation page renders `AnnotationToolsSidebar` on the left (same component camera-trap uses).
- [ ] Clicking a detection box on the spectrogram opens `AnnotationPickerPopover` anchored over it.
- [ ] Popover follows the box during spectrogram scroll/zoom/freq-axis changes.
- [ ] Popover closes on Esc, outside click, or detection deselect.
- [ ] Hotkeys 1-9 assign species from the frequent-species slots; `0` assigns the last-used species.
- [ ] Backspace on empty picker search deletes the selected box.
- [ ] Last-species persists across audio file navigation in the same browser session (sessionStorage scoped to `deploymentId`).
- [ ] Frequent-species slots are computed per audio deployment and stable for the page lifetime.
- [ ] Plain ArrowLeft/Right navigates files; Q/E seeks; behavior matches the documented audio shortcut list.
- [ ] Camera-trap annotation page is visually and behaviorally unchanged.

### Non-Functional Requirements

- [ ] No new server action without `requirePermission()`.
- [ ] `getFrequentAudioSpecies` deduplicates by species, returns at most 9 slots, and pads from all-species when there are fewer than 9 verified identifications.
- [ ] Spectrogram anchor positioning uses the existing `(time, freq) → (px, py)` transform — no parallel coord math.
- [ ] No regression in spectrogram playback, gain, freq-max, or colormap controls.

### Quality Gates

- [ ] `npm run lint` clean.
- [ ] `npm run test:run` green (Vitest unit + integration).
- [ ] Manual smoke test of camera-trap annotation page (regression check).
- [ ] Manual smoke test of audio annotation page (full new flow).
- [ ] PR description documents the four behavior changes for audio users (arrow-key, `0`-key, Esc, Backspace).

## Dependencies & Prerequisites

- The recent camera-trap commits (`573335e`, `16f7df4`, `6798dae`, `adee29d`) are already on this branch (`feat/birdnet-audio-analysis`).
- No new npm packages required.
- No DB schema changes required for the parity itself. (Audio's lack of `starred`/`confirmedBlank`/`setupTag` is fine — those features simply hide via undefined callbacks.)

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Spectrogram anchor positioning drifts during async redraws | Med | Med | Hook anchor reposition into the same redraw cycle the spectrogram already runs (single source of truth for transforms). Test with rapid scroll + zoom. |
| Audio users complain about arrow-key behavior change (was seek, now nav) | Med | Low | Document in PR + brief in-app changelog if there's a precedent. Keep Q/E for seek so muscle memory has a fallback. |
| `getFrequentAudioSpecies` returns wrong scope (project vs deployment) | Low | Med | Mirror camera-trap exactly — `(deploymentId, 9)` per page load. Verify the SQL filter against real audio data. |
| `AnnotationToolsSidebar` reads a camera-only field that wasn't caught in Phase 1 | Low | Med | The sidebar's detection rendering is via `<DetectionCardStrip>` — audit `annotation-toolbar.tsx:14-29` (`DetectionWithIdentification`) and the strip itself. Type generalization in Phase 1 surfaces any miss. |
| Process-explosion gotcha (`docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md`) re-introduces if popover open/close re-fires spectrogram fetches | Low | High | Popover open/close does not trigger spectrogram regen — only canvas re-render. Verify no `useEffect` keyed on `selectedDetectionId` calls into audio cache. |
| Picker focus-trap conflicts with audio playback Space key | Med | Low | Picker search input is editable; the editable-field guard in `useAnnotationShortcuts` already exempts the search ref from chrome shortcut handling. Audio playback shortcuts hook needs the same guard. |
| `audioFiles` records have `null` `deploymentId` | Low | Med | `getFrequentAudioSpecies(null, 9)` should fall back to project-scope or all-time. Mirror camera-trap's null handling. |

## Open Questions (resolve in PR review or follow-up)

1. **Verification flow** — keep audio's per-detection V/R shortcuts and "verify all and advance" Enter, OR unify on camera-trap's "verify all and advance only"? **Default in this plan:** keep both; V/R lives in `useAudioPlaybackShortcuts`, Enter is shared.
2. **`SpeciesSidebar` final fate** — delete after Phase 6 or keep as deprecated? **Default:** delete; add a separate cleanup commit at end of PR.
3. **Server-action signature alignment** (`assignSpecies(detectionId)` vs `assignAudioSpecies(identificationId)`) — align in this PR or follow-up? **Default:** follow-up. Adapter callback (Phase 5) lets us defer this without blocking the UX work.
4. **Move shared components into `src/components/annotation/`** — yes, but follow-up PR. Keep this PR focused on behavior and types.
5. **Frequent-species scope for audio** — per-deployment (matches camera-trap) or per-audio-job? **Default:** per-deployment; matches camera-trap mental model.

## Resource Requirements

Single-developer work, ~1-2 days. No external dependencies, no infra changes, no new env vars.

## Future Considerations

- Once the chrome is shared, future fixes (better picker focus management, smarter hotkey collision avoidance, per-user frequent-species weighting) propagate to both modalities for free.
- A third modality (e.g. video) could plug into the same chrome by satisfying `AnnotationDetection` and providing its own canvas + anchor element.
- The eventual `assignSpecies` / `assignAudioSpecies` signature alignment becomes natural once the chrome calls a uniform `onAssignSpecies(detectionId, species)` callback — that's the contract the popover wants.

## References & Research

### Internal references

**Camera-trap chrome (lift these):**
- `src/components/annotation-tools-sidebar.tsx` (sidebar — stateless, callback-gated features)
- `src/components/annotation-picker-popover.tsx:47-68` (picker prop type)
- `src/hooks/use-annotation-shortcuts.ts:20-52` (chrome shortcuts options)

**Camera-trap caller (mirror this wiring):**
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:524-651` (popover mount + anchor pattern)
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:133-141` (last-species sessionStorage)
- `src/app/camera-trap/actions.ts:4581-4644` (`getFrequentSpecies` reference)

**Audio surface (target of refactor):**
- `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx:160-625`
- `src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx:69-92` (`AudioBoxData` + `SpectrogramMethods`)
- `src/app/audio/annotation-actions.ts` (existing actions)
- `src/hooks/use-audio-annotation-shortcuts.ts` (to be split)
- `src/components/species-sidebar.tsx` (orphan after Phase 6)

**Schema:**
- `src/db/schema.ts:781-828` (audio detections + identifications — note: no `starred`/`confirmedBlank`/`setupTag` on `audioFiles`)

### Related documents

- `docs/brainstorms/2026-05-10-audio-annotation-ux-parity-brainstorm.md` (this plan's source brainstorm)
- `docs/plans/2026-04-21-feat-annotation-contextual-picker-plan.md` (original popover design — anchor strategy still applies)
- `docs/plans/2026-05-03-fix-annotation-popover-hotkey-bugs-plan.md` (Esc / `0` / Enter-after-delete fixes — already in `useAnnotationShortcuts`, audio inherits for free)
- `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md` (background-task dedup pattern — verify popover events don't re-trigger audio cache)

### Recent commits (already on branch)

- `573335e` fix(camera-trap): restore SpeciesSidebar exports for audio caller
- `16f7df4` fix(camera-trap): allow arrow-key image nav while picker is focused
- `6798dae` fix(camera-trap): annotation popover Esc / 0=last species / delete-Enter
- `adee29d` fix(camera-trap): delete bbox with Backspace/Supr on empty species search
