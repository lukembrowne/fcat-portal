import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getApplications, type SortColumn, type SortDirection } from "./actions";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { STATUS_LABELS } from "@/lib/research-applications/transitions";
import { WorkflowGuide } from "./workflow-guide";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-800",
  under_review: "bg-yellow-100 text-yellow-800",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  revisions_requested: "bg-orange-100 text-orange-800",
};

function SortableHeader({
  column,
  label,
  currentSort,
  currentDir,
  params,
}: {
  column: SortColumn;
  label: string;
  currentSort: SortColumn;
  currentDir: SortDirection;
  params: Record<string, string | undefined>;
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === "asc" ? "desc" : "asc";
  const query = new URLSearchParams();
  if (params.status && params.status !== "all") query.set("status", params.status);
  if (params.search) query.set("search", params.search);
  query.set("sortBy", column);
  query.set("sortDir", nextDir);

  return (
    <TableHead>
      <Link
        href={`/research-applications?${query.toString()}`}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {label}
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-30" />
        )}
      </Link>
    </TableHead>
  );
}

export default async function ResearchApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; sortBy?: string; sortDir?: string }>;
}) {
  await requirePermission("researcher-applications", "viewer");
  const params = await searchParams;

  const sortBy = (params.sortBy ?? "date") as SortColumn;
  const sortDir = (params.sortDir === "asc" ? "asc" : "desc") as SortDirection;

  const applications = await getApplications({
    status: params.status,
    search: params.search,
    sortBy,
    sortDir,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Aplicaciones de Investigadores</h1>
          <p className="text-muted-foreground">
            Gestionar aplicaciones de investigadores externos
          </p>
        </div>
        <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm shrink-0">
          <span className="text-muted-foreground">Formulario público: </span>
          <Link
            href="/public/apply"
            className="text-primary hover:underline"
            target="_blank"
          >
            {process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org"}/public/apply
          </Link>
        </div>
      </div>

      <WorkflowGuide />

      {/* Filters */}
      <form className="flex gap-3 flex-wrap" method="GET">
        <select
          name="status"
          defaultValue={params.status ?? "all"}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value="all">Todos los estados</option>
          <option value="submitted">Enviada</option>
          <option value="under_review">En revisión</option>
          <option value="accepted">Aceptada</option>
          <option value="rejected">Rechazada</option>
          <option value="revisions_requested">Revisiones solicitadas</option>
        </select>
        <input
          name="search"
          defaultValue={params.search ?? ""}
          placeholder="Buscar por título, nombre o código..."
          className="rounded-md border px-3 py-2 text-sm flex-1 min-w-[200px]"
        />
        <button
          type="submit"
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm"
        >
          Filtrar
        </button>
      </form>

      {/* Table */}
      {applications.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">
          No se encontraron aplicaciones.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader column="code" label="Código" currentSort={sortBy} currentDir={sortDir} params={params} />
              <SortableHeader column="project" label="Proyecto" currentSort={sortBy} currentDir={sortDir} params={params} />
              <SortableHeader column="researcher" label="Investigador" currentSort={sortBy} currentDir={sortDir} params={params} />
              <SortableHeader column="status" label="Estado" currentSort={sortBy} currentDir={sortDir} params={params} />
              <SortableHeader column="reviewer" label="Revisor" currentSort={sortBy} currentDir={sortDir} params={params} />
              <SortableHeader column="report" label="Informe" currentSort={sortBy} currentDir={sortDir} params={params} />
              <SortableHeader column="date" label="Fecha de envío" currentSort={sortBy} currentDir={sortDir} params={params} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((app) => (
              <TableRow key={app.id} className="relative cursor-pointer">
                <TableCell>
                  <Link
                    href={`/research-applications/${app.id}`}
                    className="font-mono text-sm after:absolute after:inset-0"
                  >
                    {app.referenceCode ?? `#${app.id}`}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[250px]">
                  <span className="relative z-10 block truncate hover:whitespace-normal hover:overflow-visible hover:text-clip">
                    {app.projectTitle}
                  </span>
                </TableCell>
                <TableCell>
                  <div>{app.piFullName}</div>
                  {app.piInstitution && (
                    <div className="text-xs text-muted-foreground">
                      {app.piInstitution}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="secondary"
                    className={STATUS_COLORS[app.status] ?? ""}
                  >
                    {STATUS_LABELS[app.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {app.primaryReviewerEmail?.split("@")[0] ?? "—"}
                </TableCell>
                <TableCell>
                  {app.hasReport ? (
                    <Badge variant="secondary" className="bg-green-100 text-green-800">
                      Entregado
                    </Badge>
                  ) : app.finalReportDueDate ? (
                    <span className="text-xs text-muted-foreground">
                      Vence: {app.finalReportDueDate}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {app.createdAt.toLocaleDateString("es-EC")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
