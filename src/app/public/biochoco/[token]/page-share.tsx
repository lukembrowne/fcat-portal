"use client";

import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { buildWhatsAppShareUrl, PAGE_SHARE_MESSAGE } from "@/lib/landowner/copy";

interface PageShareProps {
  /** Absolute public URL of this page (shared as the link). */
  publicUrl: string;
  /** Site name, used as the native-share sheet title. */
  title: string;
}

/** WhatsApp brand glyph — lucide has no WhatsApp icon, so inline a simple one. */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.002-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

/**
 * Page-level share affordance (U12): a primary native "Compartir" button (Web
 * Share API when available, falling back to WhatsApp on desktop), an explicit
 * WhatsApp link, and a copy-link button with a "¡Copiado!" confirmation. Shares
 * the PAGE url + one Spanish message. Every icon-only control has a Spanish
 * aria-label.
 */
export function PageShare({ publicUrl, title }: PageShareProps) {
  const [copied, setCopied] = useState(false);
  const waUrl = buildWhatsAppShareUrl(publicUrl);

  async function handleNativeShare() {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title,
          text: PAGE_SHARE_MESSAGE,
          url: publicUrl,
        });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // user cancelled
        // otherwise fall through to WhatsApp
      }
    }
    window.open(waUrl, "_blank", "noopener");
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — no-op (the WhatsApp link still works)
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border bg-muted/30 p-5">
      <div className="space-y-1">
        <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Comparta esta página
        </p>
        <p className="text-xs text-muted-foreground">
          Muéstrele a su familia y vecinos lo que vive en su tierra
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleNativeShare}
          aria-label="Compartir"
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          <Share2 className="h-4 w-4" />
          Compartir
        </button>
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Compartir por WhatsApp"
          className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2 text-sm font-semibold text-white hover:brightness-95"
        >
          <WhatsAppIcon className="h-4 w-4" />
          WhatsApp
        </a>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copiar enlace"
          className="inline-flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-semibold hover:bg-muted"
        >
          {copied ? (
            <>
              <Check className="h-4 w-4 text-emerald-600" />
              ¡Copiado!
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              Copiar enlace
            </>
          )}
        </button>
      </div>
    </section>
  );
}
