"use client";

/**
 * Funding sources and their allocation lines for /finance/sueldos.
 *
 * A source owns its status and a DEFAULT period; each line owns the dates that
 * actually count. The GIZ lines already run to four different end dates, so a
 * single source-level period could never be authoritative — the default only
 * pre-fills a new line.
 *
 * "% sueldo" is derived (monthly amount against monthly salary), never typed.
 * It is the spreadsheet's hand-kept "25%" / "50%" note turned into something
 * that can be checked — and it is deliberately blank on group-targeted lines,
 * where a percentage of a pool would be misleading.
 */

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SortIcon } from "@/components/sort-icon";
import { EditableField, EditableSelect } from "@/components/editable-cell";
import {
  formatMoney,
  formatPercent,
  formatDateEs,
  formatMonthYear,
  FUNDING_STATUS_LABELS,
  FUNDING_STATUS_COLORS,
  FUNDING_STATUS_ORDER,
} from "@/lib/finance/sueldos-fields";
import type { AllocationLine, SourcePanel } from "./actions";
import {
  updateSourceField,
  updateAllocationField,
  deleteFundingSource,
  deleteAllocation,
} from "./actions";
import { AddSourceDialog, AddAllocationDialog } from "./add-allocation-dialog";

const MONEY_FORMATTERS = { amount: (v: number | null) => formatMoney(v) };
const DATE_FORMATTERS = { date: (v: string | null) => <>{formatDateEs(v)}</> };

const STATUS_OPTIONS = FUNDING_STATUS_ORDER.map((s) => ({
  value: s,
  label: FUNDING_STATUS_LABELS[s],
}));

type LineSortCol = "target" | "amount" | "start" | "end" | "share";
type SortDir = "asc" | "desc";

const LINE_COLUMNS: { key: LineSortCol; label: string; align: "left" | "right" }[] = [
  { key: "target", label: "Destino", align: "left" },
  { key: "amount", label: "Monto", align: "right" },
  { key: "start", label: "Desde", align: "left" },
  { key: "end", label: "Hasta", align: "left" },
  { key: "share", label: "% sueldo", align: "right" },
];

function compareLines(a: AllocationLine, b: AllocationLine, col: LineSortCol, dir: SortDir) {
  const sign = dir === "asc" ? 1 : -1;
  switch (col) {
    case "target":
      return sign * a.targetName.localeCompare(b.targetName, "es");
    case "amount":
      return sign * (a.amount - b.amount);
    case "start":
      return sign * a.startDate.localeCompare(b.startDate);
    case "end":
      return sign * a.endDate.localeCompare(b.endDate);
    case "share":
      return sign * ((a.share ?? -1) - (b.share ?? -1));
  }
}

