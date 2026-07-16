"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createSiteShareLink,
  revokeSiteShareLink,
} from "../../resultados/actions";
import { Button } from "@/components/ui/button";
import {
  Share2,
  Copy,
  Check,
  MessageCircle,
  Trash2,
  Eye,
  Calendar,
} from "lucide-react";

// Mirrors the intro copy used elsewhere so the landowner always gets the same one.
const WHATSAPP_PREFIX =
  "Hola, aquí están los resultados del monitoreo de biodiversidad en su finca: ";

export interface SharePanelLink {
  url: string;
  createdAt: Date;
  createdBy: string;
  viewCount: number;
  firstViewedAt: Date | null;
  lastViewedAt: Date | null;
}

interface SharePanelProps {
  siteId: string;
  /** Active (non-revoked) link, or null when nothing has been published yet. */
  link: SharePanelLink | null;
}

/** "hace N días" relative label. */
function relativeDays(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "hoy";
  if (days === 1) return "hace 1 día";
  return `hace ${days} días`;
}

/**
 * Always-open share panel for the page builder. Unlike the popover button, the
 * link, WhatsApp action, and visit stats are visible at a glance above the
 * builder — no extra click to reach them.
 */
export function SharePanel({ siteId, link }: SharePanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleCreate() {
    setError(null);
    startTransition(async () => {
      const result = await createSiteShareLink(siteId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleRevoke() {
    if (
      !confirm(
        "¿Revocar este enlace? Dejará de funcionar para cualquiera que lo tenga."
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await revokeSiteShareLink(siteId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const input = document.getElementById(
        `share-url-${siteId}`
      ) as HTMLInputElement | null;
      input?.select();
    }
  }

  // No active link yet — a simple publish card.
  if (!link) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Enlace público</p>
            <p className="text-xs text-muted-foreground">
              Aún no se ha publicado. Cree un enlace para compartir esta página
              con el propietario.
            </p>
          </div>
          <Button
            onClick={handleCreate}
            disabled={pending}
            size="sm"
            className="gap-2"
          >
            <Share2 className="h-4 w-4" />
            {pending ? "Publicando…" : "Publicar enlace"}
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(
    WHATSAPP_PREFIX + link.url
  )}`;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Enlace público</p>
          <p className="text-xs text-muted-foreground">
            Solo quien tenga este enlace puede ver los resultados.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
          <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
          Activo
        </span>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={`share-url-${siteId}`}
          type="text"
          readOnly
          value={link.url}
          onClick={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded bg-muted px-2 py-1.5 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleCopy(link.url)}
            className="flex-1 gap-1.5 sm:flex-none"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copiado
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copiar
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            asChild
            className="flex-1 gap-1.5 sm:flex-none"
          >
            <a href={whatsappHref} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp
            </a>
          </Button>
        </div>
      </div>

      {/* Visit stats */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5" />
          {link.viewCount === 0
            ? "Aún sin visitas"
            : `${link.viewCount} ${
                link.viewCount === 1 ? "visita" : "visitas"
              }`}
          {link.lastViewedAt && (
            <span>· última {relativeDays(link.lastViewedAt)}</span>
          )}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5" />
          Creado por {link.createdBy} ·{" "}
          {link.createdAt.toLocaleDateString("es-EC")}
        </span>
      </div>

      <div className="flex items-center justify-end border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRevoke}
          disabled={pending}
          className="gap-1.5 text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {pending ? "Revocando…" : "Revocar enlace"}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
