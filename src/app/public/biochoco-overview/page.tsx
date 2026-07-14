import type { Metadata } from "next";
import { getActiveReportSnapshot, BIOCHOCO_OVERVIEW_SLUG } from "@/lib/public-report-snapshot";
import { CONTENT, DEFAULT_LANG } from "./content";
import { ReportShell } from "./report-shell";

// Cached render, refreshed every 5 minutes and immediately on publish
// (the publish action calls revalidatePath for this route). The page reads a
// single prebuilt snapshot row — never the production BioChoco tables.
export const revalidate = 300;

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

export async function generateMetadata(): Promise<Metadata> {
  const snapshot = await getActiveReportSnapshot(BIOCHOCO_OVERVIEW_SLUG);
  const c = CONTENT[DEFAULT_LANG];
  const heroId = snapshot?.images[0]?.imageId;
  const images = heroId
    ? [
        {
          url: `${PUBLIC_BASE_URL}/api/public/report-images/${heroId}?size=large`,
          alt: c.title,
        },
      ]
    : [];

  return {
    title: `${c.title} — FCAT`,
    description: c.subtitle,
    openGraph: {
      title: c.title,
      description: c.subtitle,
      siteName: "Portal FCAT",
      type: "website",
      images,
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

  return <ReportShell snapshot={snapshot} />;
}
