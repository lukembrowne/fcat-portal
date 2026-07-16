"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SortIcon } from "@/components/sort-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  Pencil,
  Copy,
  Check,
  MessageCircle,
  Trash2,
  Camera,
  Bird,
  Thermometer,
} from "lucide-react";
import { revokeSiteShareLink } from "@/app/biochoco/resultados/actions";
import { getSiteShareUrl } from "./actions";
import type { SitePageStatusKey } from "@/lib/landowner/page-status";
import type { ReadinessStatus } from "../resultados/types";
import type {
  SitePublicPageRow,
  SitePublicPagesSortColumn,
  SortDirection,
} from "./sort";

// Mirrors the copy in SiteShareButton so the landowner gets the same intro.
const WHATSAPP_PREFIX =
  "Hola, aquí están los resultados del monitoreo de biodiversidad en su finca: ";

const STATUS_LABELS: Record<SitePageStatusKey, string> = {
  sin_empezar: "Sin empezar",
  publicado: "Publicado",
  visto: "Visto",
};

const STATUS_COLORS: Record<SitePageStatusKey, string> = {
  sin_empezar: "bg-muted text-muted-foreground",
  publicado: "bg-blue-100 text-blue-800",
  visto: "bg-green-100 text-green-800",
};

const COLUMN_LABELS: Record<SitePublicPagesSortColumn, string> = {
  finca: "Finca",
  estado: "Estado",
  editado: "Última edición",
  vistas: "Vistas",
};

/** "hace N días" relative label for the last time the landowner opened the page. */
function formatViewedRelative(viewedAt: Date): string {
  const days = Math.floor((Date.now() - viewedAt.getTime()) / 86_400_000);
  if (days <= 0) return "hoy";
  if (days === 1) return "hace 1 día";
  return `hace ${days} días`;
}

/** Color for a readiness icon: green (complete) / amber (in progress) / muted (none). */
const READINESS_COLORS: Record<ReadinessStatus, string> = {
  complete: "text-emerald-600",
  in_progress: "text-amber-500",
  none: "text-muted-foreground/40",
};

const CAMERA_TITLES: Record<ReadinessStatus, string> = {
  complete: "Cámaras: verificado",
  in_progress: "Cámaras: en progreso",
  none: "Cámaras: sin datos",
};
const AUDIO_TITLES: Record<ReadinessStatus, string> = {
  complete: "BirdNET: analizado (por revisar)",
  in_progress: "BirdNET: audio sin analizar",
  none: "BirdNET: sin audio",
};
const TEMPERATURE_TITLES: Record<ReadinessStatus, string> = {
  complete: "Temperatura: cargada",
  in_progress: "Temperatura: en progreso",
  none: "Temperatura: sin datos",
};

/** Compact row of three status icons (cameras / audio / temperature). */
function ReadinessIcons({
  cameras,
  audio,
  temperature,
}: {
  cameras: ReadinessStatus;
  audio: ReadinessStatus;
  temperature: ReadinessStatus;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Camera className={`h-4 w-4 ${READINESS_COLORS[cameras]}`}>
        <title>{CAMERA_TITLES[cameras]}</title>
      </Camera>
      <Bird className={`h-4 w-4 ${READINESS_COLORS[audio]}`}>
        <title>{AUDIO_TITLES[audio]}</title>
      </Bird>
      <Thermometer className={`h-4 w-4 ${READINESS_COLORS[temperature]}`}>
        <title>{TEMPERATURE_TITLES[temperature]}</title>
      </Thermometer>
    </div>
  );
}

function SortableHeader({
  column,
  sortBy,
  sortDir,
  className,
}: {
  column: SitePublicPagesSortColumn;
  sortBy: SitePublicPagesSortColumn;
  sortDir: SortDirection;
  className?: string;
}) {
  const isActive = sortBy === column;
  const nextDir: SortDirection = isActive && sortDir === "asc" ? "desc" : "asc";
  const query = new URLSearchParams({ sortBy: column, sortDir: nextDir });

  return (
    <TableHead className={className}>
      <Link
        href={`/biochoco/paginas-publicas?${query.toString()}`}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {COLUMN_LABELS[column]}
        <SortIcon direction={isActive ? sortDir : false} />
      </Link>
    </TableHead>
  );
}

