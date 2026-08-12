import { cookies } from "next/headers";
import { desc, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  birdnetSpeciesThresholds,
  species as speciesTable,
  audioIdentifications,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listCampaigns } from "./actions";
import {
  CampaignTable,
  filterCampaignRows,
  sortCampaignRows,
  DEFAULT_SORT_COLUMN,
  SORTABLE_COLUMNS,
  type CampaignFilter,
  type CampaignRow,
  type SortColumn,
  type SortDirection,
} from "./campaign-table";
import { AddSpeciesPanel } from "./new-campaign-dialog";
import { SpeciesImportCard } from "./species-import-card";
import { SpeciesFilterBar } from "./species-filter-bar";
import { NameLanguageToggle } from "./name-language-toggle";
import { NAME_LANG_COOKIE, parseNameLang, resolveDisplayName } from "./name-language";

export const metadata = { title: "Validación de umbrales" };

export default async function ValidacionIndexPage({
  searchParams,
}: {
  searchParams: Promise<{
    sortBy?: string;
    sortDir?: string;
    search?: string;
    status?: string;
    priority?: string;
  }>;
}) {
  const user = await requirePermission("grabaciones", "viewer");
  const params = await searchParams;
  const nameLang = parseNameLang((await cookies()).get(NAME_LANG_COOKIE)?.value);

  const sortBy = (
    SORTABLE_COLUMNS.includes(params.sortBy as SortColumn)
      ? params.sortBy
      : DEFAULT_SORT_COLUMN
  ) as SortColumn;
  // Ascending is most-urgent-first: priority sorts on a rank where high is 0,
  // so the default view opens on the species somebody marked as next.
  const sortDir: SortDirection = params.sortDir === "desc" ? "desc" : "asc";
  const filter: CampaignFilter = {
    search: params.search ?? "",
    status: params.status ?? "activas",
    priority: params.priority ?? "todas",
  };

  const canEdit =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "grabaciones" && (p.role === "editor" || p.role === "admin")
    );

  const campaignsResult = await listCampaigns();
  if (!campaignsResult.success) {
    return <div className="p-6 text-sm text-rose-700">{campaignsResult.error}</div>;
  }
  const campaigns = campaignsResult.data;
  const names = campaigns.map((c) => c.species);

  // Latest fit per campaign, plus display names and total detection counts.
  const fits = names.length
    ? await db
        .select()
        .from(birdnetSpeciesThresholds)
        .where(inArray(birdnetSpeciesThresholds.species, names))
        .orderBy(desc(birdnetSpeciesThresholds.fittedAt))
    : [];

  const latestBySpecies = new Map<string, (typeof fits)[number]>();
  const activeBySpecies = new Map<string, number>();
  for (const fit of fits) {
    if (!latestBySpecies.has(fit.species)) latestBySpecies.set(fit.species, fit);
    if (fit.isActive && fit.thresholdConf95 != null) {
      activeBySpecies.set(fit.species, fit.thresholdConf95);
    }
  }

  const speciesRows = names.length
    ? await db.select().from(speciesTable).where(inArray(speciesTable.scientificName, names))
    : [];
  const displayBySpecies = new Map(
    speciesRows.map((s) => [s.scientificName, resolveDisplayName(s, nameLang)])
  );

  const detectionCounts = names.length
    ? await db
        .select({
          species: audioIdentifications.species,
          n: sql<number>`COUNT(*)`,
        })
        .from(audioIdentifications)
        .where(inArray(audioIdentifications.species, names))
        .groupBy(audioIdentifications.species)
    : [];
  const countBySpecies = new Map(detectionCounts.map((r) => [r.species, Number(r.n)]));

  const rows: CampaignRow[] = campaigns.map((c) => {
    const latest = latestBySpecies.get(c.species);
    return {
      ...c,
      displayName: displayBySpecies.get(c.species) ?? c.species,
      appliedThreshold: activeBySpecies.get(c.species) ?? null,
      latestThreshold: latest?.thresholdConf95 ?? null,
      latestIsNoFilter: latest?.source === "no_filter",
      unusableReason: latest?.unusableReason ?? null,
      totalDetections: countBySpecies.get(c.species) ?? 0,
    };
  });

  const sorted = sortCampaignRows(filterCampaignRows(rows, filter), sortBy, sortDir);

  const applied = rows.filter((r) => r.appliedThreshold != null).length;
  const reviewedTotal = rows.reduce((sum, r) => sum + r.reviewed, 0);
  // Discarded species are not "in validation" — counting them made the headline
  // number drift further from reality with every round.
  const live = rows.filter((r) => r.status !== "abandoned");
  const inValidation = live.length;
  // Same population as the count beside it, so the two are comparable: "12 of
  // the 57 species still in play are marked to do first".
  const highPriority = live.filter((r) => r.priority === "high").length;

  return (
    // Wider than the rest of the module, and now wider again: the species table
    // carries nine columns and at max-w-6xl it scrolled horizontally on a
    // laptop, which hides the actions on the right. Still capped rather than
    // full-bleed — a table row spanning a 27" display is hard to track across.
    <div className="mx-auto max-w-[104rem] space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Validación de umbrales</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            La confianza de BirdNET no es una probabilidad y no es comparable
            entre especies. Para cada especie se revisa a oído una muestra
            estratificada por banda de puntuación y se ajusta un modelo
            logístico que estima el umbral en el que el 95% de las detecciones
            son correctas.
          </p>
        </div>
        <NameLanguageToggle current={nameLang} />
      </header>

      {/* Below the header, not inside it: both panels expand into wide forms
          (the import one holds a preview table) and would overflow a narrow
          viewport if they were constrained to a header column. */}
      {canEdit ? (
        <div className="space-y-2">
          <AddSpeciesPanel />
          <SpeciesImportCard />
        </div>
      ) : null}

      {/* Capped well under the table's width: four two-line tiles stretched
          across 104rem read as empty boxes rather than as a summary. */}
      <div className="grid max-w-4xl grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border p-2">
          <div className="text-lg font-semibold tabular-nums">{inValidation}</div>
          <div className="text-[11px] text-muted-foreground">Especies en validación</div>
        </div>
        <div className="rounded-lg border p-2">
          {/* Coloured only when there is something to point at: a zero in
              alarm orange reads as a problem rather than as an empty queue. */}
          <div
            className={`text-lg font-semibold tabular-nums ${
              highPriority > 0 ? "text-orange-700" : ""
            }`}
          >
            {highPriority}
          </div>
          <div className="text-[11px] text-muted-foreground">Prioridad alta</div>
        </div>
        <div className="rounded-lg border p-2">
          <div className="text-lg font-semibold tabular-nums">{reviewedTotal}</div>
          <div className="text-[11px] text-muted-foreground">Detecciones revisadas</div>
        </div>
        <div className="rounded-lg border p-2">
          <div className="text-lg font-semibold tabular-nums">{applied}</div>
          <div className="text-[11px] text-muted-foreground">Umbrales aplicados</div>
        </div>
      </div>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Especies</CardTitle>
          <SpeciesFilterBar shown={sorted.length} total={rows.length} />
        </CardHeader>
        <CardContent>
          {/* Nine columns do not fit a phone; scroll the table, not the page. */}
          <div className="overflow-x-auto">
            <CampaignTable
              rows={sorted}
              sortBy={sortBy}
              sortDir={sortDir}
              filter={filter}
              totalRows={rows.length}
              canEdit={canEdit}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
