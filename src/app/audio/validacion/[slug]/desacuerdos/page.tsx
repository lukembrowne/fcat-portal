import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { birdnetValidationCampaigns } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { resolveSpeciesFromSlug } from "@/lib/species-slug-server";
import { getDisagreements } from "@/app/audio/validacion/actions";
import {
  NAME_LANG_COOKIE,
  parseNameLang,
  resolveDisplayName,
} from "@/app/audio/validacion/name-language";

import { DisagreementTable } from "./disagreement-table";

export const metadata = { title: "Desacuerdos entre revisores" };

/**
 * Clips where reviewers gave different answers.
 *
 * Diagnostic, not a workflow: the designated primary's answer is already
 * authoritative for the fit, so nothing here needs adjudicating. The value is
 * seeing *what* reviewers disagree about — which is where congener confusion
 * and the "perfect confounding frog" show up.
 *
 * Unlike the review queue, this page deliberately shows every reviewer's
 * answer. The blinding protects the judgment while it is being made; once it
 * is recorded, comparison is the point.
 */
export default async function DisagreementsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requirePermission("grabaciones", "viewer");
  const { slug } = await params;

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) notFound();

  const [campaign] = await db
    .select()
    .from(birdnetValidationCampaigns)
    .where(eq(birdnetValidationCampaigns.species, target.scientificName))
    .orderBy(desc(birdnetValidationCampaigns.createdAt))
    .limit(1);

  if (!campaign) notFound();

  const result = await getDisagreements(campaign.id);
  const rows = result.success ? result.data : [];

  const displayName = resolveDisplayName(
    target,
    parseNameLang((await cookies()).get(NAME_LANG_COOKIE)?.value)
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Desacuerdos</h1>
          <p className="text-sm text-muted-foreground">
            {displayName} —{" "}
            <span className="italic">{target.scientificName}</span>
          </p>
        </div>
        <Link
          href={`/audio/validacion/${slug}`}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Volver a la especie
        </Link>
      </header>

      <p className="text-xs text-muted-foreground">
        Grabaciones donde los revisores no dieron la misma respuesta. El modelo
        usa la respuesta del revisor principal; esta vista sirve para entender
        en qué difieren y calibrar a quienes están aprendiendo.
      </p>

      {!result.success ? (
        <p className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
          {result.error}
        </p>
      ) : (
        <DisagreementTable rows={rows} />
      )}
    </div>
  );
}
