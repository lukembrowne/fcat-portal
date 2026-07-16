import { requirePermission } from "@/lib/auth";
import { fetchSitePublicPagesData } from "./actions";
import { PagesTable } from "./pages-table";
import {
  SORTABLE_COLUMNS,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIR,
  type SitePublicPagesSortColumn,
  type SortDirection,
} from "./sort";

export default async function PaginasPublicasPage({
  searchParams,
}: {
  searchParams: Promise<{ sortBy?: string; sortDir?: string }>;
}) {
  await requirePermission("biochoco", "editor");
  const params = await searchParams;

  const sortBy: SitePublicPagesSortColumn =
    params.sortBy && params.sortBy in SORTABLE_COLUMNS
      ? (params.sortBy as SitePublicPagesSortColumn)
      : DEFAULT_SORT_BY;
  const sortDir: SortDirection =
    params.sortDir === "asc" || params.sortDir === "desc"
      ? params.sortDir
      : DEFAULT_SORT_DIR;

  const result = await fetchSitePublicPagesData({ sortBy, sortDir });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Páginas públicas</h1>
        <p className="text-muted-foreground">
          Estas son las páginas que ven los dueños de finca. Revise cuáles están
          publicadas, cuáles ya fueron vistas y cuáles faltan por preparar.
        </p>
      </div>

      {result.success ? (
        <PagesTable rows={result.data} sortBy={sortBy} sortDir={sortDir} />
      ) : (
        <p className="text-destructive py-8 text-center">{result.error}</p>
      )}
    </div>
  );
}
