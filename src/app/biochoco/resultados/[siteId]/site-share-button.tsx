"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSiteShareLink, revokeSiteShareLink } from "../actions";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Share2, Copy, Trash2, MessageCircle, Check } from "lucide-react";

interface ExistingLink {
  token: string;
  url: string;
  createdAt: Date;
  createdBy: string;
  label: string | null;
}

interface SiteShareButtonProps {
  siteId: string;
  existingLink: ExistingLink | null;
}

const WHATSAPP_PREFIX =
  "Hola, aquí están los resultados del monitoreo de biodiversidad en su finca: ";

export function SiteShareButton({ siteId, existingLink }: SiteShareButtonProps) {
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
      try {
        await navigator.clipboard.writeText(result.data.url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard API may be unavailable in some browsers — that's
        // fine, the URL will appear in the popover after refresh.
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
      // Fallback: select the input so the user can copy manually
      const input = document.getElementById(
        `share-url-${siteId}`
      ) as HTMLInputElement | null;
      input?.select();
    }
  }

  // No active link — single "Compartir" button creates one and copies it
  if (!existingLink) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCreate}
          disabled={pending}
          className="gap-2"
        >
          <Share2 className="h-4 w-4" />
          {pending ? "Creando…" : "Compartir"}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  // Active link — popover with copy / WhatsApp / revoke
  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(
    WHATSAPP_PREFIX + existingLink.url
  )}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Share2 className="h-4 w-4" />
          Compartir
          <span className="hidden sm:inline text-xs text-muted-foreground">
            · activo
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-medium">Enlace público</p>
          <p className="text-xs text-muted-foreground">
            Solo quien tenga este enlace puede ver los resultados.
          </p>
        </div>

        <input
          id={`share-url-${siteId}`}
          type="text"
          readOnly
          value={existingLink.url}
          onClick={(e) => e.currentTarget.select()}
          className="w-full text-xs bg-muted rounded px-2 py-1.5 font-mono"
        />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleCopy(existingLink.url)}
            className="flex-1 gap-1.5"
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
          <Button size="sm" variant="secondary" asChild className="flex-1 gap-1.5">
            <a href={whatsappHref} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp
            </a>
          </Button>
        </div>

        <div className="text-xs text-muted-foreground">
          Creado por {existingLink.createdBy}
          {" · "}
          {existingLink.createdAt.toLocaleDateString("es-EC")}
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={handleRevoke}
          disabled={pending}
          className="w-full text-destructive hover:text-destructive gap-1.5"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {pending ? "Revocando…" : "Revocar enlace"}
        </Button>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
