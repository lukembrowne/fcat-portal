"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowUpDown, RefreshCw, Flag } from "lucide-react";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { reprocessDeployment } from "./actions";
import type { DeploymentSummary } from "./types";

const PAGE_SIZE = 15;

type SortKey = "deploymentName" | "habitatType" | "dateStart" | "readingCount" | "tempMean";

export function DeploymentsTable({
  deployments,
  isEditor,
}: {
  deployments: DeploymentSummary[];
  isEditor: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("deploymentName");
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(0);
  const [reprocessing, setReprocessing] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return deployments.filter(
      (d) =>
        d.deploymentName.toLowerCase().includes(q) ||
        (d.siteName?.toLowerCase().includes(q) ?? false) ||
        (d.habitatType?.toLowerCase().includes(q) ?? false)
    );
  }, [deployments, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      switch (sortKey) {
        case "deploymentName":
          return dir * a.deploymentName.localeCompare(b.deploymentName);
        case "habitatType":
          return (
            dir *
            (a.habitatType ?? "").localeCompare(b.habitatType ?? "")
          );
        case "dateStart":
          return dir * (a.dateStart ?? "").localeCompare(b.dateStart ?? "");
        case "readingCount":
          return dir * (a.readingCount - b.readingCount);
        case "tempMean":
          return dir * (a.tempMean - b.tempMean);
        default:
          return 0;
      }
    });
  }, [filtered, sortKey, sortAsc]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  async function handleReprocess(deploymentId: number) {
    setReprocessing(deploymentId);
    try {
      const result = await reprocessDeployment(deploymentId);
      if (!result.success) {
        alert(result.error);
      }
    } finally {
      setReprocessing(null);
    }
  }

  function SortHeader({
    label,
    sortKeyName,
  }: {
    label: string;
    sortKeyName: SortKey;
  }) {
    return (
      <button
        className="flex items-center gap-1 hover:text-foreground"
        onClick={() => toggleSort(sortKeyName)}
      >
        {label}
        <ArrowUpDown className="h-3 w-3" />
      </button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Despliegues Procesados ({filtered.length})
          </CardTitle>
          <Input
            placeholder="Buscar..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="w-48"
          />
        </div>
      </CardHeader>
      <CardContent>
        {paged.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {deployments.length === 0
              ? "No hay despliegues procesados. Haz clic en \"Procesar iButton\" para comenzar."
              : "Sin resultados para la búsqueda."}
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <SortHeader label="Sitio" sortKeyName="deploymentName" />
                  </TableHead>
                  <TableHead>
                    <SortHeader label="Hábitat" sortKeyName="habitatType" />
                  </TableHead>
                  <TableHead>
                    <SortHeader label="Fecha inicio" sortKeyName="dateStart" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader
                      label="Lecturas"
                      sortKeyName="readingCount"
                    />
                  </TableHead>
                  <TableHead className="text-right">
                    Mín / Prom / Máx (°C)
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader label="Prom" sortKeyName="tempMean" />
                  </TableHead>
                  {isEditor && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((d) => (
                  <TableRow key={d.deploymentId}>
                    <TableCell>
                      <Link
                        href={`/biochoco/ibutton/${d.deploymentId}`}
                        className="text-blue-600 hover:underline font-medium"
                      >
                        {d.deploymentName}
                      </Link>
                      {d.siteName && (
                        <span className="text-xs text-muted-foreground ml-1">
                          ({d.siteName})
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.habitatType ? (
                        <Badge variant="secondary" className="text-xs">
                          {getHabitatName(d.habitatType)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {d.dateStart ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.readingCount.toLocaleString("es")}
                      {d.flaggedCount > 0 && (
                        <Flag className="inline h-3 w-3 ml-1 text-amber-500" />
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      <span className="text-blue-600">{d.tempMin}°</span>
                      {" / "}
                      <span className="text-orange-600">{d.tempMean}°</span>
                      {" / "}
                      <span className="text-red-600">{d.tempMax}°</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {d.tempMean}°C
                    </TableCell>
                    {isEditor && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleReprocess(d.deploymentId)}
                          disabled={reprocessing === d.deploymentId}
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${reprocessing === d.deploymentId ? "animate-spin" : ""}`}
                          />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Página {page + 1} de {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                  >
                    Anterior
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPage(Math.min(totalPages - 1, page + 1))
                    }
                    disabled={page >= totalPages - 1}
                  >
                    Siguiente
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
