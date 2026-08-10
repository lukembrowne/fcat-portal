import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { birdnetValidationCampaigns } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { resolveSpeciesFromSlug } from "@/lib/species-slug-server";
import {
  getCampaignProgress,
  getReviewQueue,
  getReviewerProgress,
} from "@/app/audio/validacion/actions";
import {
  NAME_LANG_COOKIE,
  parseNameLang,
  resolveDisplayName,
} from "@/app/audio/validacion/name-language";
import { batchKey } from "./review-progress";
import { ReviewClient, type ReviewItem } from "./review-client";

export const metadata = {
  title: "Revisión de detecciones",
};

/**
 * Queue page size. Large enough that a reviewer rarely reloads mid-session,
 * small enough that the initial payload stays light.
 */
const QUEUE_SIZE = 50;

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await requirePermission("grabaciones", "editor");
  const { slug } = await params;

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) notFound();

  const [campaign] = await db
    .select()
    .from(birdnetValidationCampaigns)
    .where(
      and(
        eq(birdnetValidationCampaigns.species, target.scientificName),
        isNull(birdnetValidationCampaigns.abandonedReason)
      )
    );

  if (!campaign) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          No se está validando {target.scientificName} en este momento.
        </p>
        <Link href="/audio/validacion" className="text-sm text-sky-700 hover:underline">
          Volver a validación
        </Link>
      </div>
    );
  }

  const [queueResult, progressResult, reviewersResult] = await Promise.all([
    getReviewQueue(campaign.id, QUEUE_SIZE),
    getCampaignProgress(campaign.id),
    getReviewerProgress(campaign.id),
  ]);

  if (!queueResult.success) {
    return <div className="p-6 text-sm text-rose-700">{queueResult.error}</div>;
  }

  const items: ReviewItem[] = queueResult.data.map((row) => ({
    sampleId: row.sampleId,
    confidence: row.confidence,
    binIndex: row.binIndex,
    siteName: row.siteName,
    habitat: row.habitat,
    bandLeftPct: row.bandLeftPct,
    bandRightPct: row.bandRightPct,
    recordedAt: row.recordedAt,
  }));

  const progress = progressResult.success ? progressResult.data : null;

  // The reviewer's OWN completed count, not the campaign's. Under full overlap
  // the denominator is shared but the numerator is personal, and showing the
  // primary reviewer's progress here would both mislead and leak how far
  // someone else has gotten.
  const mine = reviewersResult.success
    ? reviewersResult.data.find((r) => r.email === user.email)
    : undefined;

  const canEdit =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "grabaciones" && (p.role === "editor" || p.role === "admin")
    );

  return (
    <div className="mx-auto max-w-2xl p-4">
      {/*
        Keyed on the batch, so a new batch REMOUNTS the client rather than
        layering fresh server props over stale client state. That is what makes
        "Cargar siguientes" work at all — see `batchKey` for the two bugs.
      */}
      <ReviewClient
        key={batchKey(items)}
        species={target.scientificName}
        displayName={resolveDisplayName(
          target,
          parseNameLang((await cookies()).get(NAME_LANG_COOKIE)?.value)
        )}
        slug={slug}
        items={items}
        reviewedCount={mine?.reviewed ?? 0}
        uncertainCount={mine?.uncertain ?? 0}
        targetSampleSize={progress?.sampled ?? campaign.targetSampleSize}
        campaignId={campaign.id}
        canEdit={canEdit}
      />
    </div>
  );
}
