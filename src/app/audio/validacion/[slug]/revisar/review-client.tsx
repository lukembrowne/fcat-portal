"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  X,
  HelpCircle,
  Loader2,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
} from "lucide-react";

import {
  abandonCampaign,
  listCorrectionSpecies,
  recordReview,
  setReviewCorrection,
  setReviewNote,
} from "@/app/audio/validacion/actions";
import { noteIsDirty, normalizeReviewNote } from "@/lib/birdnet-validation/review-notes";
import type { NameLang } from "@/app/audio/validacion/name-language";
import { xenoCantoUrl } from "@/lib/xeno-canto";
import { measuredBand } from "@/lib/birdnet-validation/clip-geometry";
import { useClipDuration } from "./use-clip-duration";
import { useReviewShortcuts } from "./use-review-shortcuts";
import { SpectrogramOverlay } from "./spectrogram-overlay";
import { LiveSpectrogram, type RenderStats } from "./live-spectrogram";
import { SpectrogramControls } from "./spectrogram-controls";
import { useReviewSpectrogramSettings } from "./use-spectrogram-settings";
import { batchState, canFit, queuePosition, remainingForReviewer } from "./review-progress";
import { CorrectionPicker } from "./correction-picker";
import { ClipNote, type NoteStatus } from "./clip-note";
import { DownloadMenu } from "./download-menu";
import { clearNoteDraft, readNoteDraft, writeNoteDraft } from "./note-drafts";
import { buildCorrectionIndex, type CorrectionEntry } from "./correction-search";
import {
  advanceIfStillOn,
  afterAnswer,
  answerSlot,
  answerVersion,
  applyAnswer,
  closeReopened,
  commitCorrection,
  commitNote,
  hydrateFlow,
  priorAnswer as priorAnswerOf,
  reopenAnswer,
  rollbackAnswer,
  settleCorrection,
  type Outcome,
  type ReviewFlowState,
} from "./review-flow";

export interface ReviewItem {
  sampleId: number;
  confidence: number;
  binIndex: number;
  siteName: string | null;
  habitat: string | null;
  /**
   * Detection extent within the clip, as percentages — the SERVER's estimate,
   * used only until the clip's real duration is known. See clip-geometry.ts.
   */
  bandLeftPct: number;
  bandRightPct: number;
  /** Absolute seconds, for re-deriving the band against the decoded clip. */
  clipStartSeconds: number;
  detectionStartSeconds: number;
  detectionEndSeconds: number;
  /** Wall-clock recording time, or null when the filename carries none. */
  recordedAt: string | null;
  /** The source recording's filename, named after the recording START. */
  filename: string;
}

/** A clip this reviewer already answered, with their OWN answer and note. */
export interface ReviewedItem extends ReviewItem {
  outcome: Outcome;
  correctedSpecies: string | null;
  note: string | null;
}

interface ReviewClientProps {
  species: string;
  displayName: string;
  slug: string;
  /** This batch's unanswered clips, in queue order. */
  items: ReviewItem[];
  /**
   * The caller's most recent answers, oldest first, placed BEHIND the queue
   * so ← reaches them after a reload — with their answer, species and note.
   */
  history: ReviewedItem[];
  /** Keys the browser-side note drafts, so a shared computer keeps them apart. */
  reviewerEmail: string;
  /**
   * The CALLER's own already-reviewed count, not the campaign's. Every
   * reviewer answers every clip, so the denominator is shared but the
   * numerator is personal — and showing someone else's would leak their
   * progress into a deliberately blinded UI.
   */
  reviewedCount: number;
  /** The caller's own uncertain answers, which the fit will not consume. */
  uncertainCount: number;
  targetSampleSize: number;
  campaignId: number;
  canEdit: boolean;
  /** Common-name language, from the validation pages' cookie. */
  nameLang: NameLang;
}

/** How many upcoming clips to warm while the reviewer works on the current one. */
const PREFETCH_AHEAD = 2;

const OUTCOME_LABEL: Record<Outcome, string> = {
  correct: "Correcta",
  incorrect: "Incorrecta",
  uncertain: "No estoy seguro",
};

