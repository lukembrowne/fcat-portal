"use client";

/**
 * Composes the Sueldos page: metrics, the year/status controls, the two editable
 * tables, and the coverage charts.
 *
 * Year and status live in the URL so a view is reproducible from a shared link,
 * following the finance filter convention in ../layout.tsx. They are independent
 * of each other and of the layout's own date range — changing one preserves the
 * others.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Upload } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MetricsRow } from "./metrics-row";
import { PeopleTable } from "./people-table";
import { SourcesTable } from "./sources-table";
import { SueldosCharts } from "./sueldos-charts";
import {
  STATUS_FILTER_LABELS,
  type FundingStatusFilter,
} from "@/lib/finance/sueldos-fields";
import type { SueldosPlanningData } from "./actions";

const STATUS_FILTERS: FundingStatusFilter[] = ["all", "funded", "pending"];

export function DashboardShell({
  data,
  canEdit,
  targets,
}: {
  data: SueldosPlanningData;
  canEdit: boolean;
  targets: {
    groups: { id: number; name: string }[];
    people: { id: number; name: string; groupId: number | null }[];
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Mutates one key and preserves the rest, so year, status and the layout's
  // range never clobber each other.
  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(key, value);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  // Always offer the current and next year, even before either has salaries.
  const thisYear = new Date().getFullYear();
  const years = Array.from(
    new Set([...data.availableYears, data.year, thisYear, thisYear + 1])
  ).sort((a, b) => b - a);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Sueldos</h1>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">Año:</span>
            <select
              value={data.year}
              onChange={(e) => setParam("year", e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-muted-foreground">Estado:</span>
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f}
                variant={data.statusFilter === f ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setParam("estado", f)}
              >
                {STATUS_FILTER_LABELS[f]}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <MetricsRow total={data.total} totalSpent={data.totalSpent} year={data.year} />

      {data.empty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Todavía no hay personas registradas. Puede agregarlas una por una, o importar el
              archivo de Sueldos para empezar.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/finance/data">
                <Upload className="h-4 w-4" />
                <span className="ml-1">Importar desde Excel</span>
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <PeopleTable
            groups={data.groups}
            ungrouped={data.ungrouped}
            total={data.total}
            year={data.year}
            canEdit={canEdit}
          />

          <SourcesTable
            sources={data.sources}
            year={data.year}
            canEdit={canEdit}
            targets={targets}
          />

          <SueldosCharts panels={data.chart} />
        </>
      )}
    </div>
  );
}
