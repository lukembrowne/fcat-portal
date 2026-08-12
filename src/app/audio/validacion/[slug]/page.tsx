import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Headphones } from "lucide-react";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  birdnetValidationCampaigns,
  birdnetSpeciesThresholds,
  audioIdentifications,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { resolveSpeciesFromSlug } from "@/lib/species-slug-server";
import {
  getAgreement,
  getCampaignProgress,
  getDisagreements,
  getReviewerProgress,
  getSpeciesOccupancyThresholdStatus,
} from "@/app/audio/validacion/actions";
import { resolveFitEligibleReviews } from "@/lib/birdnet-validation/fit-eligibility";
import {
  binEdges,
  FIT_ELIGIBILITY_REASON_ES,
  SCORE_FLOOR,
} from "@/lib/birdnet-validation/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { xenoCantoUrl } from "@/lib/xeno-canto";
import { stageHint } from "@/app/audio/validacion/labels";
import { StageTag } from "@/app/audio/validacion/stage-tag";
import { PriorityCell } from "@/app/audio/validacion/priority-cell";
import { NameLanguageToggle } from "@/app/audio/validacion/name-language-toggle";
import {
  NAME_LANG_COOKIE,
  describeDisplayName,
  fallbackNote,
  parseNameLang,
} from "@/app/audio/validacion/name-language";
import { FitChart } from "./fit-chart";
import { CampaignControls } from "./campaign-controls";
import { SpeciesNotes } from "./species-notes";
import { NoFilterButton } from "./no-filter-button";
import { OccupancyStatusCard } from "./occupancy-status-card";
import { ReviewerRoster } from "./reviewer-roster";
import { AgreementPanel } from "./agreement-panel";
import {
  summarizeFit,
  isFitStale,
  thresholdImpact,
  formatThresholdWithCi,
  formatFitTimestamp,
  describeModelVersions,
  separationCase,
} from "./fit-summary";