export function ReviewClient({
  species,
  displayName,
  slug,
  items: queue,
  history,
  reviewerEmail,
  reviewedCount,
  uncertainCount,
  targetSampleSize,
  campaignId,
  canEdit,
  nameLang,
}: ReviewClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Earlier answers sit in front of the queue; the page opens on the first
  // unanswered clip, with ← walking back through them.
  const items = useMemo(() => [...history, ...queue], [history, queue]);
  const historyIds = useMemo(() => new Set(history.map((h) => h.sampleId)), [history]);
  const [index, setIndex] = useState(history.length);
  // This session's own answers and "what it really was" corrections. See
  // review-flow.ts: the server never sends either back.
  const [flow, setFlow] = useState<ReviewFlowState>(() => hydrateFlow(history));
  // Synchronous mirror of `flow`, written on every update. A correction save
  // that returns late must be judged against the answers as they are NOW (see
  // `settleCorrection`), not as of the last render.
  const flowRef = useRef<ReviewFlowState>(flow);
  const updateFlow = useCallback(
    (fn: (prev: ReviewFlowState) => ReviewFlowState) => {
      flowRef.current = fn(flowRef.current);
      setFlow(flowRef.current);
    },
    []
  );
  const answers = flow.answers;
  // Set when "No" is pressed, naming the clip whose picker should take focus.
  // Cleared on any navigation, so going BACK to a "No" clip shows the picker
  // without swallowing the page shortcuts.
  const [focusRequest, setFocusRequest] = useState<{ sampleId: number; n: number } | null>(
    null
  );
  // The correction vocabulary: fetched once, on the first "No".
  const [correctionIndex, setCorrectionIndex] = useState<CorrectionEntry[] | null>(null);
  const [correctionLoadError, setCorrectionLoadError] = useState<string | null>(null);
  const correctionLoadRef = useRef(false);
  // The ONLY thing that shows the BirdNET score. Answering used to reveal it
  // too, which meant the score arrived unbidden 200 times a run and turned the
  // checkbox into a control over nothing but the first glance.
  const [showScores, setShowScores] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Spectrogram display settings, shared across clips and sessions.
  const [specSettings, updateSpecSettings] = useReviewSpectrogramSettings();
  // Open by default. The controls were behind a disclosure while the live
  // canvas was the opt-in path; now that it is the only surface, hiding them
  // just means a reviewer has to discover that the picture is adjustable at
  // all — and the ones who need it most are mid-run on a hard species.
  const [controlsOpen, setControlsOpen] = useState(true);
  const [nyquistHz, setNyquistHz] = useState<number | null>(null);
  // Set when this browser cannot decode the clip. Sticky for the batch: a
  // browser that failed once will fail on every clip, and retrying the decode
  // 200 times to re-learn that would cost the reviewer real time.
  const [liveUnsupported, setLiveUnsupported] = useState(false);

  const onSpecStats = useCallback((stats: RenderStats) => {
    setNyquistHz((prev) => {
      const next = Math.round(stats.sampleRate / 2);
      return prev === next ? prev : next;
    });
  }, []);

  /*
    The live canvas is THE surface; the pre-rendered WebP is now only a
    fallback for a browser that cannot decode the clip.

    It used to be the other way round, with the canvas opted into by opening
    the controls — a hidden performance lever that also meant collapsing the
    panel silently swapped what you were looking at. Measured cost of making it
    unconditional: 27 ms per clip on a current laptop, 183 ms at 6x CPU
    throttle, against a decision that takes a reviewer several seconds.
  */
  const useLive = !liveUnsupported;

  const audioRef = useRef<HTMLAudioElement>(null);
  /*
    Single-flight PER CLIP, not per reviewer.

    A held key must not fire overlapping mutations for the same detection —
    that is what this guards. It was a single boolean, released only when
    `recordReview` resolved, and that made it a lock over the whole queue: the
    UI advances 320 ms after an answer, so any save slower than that silently
    swallowed the NEXT clip's answer. The keystroke did nothing, the reviewer
    pressed again, and it worked the second time. Reported from a full
    200-clip run as "every ~25 clips it freezes after pressing Correcta",
    worst on the easy species where answers come fastest — exactly when the
    gap between two answers is shortest.

    Saves are slow enough for this to bite in the field: each answer is a
    server-action round trip behind five DB queries, racing the four clip and
    spectrogram prefetches this component fires on every advance.
  */
  const inFlightRef = useRef<Set<number>>(new Set());
  /**
   * The latest answer save per clip, resolving to whether it landed. A
   * correction waits on it: sent first, it would be refused for a review that
   * was about to exist.
   */
  const answerSavesRef = useRef<Map<number, Promise<boolean>>>(new Map());

  /*
    Clip notes. Drafts are what the reviewer has typed, per clip, kept for the
    session so ← brings a note back; `savedNotesRef` is what the server holds.
    Earlier answers arrive with their saved note; a queue clip has no review
    row yet, so its only note is a browser-side draft (`note-drafts.ts`).

    Saves run one at a time per clip (`noteChainRef`) and read the draft when
    they RUN, not when queued, so a blur followed quickly by an answer sends
    the latest text once rather than two versions out of order.
  */
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>(() =>
    Object.fromEntries(history.map((h) => [h.sampleId, h.note ?? ""]))
  );
  const noteDraftsRef = useRef<Record<number, string>>(noteDrafts);
  const [savedNotes, setSavedNotes] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(history.map((h) => [h.sampleId, h.note]))
  );
  const savedNotesRef = useRef<Record<number, string | null>>(savedNotes);

  // Drafts typed on unanswered clips before a reload. Read after mount, not
  // in the initializer: the server render has no storage, and reading it
  // there would make the first client render disagree with the HTML.
  useEffect(() => {
    const restored: Record<number, string> = {};
    for (const item of queue) {
      const draft = readNoteDraft(reviewerEmail, item.sampleId);
      if (draft !== null && noteDraftsRef.current[item.sampleId] === undefined) {
        restored[item.sampleId] = draft;
      }
    }
    if (Object.keys(restored).length === 0) return;
    noteDraftsRef.current = { ...noteDraftsRef.current, ...restored };
    setNoteDrafts(noteDraftsRef.current);
  }, [queue, reviewerEmail]);
  const [noteStatus, setNoteStatus] = useState<Record<number, NoteStatus>>({});
  const noteChainRef = useRef<Map<number, Promise<void>>>(new Map());
  const [noteFocus, setNoteFocus] = useState(0);

  const editNote = useCallback((sampleId: number, value: string) => {
    noteDraftsRef.current = { ...noteDraftsRef.current, [sampleId]: value };
    setNoteDrafts(noteDraftsRef.current);
    // Only an unanswered clip needs the browser copy; an answered one saves
    // to the server on blur.
    if (!flowRef.current.answers[sampleId]) writeNoteDraft(reviewerEmail, sampleId, value);
    setNoteStatus((prev) =>
      prev[sampleId]?.kind === "error" ? { ...prev, [sampleId]: { kind: "idle" } } : prev
    );
  }, [reviewerEmail]);

  const saveNote = useCallback((sampleId: number) => {
    const previous = noteChainRef.current.get(sampleId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const draft = noteDraftsRef.current[sampleId];
      if (draft === undefined || !noteIsDirty(draft, savedNotesRef.current[sampleId])) return;
      setNoteStatus((prev) => ({ ...prev, [sampleId]: { kind: "saving" } }));
      const result = await commitNote(sampleId, normalizeReviewNote(draft), {
        pendingAnswer: answerSavesRef.current.get(sampleId),
        save: setReviewNote,
      });
      if (result.ok) {
        savedNotesRef.current = { ...savedNotesRef.current, [sampleId]: result.note };
        setSavedNotes(savedNotesRef.current);
        clearNoteDraft(reviewerEmail, sampleId);
      }
      setNoteStatus((prev) => ({
        ...prev,
        [sampleId]: result.ok ? { kind: "saved" } : { kind: "error", message: result.error },
      }));
    });
    noteChainRef.current.set(sampleId, next);
  }, [reviewerEmail]);

  const current = items[index];
  const done = index >= items.length;

  // New answers only: an earlier answer loaded behind the queue is already in
  // `reviewedCount`, changed or not.
  const answeredHere = useMemo(
    () => Object.keys(answers).filter((id) => !historyIds.has(Number(id))).length,
    [answers, historyIds]
  );
  const totalReviewed = reviewedCount + answeredHere;

  const clipSrc = current
    ? `/api/audio/validation-clip?sample=${current.sampleId}`
    : null;
  const specSrc = current
    ? `/api/audio/validation-spectrogram?sample=${current.sampleId}`
    : null;

  /*
    The band is positioned against the clip the browser actually decoded, not
    the window the server asked ffmpeg for. Those differ whenever the window
    runs past the end of a recording — BirdNET's last window on a 60 s file is
    one such case, and it put the mark a second and a quarter early on every
    clip drawn from it. `measuredBand` carries the full account.

    `audio.duration` rather than the canvas's own decode, deliberately: it is
    the number `playheadPercent` uses, so band and playhead cannot end up on
    different timelines.
  */
  const clipSeconds = useClipDuration(audioRef, clipSrc);
  const band = useMemo(() => {
    if (!current) return null;
    const fallback = { leftPct: current.bandLeftPct, rightPct: current.bandRightPct };
    return (
      measuredBand(
        current.clipStartSeconds,
        {
          startTime: current.detectionStartSeconds,
          endTime: current.detectionEndSeconds,
        },
        clipSeconds
      ) ?? fallback
    );
  }, [current, clipSeconds]);

  // Warm the next clips so advancing does not stall on a cache miss. Fetching
  // the URL is enough — the route populates the on-disk cache as a side effect.
  useEffect(() => {
    for (let i = index + 1; i <= index + PREFETCH_AHEAD && i < items.length; i++) {
      const id = items[i].sampleId;
      // Warms the audio for BOTH playback and the FFT: `decodeAudio` fetches
      // the same URL, so this prefetch is what turns its download into a
      // cache hit.
      void fetch(`/api/audio/validation-clip?sample=${id}`, { method: "GET" }).catch(
        () => {}
      );
      // Only worth warming when it is what gets drawn. On the live canvas this
      // was ~165 KB per clip fetched, decoded and thrown away.
      if (!useLive) {
        void fetch(`/api/audio/validation-spectrogram?sample=${id}`, {
          method: "GET",
        }).catch(() => {});
      }
    }
  }, [index, items, useLive]);

  // Autoplay on advance. Blocked autoplay is not an error — the reviewer can
  // press space.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play().catch(() => {});
  }, [index]);

  const replay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play().catch(() => {});
  }, []);

  /** Play/pause without moving the position — what space does everywhere else. */
  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const answer = useCallback(
    (outcome: Outcome) => {
      if (!current) return;
      const sampleId = current.sampleId;
      if (inFlightRef.current.has(sampleId)) return;
      inFlightRef.current.add(sampleId);
      // Optimistic: mark the answer, advance, and persist in the background.
      // Blocking the queue on a round-trip is what makes review feel slow, and
      // this loop runs 40,000 times. Leaving "No" also drops the correction
      // locally — `recordReview` clears it on the server.
      const prior = priorAnswerOf(flowRef.current, sampleId);
      updateFlow((prev) => applyAnswer(prev, sampleId, outcome));
      setError(null);

      const saved = recordReview(sampleId, outcome)
        .then((result) => {
          if (!result.success) {
            setError(result.error);
            // Roll the row back so the count never overstates what was saved.
            updateFlow((prev) => rollbackAnswer(prev, sampleId, prior));
          }
          return result.success;
        })
        .catch(() => {
          setError("No se pudo guardar la revisión");
          updateFlow((prev) => rollbackAnswer(prev, sampleId, prior));
          return false;
        })
        .finally(() => {
          inFlightRef.current.delete(sampleId);
        });
      answerSavesRef.current.set(sampleId, saved);
      // A note typed before answering rides in behind the answer. A no-op
      // when there is nothing new to send.
      saveNote(sampleId);

      if (afterAnswer(outcome) === "ask-species") {
        // "No" stays on the clip and asks what it really was. The answer is
        // already saved; the species is an optional second write.
        setFocusRequest((prev) => ({ sampleId, n: (prev?.n ?? 0) + 1 }));
        return;
      }

      setFocusRequest(null);
      // Brief pause so the pressed button lights up before the clip changes —
      // without it a held key reads as nothing having happened. Guarded: if
      // anything else moved the queue off this clip in the meantime, this
      // advance must not move it a second step.
      window.setTimeout(() => setIndex(advanceIfStillOn(items, sampleId)), 320);
    },
    [current, items, updateFlow, saveNote]
  );

  const back = useCallback(() => {
    setFocusRequest(null);
    updateFlow(closeReopened);
    setIndex((i) => Math.max(0, i - 1));
  }, [updateFlow]);

  const skip = useCallback(() => {
    setFocusRequest(null);
    updateFlow(closeReopened);
    setIndex((i) => i + 1);
  }, [updateFlow]);

  const loadCorrectionSpecies = useCallback(() => {
    correctionLoadRef.current = true;
    // Only async setState here: this runs from an effect.
    void listCorrectionSpecies()
      .then((result) => {
        if (result.success) {
          setCorrectionIndex(buildCorrectionIndex(result.data, species));
          setCorrectionLoadError(null);
        } else setCorrectionLoadError(result.error);
      })
      .catch(() => setCorrectionLoadError("No se pudo cargar la lista de especies"));
  }, [species]);

  const pickerVisible = current ? answerSlot(flow, current.sampleId) === "species" : false;

  // Lazily, on the first clip that needs it: a reviewer who never says "No"
  // never downloads the ~6.5k-label vocabulary.
  useEffect(() => {
    if (pickerVisible && !correctionLoadRef.current) loadCorrectionSpecies();
  }, [pickerVisible, loadCorrectionSpecies]);

  const commitCorrectionFor = useCallback(
    async (sampleId: number, chosen: string | null) => {
      // The answer generation this correction belongs to. If the clip is
      // answered again before the save returns, the result is stale.
      const version = answerVersion(flowRef.current, sampleId);
      const result = await commitCorrection(sampleId, chosen, {
        pendingAnswer: answerSavesRef.current.get(sampleId),
        save: setReviewCorrection,
      });
      const settled = settleCorrection(flowRef.current, sampleId, version, result, chosen);
      if (settled.state !== flowRef.current) updateFlow(() => settled.state);
      if (settled.advance) {
        setFocusRequest(null);
        // Advance from THIS clip only — never skip one the reviewer has
        // since moved to.
        setIndex(advanceIfStillOn(items, sampleId));
      }
      return settled.commit;
    },
    [items, updateFlow]
  );

  useReviewShortcuts(
    index,
    {
      onAnswer: answer,
      onToggle: toggle,
      onReplay: replay,
      onBack: back,
      onSkip: skip,
      onNote: () => setNoteFocus((n) => n + 1),
    },
    !done
  );

  if (done) {
    const state = batchState(totalReviewed, targetSampleSize);
    const remaining = remainingForReviewer(totalReviewed, targetSampleSize);
    const fitReady = canFit(totalReviewed, uncertainCount);

    const discard = () => {
      const reason = window.prompt(
        `Motivo para dejar de validar ${displayName}:`
      );
      if (!reason) return;
      setError(null);
      void abandonCampaign(campaignId, reason).then((result) => {
        if (!result.success) setError(result.error);
        else router.push(`/audio/validacion/${slug}`);
      });
    };

    return (
      <div className="space-y-3 rounded-lg border bg-card p-6">
        <div>
          <h2 className="text-lg font-semibold">
            {state === "complete" ? "Terminaste esta especie" : "Tanda completada"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Revisaste{" "}
            <strong className="tabular-nums">{answeredHere}</strong> detecciones
            en esta tanda. Tu total en {displayName}:{" "}
            <strong className="tabular-nums">{totalReviewed}</strong> de{" "}
            {targetSampleSize}.
          </p>
        </div>

        {/* Each option says what it does. Landing here with only "Volver a la
            especie" was the dead end — the screen knew the reviewer's position
            and asked nothing of it. */}
        <ul className="space-y-2">
          {/* Batch exhausted is NOT the same as species finished. */}
          {state === "more-available" ? (
            <Choice
              label={`Cargar las siguientes ${Math.min(remaining, queue.length || remaining)}`}
              detail={`Quedan ${remaining} detecciones por revisar en esta especie.`}
              onClick={() => startTransition(() => router.refresh())}
              disabled={pending}
              busy={pending}
              primary
            />
          ) : null}

          {/* Offered on the reviewer's own usable count, matching the fit's own
              refusal — advertising it earlier produces "muestra insuficiente".
              Editor-only because `runFit` is: a reviewer who followed this
              would land on a species page with no button to press. */}
          {canEdit && fitReady ? (
            <Choice
              label="Ajustar el modelo"
              detail="Estima el umbral con lo revisado hasta ahora. Se abre en la página de la especie, con la curva y el umbral."
              href={`/audio/validacion/${slug}`}
              primary={state === "complete"}
            />
          ) : null}

          {canEdit ? (
            <Choice
              label="Descartar esta especie"
              detail="Para cuando queda claro que BirdNET no acierta con esta especie. Se deja de validar sin borrar lo revisado, y se puede recuperar."
              onClick={discard}
            />
          ) : null}

          <Choice
            label="Volver a la especie"
            detail="Progreso, cobertura por sitio y ajustes."
            href={`/audio/validacion/${slug}`}
          />
        </ul>

        {error ? (
          <p className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const priorAnswer = answers[current.sampleId];
  const noteDraft = noteDrafts[current.sampleId] ?? "";

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{displayName}</h1>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="italic">{species}</span>
            {/* Reference recordings for the species being judged, one click
                from the clip rather than a separate search. */}
            <a
              href={xenoCantoUrl(species)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sky-700 hover:underline"
            >
              xeno-canto
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-sm tabular-nums text-muted-foreground">
            <div>
              {totalReviewed} / {targetSampleSize}
            </div>
            {/* Position within the loaded batch. Safe to show only because
                queue order no longer tracks confidence — see presentationOrder. */}
            <div className="text-[11px]">
              {index < history.length
                ? "Ya respondida"
                : `Clip ${queuePosition(index - history.length, queue.length)} de ${queue.length} en esta tanda`}
            </div>
          </div>
          {/* Available throughout, not just at the end: leaving mid-batch is
              normal and every answer is already saved. */}
          <Link
            href={`/audio/validacion/${slug}`}
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          >
            Salir
          </Link>
        </div>
      </header>

      <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-foreground transition-all"
          style={{
            width: `${Math.min(100, (totalReviewed / Math.max(1, targetSampleSize)) * 100)}%`,
          }}
        />
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        {useLive && clipSrc ? (
          <LiveSpectrogram
            src={clipSrc}
            bandLeftPct={band?.leftPct ?? current.bandLeftPct}
            bandRightPct={band?.rightPct ?? current.bandRightPct}
            clipSeconds={clipSeconds}
            audioRef={audioRef}
            settings={specSettings}
            onStats={onSpecStats}
            onUnsupported={() => setLiveUnsupported(true)}
          />
        ) : specSrc ? (
          <SpectrogramOverlay
            src={specSrc}
            bandLeftPct={band?.leftPct ?? current.bandLeftPct}
            bandRightPct={band?.rightPct ?? current.bandRightPct}
            clipSeconds={clipSeconds}
            audioRef={audioRef}
          />
        ) : null}

        <SpectrogramControls
          settings={specSettings}
          onChange={updateSpecSettings}
          open={controlsOpen}
          onToggle={() => setControlsOpen((v) => !v)}
          nyquistHz={nyquistHz}
          unsupported={liveUnsupported}
        />

        <audio ref={audioRef} src={clipSrc ?? undefined} preload="auto" controls className="w-full" />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {/* Each separator trails its item rather than leading the next, so
              when the line wraps on a phone no row starts with a stray "·". */}
          {[
            { key: "site", text: current.siteName ?? "Sitio desconocido", className: "" },
            current.habitat
              ? { key: "habitat", text: current.habitat, className: "" }
              : null,
            // Absent, not "Invalid Date", when the filename carries no stamp.
            current.recordedAt
              ? { key: "time", text: current.recordedAt, className: "tabular-nums" }
              : null,
            // The Drive file is named after the recording START, not the
            // detection time above — this is the string to search for.
            { key: "file", text: current.filename, className: "break-all" },
          ]
            .filter((part): part is { key: string; text: string; className: string } =>
              part !== null
            )
            .map((part, i, parts) => (
              <span key={part.key} className={part.className}>
                {part.text}
                {i < parts.length - 1 ? (
                  <span aria-hidden="true" className="ml-3">
                    ·
                  </span>
                ) : null}
              </span>
            ))}
          {/* Last on the line, after the filename it downloads. */}
          <DownloadMenu sampleId={current.sampleId} />
          {/*
            Blinding: the BirdNET score stays hidden unless the reviewer asks
            for it. Seeing "0.93" before judging a marginal call anchors the
            answer, which correlates the outcome with the predictor and inflates
            the fitted slope — the exact relationship the model is measuring.
            Revealing it AFTER each answer leaked the same way across a run:
            twenty revealed scores teach the reviewer roughly where this
            species' scores sit, and the twenty-first judgment is no longer
            independent of them.
          */}
          <span className="ml-auto">
            {showScores ? (
              <span className="font-medium tabular-nums text-foreground">
                Confianza BirdNET {current.confidence.toFixed(3)}
              </span>
            ) : (
              <span className="italic">Confianza oculta</span>
            )}
          </span>
        </div>
      </div>

      {/*
        One slot, two contents. On a clip answered "No" the species search takes
        the place of the three answer buttons instead of appearing under them,
        where on a laptop it landed below the fold on every "No". The answer
        keys still work from outside the search box either way.
      */}
      {pickerVisible ? (
        <CorrectionPicker
          // Remount per clip: the typed text belongs to one detection. Prefixed
          // because ClipNote is a keyed sibling in this same container: two
          // children sharing a key make React lose track of which is which,
          // and stale pickers piled up on screen as the reviewer moved ← →.
          key={`picker-${current.sampleId}`}
          index={correctionIndex}
          loadError={correctionLoadError}
          onRetryLoad={loadCorrectionSpecies}
          lang={nameLang}
          chosen={flow.corrections[current.sampleId] ?? null}
          focusSignal={
            focusRequest?.sampleId === current.sampleId ? focusRequest.n : 0
          }
          onCommit={(chosen) => commitCorrectionFor(current.sampleId, chosen)}
          onChangeAnswer={() => {
            const sampleId = current.sampleId;
            setFocusRequest(null);
            updateFlow((prev) => reopenAnswer(prev, sampleId));
          }}
          onSkip={skip}
          onBack={back}
        />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <AnswerButton
            outcome="correct"
            icon={<Check className="h-4 w-4" />}
            hint="1 · S"
            active={priorAnswer === "correct"}
            onClick={() => answer("correct")}
          />
          <AnswerButton
            outcome="incorrect"
            icon={<X className="h-4 w-4" />}
            hint="2 · N"
            active={priorAnswer === "incorrect"}
            onClick={() => answer("incorrect")}
          />
          <AnswerButton
            outcome="uncertain"
            icon={<HelpCircle className="h-4 w-4" />}
            hint="3 · U"
            active={priorAnswer === "uncertain"}
            onClick={() => answer("uncertain")}
          />
        </div>
      )}

      <ClipNote
        key={`note-${current.sampleId}`}
        value={noteDraft}
        onChange={(value) => editNote(current.sampleId, value)}
        onBlur={() => {
          // Before an answer there is no review row to hold it; `answer`
          // sends the draft once there is.
          if (flowRef.current.answers[current.sampleId]) saveNote(current.sampleId);
        }}
        answered={priorAnswer !== undefined}
        dirty={noteIsDirty(noteDraft, savedNotes[current.sampleId])}
        status={noteStatus[current.sampleId] ?? { kind: "idle" }}
        focusSignal={noteFocus}
      />

      {/* The arrow keys already did this; nothing said so. The answer buttons
          advertise their keys, so these do too. */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={back}
          disabled={index === 0}
          className="inline-flex items-center gap-1 disabled:opacity-40"
        >
          <ArrowLeft className="h-3 w-3" /> Anterior
          <span className="tabular-nums opacity-70">(←)</span>
        </button>
        <button type="button" onClick={skip} className="inline-flex items-center gap-1">
          Omitir <ArrowRight className="h-3 w-3" />
          <span className="tabular-nums opacity-70">(→)</span>
        </button>
        <button type="button" onClick={toggle} className="inline-flex items-center gap-1">
          Reproducir/pausar <span className="opacity-70">(espacio)</span>
        </button>
        <button type="button" onClick={replay} className="inline-flex items-center gap-1">
          Repetir <span className="opacity-70">(R)</span>
        </button>
      </div>

      {/*
        Its own row, not wedged onto the end of the shortcut list, and the
        warning sits BESIDE the checkbox rather than below it — appearing in a
        block underneath is what pushed the rest of the page down on every
        toggle. The row's height comes from the label, so at normal widths
        turning this on moves nothing.
      */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[11px]">
        <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={showScores}
            onChange={(e) => setShowScores(e.target.checked)}
          />
          Mostrar la confianza de BirdNET
        </label>
        <span className="min-w-[16rem] flex-1 text-amber-800">
          {showScores
            ? "Sesga el modelo: las revisiones dejan de ser independientes del puntaje que se está calibrando. Sólo para inspección."
            : ""}
        </span>
      </div>

      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AnswerButton({
  outcome,
  icon,
  hint,
  active,
  onClick,
}: {
  outcome: Outcome;
  icon: React.ReactNode;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  const tone =
    outcome === "correct"
      ? "hover:border-emerald-500 hover:bg-emerald-50"
      : outcome === "incorrect"
        ? "hover:border-rose-500 hover:bg-rose-50"
        : "hover:border-slate-500 hover:bg-slate-50";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-md border p-3 text-sm transition-colors ${tone} ${
        active ? "border-foreground bg-muted" : ""
      }`}
    >
      <span className="flex items-center gap-1.5 font-medium">
        {icon}
        {OUTCOME_LABEL[outcome]}
      </span>
      <span className="text-[11px] text-muted-foreground tabular-nums">{hint}</span>
    </button>
  );
}

/**
 * One option on the end-of-batch screen: a label and a line saying what it does.
 *
 * Renders as a link or a button depending on whether it navigates, so the
 * three destinations stay real links (right-click, middle-click, keyboard) and
 * only the two actions are buttons.
 */
function Choice({
  label,
  detail,
  href,
  onClick,
  disabled,
  busy,
  primary,
}: {
  label: string;
  detail: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  primary?: boolean;
}) {
  const className = `flex w-full flex-col items-start gap-0.5 rounded-md border p-3 text-left transition-colors disabled:opacity-50 ${
    primary ? "border-foreground bg-muted/60 hover:bg-muted" : "hover:bg-muted/60"
  }`;

  const body = (
    <>
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </>
  );

  return (
    <li>
      {href ? (
        <Link href={href} className={className}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled} className={className}>
          {body}
        </button>
      )}
    </li>
  );
}

/** Kept for the loading state while the first clip warms. */
export function ReviewSkeleton() {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Preparando la cola…
    </div>
  );
}
