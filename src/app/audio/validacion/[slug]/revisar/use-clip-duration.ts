"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * The playing clip's real duration in seconds, or null until it is known.
 *
 * The server can only say how long a clip SHOULD be; ffmpeg silently returns a
 * shorter file when the requested window runs past the end of the recording,
 * and the spectrogram is rendered from that same short cut. Everything the
 * overlay positions — the detection band, the zoom's centring, the length
 * readout — has to be measured against what arrived, not against what was
 * asked for. See `measuredBand` for the failure this exists to close.
 *
 * `clipSrc` is the clip URL, and the measurement is STORED WITH IT rather than
 * cleared when it changes. Both express "this reading belongs to that clip",
 * but storing it cannot leave a stale value on screen for the frames between
 * the src changing and an effect clearing it — and a band positioned for the
 * clip the reviewer just answered is the exact defect this hook exists to
 * prevent. A mismatch reads as null, so the caller falls back to the server's
 * estimate.
 */
export function useClipDuration(
  audioRef: RefObject<HTMLAudioElement | null>,
  clipSrc: string | null
): number | null {
  const [measured, setMeasured] = useState<{ src: string; duration: number } | null>(
    null
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !clipSrc) return;

    const read = () => {
      const value = audio.duration;
      if (!Number.isFinite(value) || value <= 0) return;
      setMeasured((prev) =>
        prev?.src === clipSrc && prev.duration === value
          ? prev
          : { src: clipSrc, duration: value }
      );
    };

    // Read immediately as well as on the event. A prefetched clip can already
    // have its metadata by the time this effect runs, and `loadedmetadata`
    // does not fire again for a listener that arrives late — which would leave
    // the estimated band in place for exactly the clips that load fastest.
    read();

    // `durationchange` as well as `loadedmetadata`: for a streamed MP4 the
    // first duration reported can be an estimate, corrected once the moov atom
    // is parsed.
    audio.addEventListener("loadedmetadata", read);
    audio.addEventListener("durationchange", read);
    return () => {
      audio.removeEventListener("loadedmetadata", read);
      audio.removeEventListener("durationchange", read);
    };
  }, [audioRef, clipSrc]);

  return measured && measured.src === clipSrc ? measured.duration : null;
}
