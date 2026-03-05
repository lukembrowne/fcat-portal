"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createShareLink, revokeShareLink } from "../actions";

interface ShareLinkData {
  id: number;
  token: string;
  label: string | null;
  createdBy: string;
  createdAt: string | null;
}

interface ShareLinksSectionProps {
  deploymentId: number;
  shareLinks: ShareLinkData[];
}

export function ShareLinksSection({
  deploymentId,
  shareLinks,
}: ShareLinksSectionProps) {
  const [label, setLabel] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    setError(null);
    setNewUrl(null);
    startTransition(async () => {
      const result = await createShareLink(deploymentId, label || undefined);
      if (result.success) {
        setNewUrl(result.data.url);
        setLabel("");
        copyToClipboard(result.data.url);
      } else {
        setError(result.error);
      }
    });
  }

  function handleRevoke(tokenId: number) {
    setError(null);
    startTransition(async () => {
      const result = await revokeShareLink(tokenId);
      if (!result.success) {
        setError(result.error);
      }
      setConfirmRevokeId(null);
    });
  }

  async function copyToClipboard(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API not available — URL is shown in the UI
    }
  }

  function handleCopyExisting(link: ShareLinkData) {
    const url = `${window.location.origin}/public/share/${link.token}`;
    copyToClipboard(url);
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-lg">Compartir</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Create new share link */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Etiqueta (ej. Sr. Garcia)"
            className="flex-1 px-3 py-2 border rounded-md text-sm bg-background"
          />
          <Button onClick={handleCreate} disabled={isPending} size="sm">
            {isPending ? "Creando..." : "Crear enlace"}
          </Button>
        </div>

        {/* Newly created URL */}
        {newUrl && (
          <div className="p-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md mb-4">
            <p className="text-sm font-medium text-green-800 dark:text-green-200 mb-1">
              Enlace creado y copiado al portapapeles
            </p>
            <input
              type="text"
              readOnly
              value={newUrl}
              className="w-full px-2 py-1 text-xs bg-white dark:bg-black border rounded font-mono"
              onFocus={(e) => e.target.select()}
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive mb-4">{error}</p>
        )}

        {/* Existing share links */}
        {shareLinks.length > 0 ? (
          <div className="space-y-2">
            {shareLinks.map((link) => (
              <div
                key={link.id}
                className="flex items-center justify-between p-2 bg-muted/50 rounded-md"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {link.label || `Enlace #${link.id}`}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      ...{link.token.slice(-8)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {link.createdBy}
                    {link.createdAt && ` · ${new Date(link.createdAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex gap-1 ml-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopyExisting(link)}
                  >
                    {copiedId === link.id ? "Copiado" : "Copiar"}
                  </Button>
                  {confirmRevokeId === link.id ? (
                    <div className="flex gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRevoke(link.id)}
                        disabled={isPending}
                      >
                        Confirmar
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmRevokeId(null)}
                      >
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmRevokeId(link.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      Revocar
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No hay enlaces compartidos activos para esta instalación.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
