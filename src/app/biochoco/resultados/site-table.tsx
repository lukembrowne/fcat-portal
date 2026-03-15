"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { SiteWithReadiness, ReadinessStatus } from "./types";
import { getHabitatName } from "../overview/types";
import { CheckCircle2, Clock, Minus, ArrowUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SiteTableProps {
  sites: SiteWithReadiness[];
}

type SortKey = "siteId" | "siteName" | "habitatType" | "deploymentCount";

function ReadinessIcon({ status }: { status: ReadinessStatus }) {
  if (status === "complete")
    return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (status === "in_progress")
    return <Clock className="h-4 w-4 text-amber-500" />;
  return <Minus className="h-4 w-4 text-gray-400" />;
}

export function SiteTable({ sites }: SiteTableProps) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("siteId");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    return [...sites].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "siteId":
          cmp = a.siteId.localeCompare(b.siteId);
          break;
        case "siteName":
          cmp = a.siteName.localeCompare(b.siteName);
          break;
        case "habitatType":
          cmp = getHabitatName(a.habitatType).localeCompare(
            getHabitatName(b.habitatType)
          );
          break;
        case "deploymentCount":
          cmp = a.deploymentCount - b.deploymentCount;
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [sites, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  if (sites.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] bg-muted rounded-xl">
        <p className="text-muted-foreground">No se encontraron sitios</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <button
                className="flex items-center gap-1 hover:text-foreground"
                onClick={() => toggleSort("siteId")}
              >
                Sitio
                <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead>
              <button
                className="flex items-center gap-1 hover:text-foreground"
                onClick={() => toggleSort("habitatType")}
              >
                Hábitat
                <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead className="text-center">
              <button
                className="flex items-center gap-1 hover:text-foreground mx-auto"
                onClick={() => toggleSort("deploymentCount")}
              >
                Visitas
                <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead className="text-center">Cámaras</TableHead>
            <TableHead className="text-center">Temperatura</TableHead>
            <TableHead className="text-center">Hábitat</TableHead>
            <TableHead className="text-center">Audio</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((site) => (
            <TableRow
              key={site.siteId}
              className="cursor-pointer hover:bg-accent/50"
              onClick={() =>
                router.push(`/biochoco/resultados/${site.siteId}`)
              }
            >
              <TableCell>
                <div>
                  <span className="font-medium">{site.siteId}</span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {site.siteName}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-sm">
                {getHabitatName(site.habitatType)}
              </TableCell>
              <TableCell className="text-center">{site.deploymentCount}</TableCell>
              <TableCell className="text-center">
                <div className="flex justify-center">
                  <ReadinessIcon status={site.readiness.cameras} />
                </div>
              </TableCell>
              <TableCell className="text-center">
                <div className="flex justify-center">
                  <ReadinessIcon status={site.readiness.temperature} />
                </div>
              </TableCell>
              <TableCell className="text-center">
                <div className="flex justify-center">
                  <ReadinessIcon status={site.readiness.habitat} />
                </div>
              </TableCell>
              <TableCell className="text-center">
                <div className="flex justify-center">
                  <ReadinessIcon status={site.readiness.audio} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
