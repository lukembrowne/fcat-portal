"use client";

/**
 * Play one validation clip in place: a "Reproducir" button that becomes the
 * cut clip plus its spectrogram.
 *
 * Opened on demand rather than rendered up front, because the first request
 * for a clip makes the server download its whole source recording from Drive
 * and cut it (see `/api/audio/validation-clip`). A table of fifty `<audio>`
 * elements would ask for fifty of those at once.
 */
export function ClipPlayer({
  sampleId,
  open,
  onOpen,
}: {
  sampleId: number;
  open: boolean;
  onOpen: () => void;
}) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="rounded border px-2 py-1 text-[11px] hover:bg-muted"
      >
        Reproducir
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <audio
        controls
        autoPlay
        className="h-8 w-56"
        src={`/api/audio/validation-clip?sample=${sampleId}`}
      />
      {/* Matches the review client: the spectrogram is a server-rendered
          image from a dynamic route, which next/image cannot optimize. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/audio/validation-spectrogram?sample=${sampleId}`}
        alt="Espectrograma"
        className="h-20 w-56 rounded border object-cover"
      />
    </div>
  );
}