export const metadata = { title: "Validación de especie" };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {hint ? <div className="text-[11px] text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}

export default async function SpeciesValidationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await requirePermission("grabaciones", "viewer");
  const { slug } = await params;

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) notFound();

  const canEdit =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "grabaciones" && (p.role === "editor" || p.role === "admin")
    );
  // Re-running the occupancy batch is a camera-trap admin action (it refits every
  // species in both streams), so an audio reviewer sees the warning and a link
  // rather than a button that would redirect them out of the page.
  const canRunOccupancy =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "camera-trap" && p.role === "admin");

  const [campaign] = await db
    .select()
    .from(birdnetValidationCampaigns)
    .where(eq(birdnetValidationCampaigns.species, target.scientificName))
    .orderBy(desc(birdnetValidationCampaigns.createdAt))
    .limit(1);

  if (!campaign) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 p-4">
        <h1 className="text-xl font-semibold">{target.scientificName}</h1>
        <p className="text-sm text-muted-foreground">
          Esta especie todavía no se está validando.
        </p>
        <Link href="/audio/validacion" className="text-sm text-sky-700 hover:underline">
          Volver a validación
        </Link>
      </div>
    );
  }

  const progressResult = await getCampaignProgress(campaign.id);
  const progress = progressResult.success ? progressResult.data : null;

  const fits = await db
    .select()
    .from(birdnetSpeciesThresholds)
    .where(eq(birdnetSpeciesThresholds.campaignId, campaign.id))
    .orderBy(desc(birdnetSpeciesThresholds.fittedAt));
  const latest = fits[0] ?? null;
  const summary = latest ? summarizeFit(latest) : null;

  // Reviewed observations, for the rug plot under the curve. These are the
  // fit-eligible set — one per clip — so the rug shows exactly the points the
  // fitted curve was estimated from rather than every reviewer's marks stacked.
  const eligible = await resolveFitEligibleReviews(campaign.id);
  const observations = (eligible.ok ? eligible.reviews : [])
    .filter((r) => r.outcome === "correct" || r.outcome === "incorrect")
    .map((r) => ({ conf: r.confidence, outcome: r.outcome }));

  // Every confidence for this species, so threshold impact needs no extra query
  // per candidate value.
  const allConfidences = (
    await db
      .select({ conf: audioIdentifications.confidence })
      .from(audioIdentifications)
      .where(
        and(
          eq(audioIdentifications.species, target.scientificName),
          sql`${audioIdentifications.confidence} IS NOT NULL`
        )
      )
  ).map((r) => r.conf as number);

  const stale =
    latest && progress
      ? isFitStale(latest.nReviewed, progress.reviewed, progress.uncertain)
      : false;

  const [reviewersResult, agreementResult, disagreementsResult, occupancyResult] =
    await Promise.all([
      getReviewerProgress(campaign.id),
      getAgreement(campaign.id),
      getDisagreements(campaign.id),
      getSpeciesOccupancyThresholdStatus(target.scientificName),
    ]);
  const reviewers = reviewersResult.success ? reviewersResult.data : [];
  const agreement = agreementResult.success ? agreementResult.data : [];
  const disagreements = disagreementsResult.success ? disagreementsResult.data : [];
  // Only worth saying when there is a decision in force (then it confirms the
  // models honour it) or when the models are behind one (then it is the fix).
  const occupancy = occupancyResult.success ? occupancyResult.data : null;
  const showOccupancy = occupancy != null && (occupancy.stale || (latest?.isActive ?? false));

  // A fit produced from a different reviewer's answers is not just out of date,
  // it answers a different question — surfaced separately from the count-based
  // staleness warning above.
  const fitReviewerChanged =
    latest != null &&
    latest.primaryReviewerEmail != null &&
    campaign.primaryReviewerEmail != null &&
    latest.primaryReviewerEmail !== campaign.primaryReviewerEmail;

  const impactAtFit =
    summary?.thresholdConf95 != null
      ? thresholdImpact(allConfidences, summary.thresholdConf95)
      : null;
  const impactAtGlobal = thresholdImpact(allConfidences, 0.7);
  // Which side complete separation fell on, when it did. Derived from counts
  // rather than the reason text, which is stored as Spanish prose.
  const separation = summary
    ? separationCase(summary.nReviewed, summary.nCorrect)
    : null;
  const modelVersions = describeModelVersions(latest?.modelVersion ?? null);

  const edges = binEdges(campaign.binCount);
  const nameLang = parseNameLang((await cookies()).get(NAME_LANG_COOKIE)?.value);
  const display = describeDisplayName(target, nameLang);
  // Said out loud, because otherwise the language toggle reads as broken on the
  // ~1-in-12 species that has no Spanish name: the button flips and the heading
  // does not.
  const nameNote = fallbackNote(display.fallback, nameLang);

  const sampled = progress?.sampled ?? 0;
  const canReview = canEdit && sampled > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      {/* A back link, not a peer of the page's actions. It sat in the action
          row labelled "Todas las especies", where it competed for attention
          with the one button that starts the work. */}
      <Link
        href="/audio/validacion"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft className="h-3 w-3" />
        Volver a la lista de especies
      </Link>

      <header className="space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{display.name}</h1>
          <NameLanguageToggle current={nameLang} />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className="italic">{target.scientificName}</span>
          {nameNote ? <span className="text-xs">· {nameNote}</span> : null}
          {/* Reference recordings, for checking a call against known ones. */}
          <a
            href={xenoCantoUrl(target.scientificName)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline"
          >
            xeno-canto
            <ExternalLink className="h-3 w-3" />
          </a>
        </p>
        {/* Stage, its reason and its hint share one line: three stacked
            one-line paragraphs pushed the actions below the fold.
            Priority leads, and is editable here as well as in the table: this
            is the page somebody lands on after reviewing a batch, which is
            when they learn whether the species was worth prioritising. */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <PriorityCell
            campaignId={campaign.id}
            displayName={display.name}
            priority={campaign.priority}
            canEdit={canEdit}
          />
          <StageTag status={campaign.status} />
          {campaign.abandonedReason ? (
            <span className="text-muted-foreground">{campaign.abandonedReason}</span>
          ) : null}
          {stageHint(campaign.status) ? (
            <span className="text-muted-foreground">{stageHint(campaign.status)}</span>
          ) : null}
        </p>
        {/* The table shows this as a tooltip only, so the full sentence has
            to be readable somewhere. */}
        {summary && !summary.usable && summary.reason ? (
          <p className="max-w-xl text-xs text-stone-700">{summary.reason}</p>
        ) : null}
      </header>

      {/* One action strip, with reviewing as the obvious thing to do. The
          controls below it are things you do once per species; this is the
          thing you do two hundred times. */}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/40 p-2">
          {/* Gated on the sample existing, not on progress: `progress.reviewed`
              counts the primary reviewer's answers, so gating on it would hide
              the link from everyone else the moment the primary finished. */}
          {canReview ? (
            <>
              <Link
                href={`/audio/validacion/${slug}/revisar`}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
              >
                <Headphones className="h-4 w-4" />
                Revisar detecciones
              </Link>
              <span className="text-xs tabular-nums text-muted-foreground">
                {progress?.reviewed ?? 0} de {sampled} revisadas
              </span>
            </>
          ) : null}
          {/* Pushed right only when there is a primary action to be pushed away
              from; on a species with no sample yet, "Extraer muestra" IS the
              action and belongs at the left edge. */}
          <div className={canReview ? "ml-auto" : ""}>
            <CampaignControls
              campaignId={campaign.id}
              canEdit={canEdit}
              hasSamples={sampled > 0}
              hasDrawnSample={campaign.sampledAt != null}
              status={campaign.status}
              latestThresholdId={latest?.id ?? null}
              latestIsUsable={summary?.usable ?? false}
              latestIsActive={latest?.isActive ?? false}
              latestIsNoFilter={latest?.source === "no_filter"}
              reviewerCount={progress?.reviewerCount ?? 0}
              species={target.scientificName}
            />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Muestreadas" value={String(progress?.sampled ?? 0)} />
        <Stat
          label="Revisadas"
          value={`${progress?.reviewed ?? 0}`}
          hint={
            progress?.reviewerCount && progress.reviewerCount > 1
              ? `revisor principal · ${progress.uncertain} inciertas`
              : `${progress?.uncertain ?? 0} inciertas`
          }
        />
        <Stat
          label="Correctas"
          value={
            progress && progress.reviewed > 0
              ? `${Math.round((progress.correct / progress.reviewed) * 100)}%`
              : "—"
          }
          hint={`${progress?.correct ?? 0} de ${progress?.reviewed ?? 0}`}
        />
        {/* "0.100" here would read as a fitted number. The floor is a decision
            that nothing is filtered, and it should say that. */}
        <Stat
          label={latest?.source === "no_filter" ? "Filtro" : "Umbral 95%"}
          value={
            latest?.source === "no_filter"
              ? "Sin filtro"
              : (summary?.thresholdConf95?.toFixed(3) ?? "—")
          }
          hint={latest?.isActive ? "aplicado" : "sin aplicar"}
        />
      </div>

      {/* Under the numbers, above the diagnostics: the notes say why this
          species is being validated at all, which is context for everything
          below and for nothing above. */}
      <SpeciesNotes
        campaignId={campaign.id}
        notes={campaign.notes}
        canEdit={canEdit}
      />

      {progress?.fitEligibilityReason ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {FIT_ELIGIBILITY_REASON_ES[progress.fitEligibilityReason]}
        </p>
      ) : null}

      {fitReviewerChanged ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          El ajuste vigente se hizo con las respuestas de{" "}
          {latest!.primaryReviewerEmail}, pero el revisor principal ahora es{" "}
          {campaign.primaryReviewerEmail}. Vuelve a ajustar el modelo.
        </p>
      ) : null}

      {stale ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          El ajuste vigente vio {latest!.nReviewed} revisiones utilizables; hay{" "}
          {(progress?.reviewed ?? 0) - (progress?.uncertain ?? 0)} ahora. Vuelve a
          ajustar el modelo para incorporarlas.
        </p>
      ) : null}

      {/* Applying a threshold changes counts everywhere on read, but occupancy
          models are fitted numbers — they stay on the old filter until the batch
          runs again. This is where that gets said, and fixed. */}
      {showOccupancy ? (
        <OccupancyStatusCard status={occupancy!} canRun={canRunOccupancy} />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <ReviewerRoster
          campaignId={campaign.id}
          canEdit={canEdit}
          sampled={progress?.sampled ?? 0}
          reviewers={reviewers}
        />
        <AgreementPanel
          slug={slug}
          hasPrimary={campaign.primaryReviewerEmail != null}
          agreement={agreement}
          disagreementCount={disagreements.length}
        />
      </div>

      {latest && summary && !summary.usable ? (
        <Card>
          <CardHeader>
            <CardTitle>Sin umbral utilizable</CardTitle>
            <p className="text-xs text-muted-foreground">
              Ajustado el {formatFitTimestamp(latest.fittedAt)}
            </p>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{summary.reason}</p>
            <p className="text-xs text-muted-foreground">
              Revisadas {summary.nReviewed} (correctas {summary.nCorrect}).
            </p>

            {/* The two sides of complete separation share a failure and share
                no advice. Saying only "no se puede estimar un umbral" leaves the
                all-correct species looking like a dead end when it is the
                opposite: the filter is too tight, not too loose. */}
            {separation === "all-correct" ? (
              <div className="space-y-1 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-950">
                <p className="font-medium">
                  BirdNET acertó en las {summary.nReviewed} revisiones, incluidas
                  las de puntaje más bajo.
                </p>
                <p>
                  No hay error que modelar, así que no hay umbral que estimar.
                  Ojo con lo que eso implica: al no aplicar un umbral propio, esta
                  especie sigue filtrada por el valor global de 0.70
                  {impactAtGlobal.dropped > 0 ? (
                    <>
                      , que descarta{" "}
                      <strong className="tabular-nums">
                        {impactAtGlobal.dropped.toLocaleString("es-EC")}
                      </strong>{" "}
                      de {allConfidences.length.toLocaleString("es-EC")}{" "}
                      detecciones que la revisión sugiere que son correctas
                    </>
                  ) : null}
                  .
                </p>
                <p>
                  Para estimar un umbral haría falta encontrar errores: revisar
                  más clips de las bandas bajas. Si no aparecen, la conclusión es
                  que esta especie no necesita filtro.
                </p>
                {canEdit ? (
                  <div className="pt-1">
                    <NoFilterButton
                      campaignId={campaign.id}
                      displayName={display.name}
                      droppedByGlobal={impactAtGlobal.dropped}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {separation === "all-incorrect" ? (
              <div className="space-y-1 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-950">
                <p className="font-medium">
                  Ninguna de las {summary.nReviewed} revisiones fue correcta.
                </p>
                <p>
                  Ningún umbral rescata esta especie: BirdNET no la acierta en
                  ninguna banda de puntaje. Lo indicado es descartarla y excluir
                  sus detecciones del análisis.
                </p>
              </div>
            ) : null}

            {separation === null ? (
              <p className="text-xs text-muted-foreground">
                Para muchas especies este es el resultado esperado: BirdNET las
                reporta pero no están presentes en ninguna puntuación.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* A no-filter decision has no curve and no interval to show, so neither
          the fitted card below nor the unusable card above renders for it. It
          still needs to say what is in force, or applying it looks like nothing
          happened. */}
      {latest && latest.source === "no_filter" ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <CardTitle>Sin filtro de confianza</CardTitle>
              <p className="text-xs text-muted-foreground">
                {latest.isActive ? "Aplicado el " : "Registrado el "}
                {formatFitTimestamp(latest.appliedAt ?? latest.fittedAt)}
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Las {latest.nReviewed} revisiones de esta especie fueron correctas
              en todas las bandas de puntaje, así que no hay umbral que estimar y
              tampoco hace falta.{" "}
              {latest.isActive
                ? "Se conservan todas sus detecciones en el portal, sin aplicar el umbral global."
                : "La decisión está registrada pero no está aplicada: hoy rige el umbral global."}
            </p>
            <p className="text-xs text-muted-foreground">
              Equivale a un umbral de {SCORE_FLOOR.toFixed(2)}, el piso de
              puntuación de BirdNET — ninguna detección queda por debajo. No es
              un ajuste del modelo: es una decisión registrada, y se puede
              revertir.
            </p>
            {latest.isActive && impactAtGlobal.dropped > 0 ? (
              <p className="text-xs text-emerald-800">
                Se conservan{" "}
                <strong className="tabular-nums">
                  {impactAtGlobal.dropped.toLocaleString("es-EC")}
                </strong>{" "}
                detecciones que el umbral global de 0.70 descartaría.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {latest && summary?.usable && latest.intercept != null && latest.slope != null ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <CardTitle>Modelo ajustado</CardTitle>
              {/* Which run produced these numbers. Re-fitting is cheap and
                  routine, so "the model" on screen is always a specific run. */}
              <p className="text-xs text-muted-foreground">
                Ajustado el {formatFitTimestamp(latest.fittedAt)} · {summary.nReviewed}{" "}
                revisiones
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Probabilidad de que una predicción sea correcta según la confianza
              de BirdNET. La franja marca el intervalo de confianza del umbral.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <FitChart
              intercept={latest.intercept}
              slope={latest.slope}
              thresholdConf95={summary.thresholdConf95}
              ciLower={summary.ciLower}
              ciUpper={summary.ciUpper}
              observations={observations.map((o) => ({
                conf: o.conf,
                correct: o.outcome === "correct",
              }))}
            />

            <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Umbral 90%</dt>
                <dd className="tabular-nums">
                  {latest.thresholdConf90?.toFixed(3) ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Umbral 95%</dt>
                <dd className="tabular-nums">
                  {formatThresholdWithCi(
                    summary.thresholdConf95,
                    summary.ciLower,
                    summary.ciUpper
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Umbral 99%</dt>
                <dd className="tabular-nums">
                  {latest.thresholdConf99?.toFixed(3) ?? "—"}
                </dd>
              </div>
            </dl>

            {impactAtFit ? (
              <p className="text-xs text-muted-foreground">
                Con este umbral se conservan{" "}
                <strong className="tabular-nums">
                  {impactAtFit.kept.toLocaleString("es")}
                </strong>{" "}
                de {allConfidences.length.toLocaleString("es")} detecciones (
                {Math.round(impactAtFit.keptFraction * 100)}%). Con el umbral
                global de 0.70 serían {impactAtGlobal.kept.toLocaleString("es")}.
              </p>
            ) : null}

            {/* A BirdNET score is only comparable to other scores from the same
                model, so the threshold travels with the version that produced
                the numbers it was fitted on. The old copy read "Válido para
                birdnet-analyzer" and named ONE version picked arbitrarily from
                the sample — see `resolveModelVersion`. */}
            {modelVersions.versions.length > 0 ? (
              <div className="space-y-1 text-[11px] text-muted-foreground">
                <p>
                  Ajustado sobre puntajes de{" "}
                  <span className="font-medium">
                    {modelVersions.versions.join(" y ")}
                  </span>
                  . Si el audio se reprocesa con otra versión de BirdNET, o
                  cambia el modelo de grabadora, los puntajes dejan de ser
                  comparables y hay que volver a validar.
                </p>
                {modelVersions.mixed ? (
                  <p className="rounded border border-amber-300 bg-amber-50 p-1.5 text-amber-900">
                    La muestra mezcla {modelVersions.versions.length} versiones.
                    Si corresponden al mismo analizador con distinta etiqueta, el
                    ajuste es válido; si son modelos distintos, conviene
                    reprocesar y volver a muestrear antes de aplicar el umbral.
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Composición de la muestra</CardTitle>
          <p className="text-sm text-muted-foreground">
            Muestreo uniforme por banda de puntuación, repartido entre
            despliegues.
          </p>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1">Banda</th>
                <th className="py-1 text-right">Muestreadas</th>
                <th className="py-1 text-right">Revisadas</th>
                <th className="py-1 text-right">Correctas</th>
              </tr>
            </thead>
            <tbody>
              {(progress?.bins ?? []).map((b) => (
                <tr key={b.binIndex} className="border-b last:border-0">
                  <td className="py-1 tabular-nums">
                    {edges[b.binIndex]
                      ? `${edges[b.binIndex].lo.toFixed(1)}–${edges[b.binIndex].hi.toFixed(1)}`
                      : b.binIndex}
                  </td>
                  <td className="py-1 text-right tabular-nums">{b.drawn}</td>
                  <td className="py-1 text-right tabular-nums">{b.reviewed}</td>
                  <td className="py-1 text-right tabular-nums">{b.correct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {(progress?.sites.length ?? 0) > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Cobertura por sitio</CardTitle>
            <p className="text-sm text-muted-foreground">
              El muestreo toma un candidato de cada despliegue antes de repetir
              ninguno, dentro de cada banda de puntuación: una banda tomada de un
              solo sitio mediría la rana de ese sitio, no la especie.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              <strong className="tabular-nums">{progress!.sites.length}</strong>{" "}
              sitios · máximo{" "}
              <strong className="tabular-nums">
                {Math.max(...progress!.sites.map((s) => s.drawn))}
              </strong>{" "}
              clips de un mismo sitio
            </p>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1">Sitio</th>
                    <th className="py-1 text-right">Muestreadas</th>
                    <th className="py-1 text-right">Revisadas</th>
                  </tr>
                </thead>
                <tbody>
                  {progress!.sites.map((s) => (
                    <tr key={s.siteName ?? "__sin_sitio__"} className="border-b last:border-0">
                      {/* Labelled, not dropped: at least one deployment in the
                          data carries no site name. */}
                      <td className="py-1">
                        {s.siteName ?? (
                          <span className="italic text-muted-foreground">
                            Sitio sin nombre
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-right tabular-nums">{s.drawn}</td>
                      <td className="py-1 text-right tabular-nums">{s.reviewed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {fits.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Historial de ajustes</CardTitle>
            <p className="text-sm text-muted-foreground">
              Del más reciente al más antiguo. Sólo uno puede estar aplicado a la
              vez.
            </p>
          </CardHeader>
          <CardContent>
            {/*
              Columns were colliding: "Umbral" was right-aligned and "Resultado"
              had no left padding, so the header read "UmbralResultado" and a row
              read "0.632Ajustado". Every column now carries its own horizontal
              padding, the numeric ones are right-aligned as a block, and the
              result column is pushed left of the numbers instead of butting
              against them. Rows are wide enough to need a scroll container on a
              narrow screen rather than squeezing.
            */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-4 font-medium">Fecha</th>
                    <th className="py-1 pr-4 text-right font-medium">Revisiones</th>
                    <th className="py-1 pr-6 text-right font-medium">Umbral</th>
                    <th className="py-1 font-medium">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {fits.map((f) => (
                    <tr key={f.id} className="border-b last:border-0 align-top">
                      {/* Date AND time: two fits on one afternoon were
                          indistinguishable when this showed only the date. */}
                      <td className="py-1.5 pr-4 tabular-nums">
                        {formatFitTimestamp(f.fittedAt)}
                      </td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">
                        {f.nReviewed}
                      </td>
                      <td className="py-1.5 pr-6 text-right tabular-nums">
                        {f.thresholdConf95?.toFixed(3) ?? "—"}
                      </td>
                      <td className="py-1.5 text-xs">
                        {f.isActive ? (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-900">
                            Aplicado
                          </span>
                        ) : f.unusableReason ? (
                          <span className="text-muted-foreground">
                            {f.unusableReason}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Ajustado</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