/**
 * Per-row action menu (KTD-4). The share URL is never rendered as visible text
 * or an input — it is fetched on demand when the menu opens and used only to
 * seed the clipboard / a wa.me link.
 */
function RowActions({ siteId }: { siteId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  async function ensureUrl(): Promise<string | null> {
    if (url) return url;
    const res = await getSiteShareUrl(siteId);
    if (res.success) {
      setUrl(res.data);
      return res.data;
    }
    return null;
  }

  async function handleCopy() {
    const u = await ensureUrl();
    if (!u) return;
    try {
      await navigator.clipboard.writeText(u);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — nothing else to fall back to (no visible URL).
    }
  }

  function handleRevoke() {
    if (
      !confirm(
        "¿Revocar este enlace? Dejará de funcionar para cualquiera que lo tenga."
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await revokeSiteShareLink(siteId);
      if (res.success) router.refresh();
    });
  }

  const whatsappHref = url
    ? `https://wa.me/?text=${encodeURIComponent(WHATSAPP_PREFIX + url)}`
    : undefined;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Preload the URL so "WhatsApp" can be a real <a> and "Copiar" is instant.
        if (open) void ensureUrl();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Más acciones"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void handleCopy();
          }}
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied ? "Copiado" : "Copiar enlace"}
        </DropdownMenuItem>
        <DropdownMenuItem asChild disabled={!whatsappHref}>
          <a href={whatsappHref} target="_blank" rel="noopener noreferrer">
            <MessageCircle className="h-4 w-4" />
            WhatsApp
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={pending}
          onSelect={(e) => {
            e.preventDefault();
            handleRevoke();
          }}
        >
          <Trash2 className="h-4 w-4" />
          {pending ? "Revocando…" : "Revocar enlace"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PagesTable({
  rows,
  sortBy,
  sortDir,
}: {
  rows: SitePublicPageRow[];
  sortBy: SitePublicPagesSortColumn;
  sortDir: SortDirection;
}) {
  const router = useRouter();

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center">
        No hay fincas para mostrar.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHeader column="finca" sortBy={sortBy} sortDir={sortDir} />
          <SortableHeader column="estado" sortBy={sortBy} sortDir={sortDir} />
          <TableHead>Datos</TableHead>
          <SortableHeader column="editado" sortBy={sortBy} sortDir={sortDir} />
          <SortableHeader
            column="vistas"
            sortBy={sortBy}
            sortDir={sortDir}
            className="text-right"
          />
          <TableHead className="text-right">Acciones</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.siteId}
            className="cursor-pointer"
            onClick={(e) => {
              // Radix menu content is portaled OUTSIDE this row, so a click that
              // began there is not contained by the row → don't navigate.
              if (!e.currentTarget.contains(e.target as Node)) return;
              router.push(`/biochoco/paginas-publicas/${row.siteId}`);
            }}
          >
            <TableCell>
              <div className="font-medium">{row.siteName}</div>
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className={STATUS_COLORS[row.status.key]}
                >
                  {STATUS_LABELS[row.status.key]}
                </Badge>
                {row.status.personalized && (
                  <Badge variant="outline">Personalizada</Badge>
                )}
                {row.status.key === "visto" && row.status.viewedAt && (
                  <span className="text-xs text-muted-foreground">
                    {formatViewedRelative(row.status.viewedAt)}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell>
              <ReadinessIcons
                cameras={row.readiness.cameras}
                audio={row.readiness.audio}
                temperature={row.readiness.temperature}
              />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {row.lastEditedAt
                ? row.lastEditedAt.toLocaleDateString("es-EC")
                : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.viewCount}
            </TableCell>
            <TableCell className="text-right">
              {/* Stop propagation so trigger / link clicks don't also fire row nav. */}
              <div
                className="flex items-center justify-end gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/biochoco/paginas-publicas/${row.siteId}`}>
                    <Pencil className="h-4 w-4" />
                    Editar
                  </Link>
                </Button>
                {row.hasActiveToken && <RowActions siteId={row.siteId} />}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
