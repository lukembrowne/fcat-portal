"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";

interface PhotoShareButtonProps {
  /** Path or absolute URL to the shareable (watermarked large) image. */
  imagePath: string;
  /** Spanish caption to accompany the share. */
  caption: string;
  /** "overlay" = icon-only dark pill (photo corner); "button" = labeled. */
  variant?: "overlay" | "button";
  className?: string;
}

/**
 * Share a single photo. Prefers the native Web Share sheet (phones) and tries
 * to hand it the actual image file; falls back to a wa.me link (desktop or no
 * Web Share). Safe inside a clickable card — click is stopped from bubbling.
 */
export function PhotoShareButton({
  imagePath,
  caption,
  variant = "overlay",
  className = "",
}: PhotoShareButtonProps) {
  const [busy, setBusy] = useState(false);

  async function handleShare(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;

    const absoluteUrl = imagePath.startsWith("http")
      ? imagePath
      : `${window.location.origin}${imagePath}`;

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        setBusy(true);
        let sharedFile = false;
        if (navigator.canShare) {
          try {
            const res = await fetch(absoluteUrl);
            if (res.ok) {
              const blob = await res.blob();
              const file = new File([blob], "FCAT-biodiversidad.jpg", {
                type: blob.type || "image/jpeg",
              });
              if (navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], text: caption });
                sharedFile = true;
              }
            }
          } catch {
            // fall through to URL share
          }
        }
        if (!sharedFile) {
          await navigator.share({ text: caption, url: absoluteUrl });
        }
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // user cancelled
        // otherwise fall through to wa.me
      } finally {
        setBusy(false);
      }
    }

    const wa = `https://wa.me/?text=${encodeURIComponent(`${caption} ${absoluteUrl}`)}`;
    window.open(wa, "_blank", "noopener");
  }

  if (variant === "button") {
    return (
      <button
        type="button"
        onClick={handleShare}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-60 shrink-0 ${className}`}
        aria-label="Compartir foto"
      >
        <Share2 className="w-3.5 h-3.5" />
        Compartir
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      disabled={busy}
      className={`bg-black/50 hover:bg-black/70 disabled:opacity-60 text-white p-1.5 rounded-md ${className}`}
      aria-label="Compartir foto"
    >
      <Share2 className="w-4 h-4" />
    </button>
  );
}
