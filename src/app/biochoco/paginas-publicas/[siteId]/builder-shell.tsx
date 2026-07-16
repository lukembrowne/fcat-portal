"use client";

import Link from "next/link";
import { PageBuilder } from "../../resultados/[siteId]/page-builder";
import { SharePanel } from "./share-panel";
import type { PageConfig } from "@/lib/landowner/page-config";

interface SiteShareLink {
  token: string;
  url: string;
  createdAt: Date;
  createdBy: string;
  label: string | null;
  pageConfig: PageConfig;
  viewCount: number;
  firstViewedAt: Date | null;
  lastViewedAt: Date | null;
}

interface BuilderShellProps {
  siteId: string;
  siteName: string;
  /** Active (non-revoked) share link + its effective page config, or null. */
  shareLink: SiteShareLink | null;
}

export function BuilderShell({ siteId, siteName, shareLink }: BuilderShellProps) {
  return (
    <div className="space-y-6 min-w-0">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground">
        <Link
          href="/biochoco/paginas-publicas"
          className="hover:text-foreground"
        >
          Páginas públicas
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground font-medium">{siteName}</span>
      </nav>

      {/* Header */}
      <header className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{siteName}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Página pública que verá el propietario de la finca.
        </p>
      </header>

      {/* Always-open share panel: link, WhatsApp, and visit stats up front. */}
      <SharePanel
        siteId={siteId}
        link={
          shareLink
            ? {
                url: shareLink.url,
                createdAt: shareLink.createdAt,
                createdBy: shareLink.createdBy,
                viewCount: shareLink.viewCount,
                firstViewedAt: shareLink.firstViewedAt,
                lastViewedAt: shareLink.lastViewedAt,
              }
            : null
        }
      />

      {shareLink && (
        <PageBuilder
          siteId={siteId}
          token={shareLink.token}
          initialConfig={shareLink.pageConfig}
        />
      )}
    </div>
  );
}