function LineActions({ line, onChanged }: { line: AllocationLine; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <DropdownMenu
      open={confirming ? true : undefined}
      onOpenChange={(o) => !o && setConfirming(false)}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={pending}>
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Acciones</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={(e) => {
            e.preventDefault();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            startTransition(async () => {
              await deleteAllocation(line.id);
              setConfirming(false);
              onChanged();
            });
          }}
        >
          {confirming ? "Confirmar eliminación" : "Eliminar línea…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SourceActions({ source, onChanged }: { source: SourcePanel; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <DropdownMenu
      open={confirming ? true : undefined}
      onOpenChange={(o) => !o && setConfirming(false)}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={pending}>
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Acciones</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={(e) => {
            e.preventDefault();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            startTransition(async () => {
              await deleteFundingSource(source.id);
              setConfirming(false);
              onChanged();
            });
          }}
        >
          {confirming
            ? `Confirmar — elimina ${source.lines.length} línea${source.lines.length === 1 ? "" : "s"}`
            : "Eliminar fuente…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SourcesTable({
  sources,
  year,
  canEdit,
  targets,
}: {
  sources: SourcePanel[];
  year: number;
  canEdit: boolean;
  targets: {
    groups: { id: number; name: string }[];
    people: { id: number; name: string; groupId: number | null }[];
  };
}) {
  const router = useRouter();
  const [sortCol, setSortCol] = useState<LineSortCol>("target");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const targetOptions = useMemo(
    () => [
      ...targets.groups.map((g) => ({ value: `group:${g.id}`, label: `${g.name} (grupo)` })),
      ...targets.people.map((p) => ({ value: `person:${p.id}`, label: p.name })),
    ],
    [targets]
  );

  function toggleSort(col: LineSortCol) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir(col === "target" ? "asc" : "desc");
    }
  }

  const refresh = () => router.refresh();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="text-base">Fuentes de financiamiento</CardTitle>
        {canEdit && (
          <AddSourceDialog>
            <Button size="sm" variant="outline">
              <Plus className="h-4 w-4" />
              <span className="ml-1">Agregar fuente</span>
            </Button>
          </AddSourceDialog>
        )}
      </CardHeader>
      <CardContent className="px-0">
        {sources.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">
            Sin fuentes de financiamiento para este filtro
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {LINE_COLUMNS.map((c) => (
                    <TableHead key={c.key} className={c.align === "right" ? "text-right" : ""}>
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={`inline-flex items-center gap-1 hover:text-foreground ${
                          c.align === "right" ? "flex-row-reverse" : ""
                        }`}
                      >
                        {c.label}
                        <SortIcon direction={sortCol === c.key ? sortDir : false} />
                      </button>
                    </TableHead>
                  ))}
                  <TableHead>Notas</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>

              <TableBody>
                {sources.map((s) => {
                  const isOpen = !collapsed.has(s.id);
                  const lines = [...s.lines].sort((a, b) =>
                    compareLines(a, b, sortCol, sortDir)
                  );

                  return (
                    <Fragment key={s.id}>
                      <TableRow className="bg-muted/40">
                        <TableCell colSpan={2}>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setCollapsed((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(s.id)) next.delete(s.id);
                                  else next.add(s.id);
                                  return next;
                                })
                              }
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              aria-label={isOpen ? "Colapsar" : "Expandir"}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                            <span className="font-medium">
                              <EditableField
                                id={s.id}
                                field="name"
                                value={s.name}
                                kind="text"
                                canEdit={canEdit}
                                action={updateSourceField}
                              />
                            </span>
                            {canEdit ? (
                              <EditableSelect
                                id={s.id}
                                field="status"
                                value={s.status}
                                options={STATUS_OPTIONS}
                                canEdit
                                action={updateSourceField}
                                colors={FUNDING_STATUS_COLORS}
                                allowEmpty={false}
                              />
                            ) : (
                              <Badge variant="secondary" className={FUNDING_STATUS_COLORS[s.status]}>
                                {FUNDING_STATUS_LABELS[s.status]}
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {s.lines.length} línea{s.lines.length === 1 ? "" : "s"} ·{" "}
                              {formatMonthYear(s.defaultStartDate)} –{" "}
                              {formatMonthYear(s.defaultEndDate)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell colSpan={2} className="text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <span className="shrink-0">Período por defecto:</span>
                            <EditableField
                              id={s.id}
                              field="defaultStartDate"
                              value={s.defaultStartDate}
                              kind="date"
                              canEdit={canEdit}
                              action={updateSourceField}
                              formatters={DATE_FORMATTERS}
                            />
                            <span className="shrink-0">–</span>
                            <EditableField
                              id={s.id}
                              field="defaultEndDate"
                              value={s.defaultEndDate}
                              kind="date"
                              canEdit={canEdit}
                              action={updateSourceField}
                              formatters={DATE_FORMATTERS}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium tabular-nums">
                          {formatMoney(s.totalAllocated)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatMoney(s.fundedThisYear)} en {year}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {canEdit && (
                              <AddAllocationDialog
                                source={s}
                                targetOptions={targetOptions}
                              >
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                                  <Plus className="h-4 w-4" />
                                  <span className="sr-only">Agregar línea</span>
                                </Button>
                              </AddAllocationDialog>
                            )}
                            {canEdit && <SourceActions source={s} onChanged={refresh} />}
                          </div>
                        </TableCell>
                      </TableRow>

                      {isOpen && lines.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={7}
                            className="py-3 pl-10 text-sm text-muted-foreground"
                          >
                            Sin líneas de financiamiento
                          </TableCell>
                        </TableRow>
                      )}

                      {isOpen &&
                        lines.map((l) => (
                          <TableRow key={l.id}>
                            <TableCell className="pl-10">
                              <EditableSelect
                                id={l.id}
                                field="personId"
                                value={
                                  l.personId != null
                                    ? `person:${l.personId}`
                                    : `group:${l.groupId}`
                                }
                                options={targetOptions}
                                canEdit={canEdit}
                                action={updateAllocationField}
                                allowEmpty={false}
                                colors={
                                  l.targetKind === "group"
                                    ? { [`group:${l.groupId}`]: "bg-blue-100 text-blue-800" }
                                    : undefined
                                }
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <EditableField
                                id={l.id}
                                field="amount"
                                value={l.amount}
                                kind="amount"
                                canEdit={canEdit}
                                action={updateAllocationField}
                                formatters={MONEY_FORMATTERS}
                                align="right"
                              />
                            </TableCell>
                            <TableCell>
                              <EditableField
                                id={l.id}
                                field="startDate"
                                value={l.startDate}
                                kind="date"
                                canEdit={canEdit}
                                action={updateAllocationField}
                                formatters={DATE_FORMATTERS}
                              />
                            </TableCell>
                            <TableCell>
                              <EditableField
                                id={l.id}
                                field="endDate"
                                value={l.endDate}
                                kind="date"
                                canEdit={canEdit}
                                action={updateAllocationField}
                                formatters={DATE_FORMATTERS}
                              />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {l.share == null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                formatPercent(l.share)
                              )}
                            </TableCell>
                            <TableCell className="max-w-[220px]">
                              <EditableField
                                id={l.id}
                                field="notes"
                                value={l.notes}
                                kind="text"
                                canEdit={canEdit}
                                action={updateAllocationField}
                                placeholder="—"
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              {canEdit && <LineActions line={l} onChanged={refresh} />}
                            </TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
