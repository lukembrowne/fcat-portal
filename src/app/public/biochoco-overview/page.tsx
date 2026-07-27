import type { Metadata } from "next";
import { getActiveReportSnapshot, BIOCHOCO_OVERVIEW_SLUG } from "@/lib/public-report-snapshot";
import { CONTENT, DEFAULT_LANG } from "./content";
import { stripSpectrograms } from "./lib/snapshot-transforms";
import { ReportShell } from "./report-shell";

// Cached render, refreshed every 5 minutes and immediately on publish
// (the publish action calls revalidatePath for this route). The page reads a
// single prebuilt snapshot row — never the production BioChoco tables.
export const revalidate = 300;

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

export async function generateMetadata(): Promise<Metadata> {
  const c = CONTENT[DEFAULT_LANG];
  const title = `${c.hero.title} — FCAT`;

  return {
    title,
    description: c.hero.sub,
    openGraph: {
      title: c.hero.title,
      description: c.hero.sub,
      siteName: "Portal FCAT",
      type: "website",
      images: [{ url: `${PUBLIC_BASE_URL}/biochoco-overview/hero.jpg`, alt: c.hero.title }],
    },
  };
}

export default async function BiochocoOverviewPage() {
  const snapshot = await getActiveReportSnapshot(BIOCHOCO_OVERVIEW_SLUG);

  if (!snapshot) {
    const c = CONTENT[DEFAULT_LANG];
    return (
      <div className="space-y-3 py-20 text-center">
        <h1 className="text-2xl font-bold">{c.ui.comingSoonTitle}</h1>
        <p className="text-muted-foreground">{c.ui.comingSoonBody}</p>
      </div>
    );
  }

  // Strip the pre-rendered spectrogram data URIs before the snapshot crosses
  // into the client component — they are megabytes of base64 and would be
  // serialized twice. ReportShell points <img> at the spectrogram route instead.
  return <ReportShell snapshot={stripSpectrograms(snapshot)} />;
}
