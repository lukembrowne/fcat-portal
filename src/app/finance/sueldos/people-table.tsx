"use client";

/**
 * Roster table for /finance/sueldos.
 *
 * Group rows (FCATeros, FCATeros Ext.) are expandable parents whose cost is
 * DERIVED from their members and therefore not editable — the spreadsheet stored
 * that aggregate as its own editable figure, which is exactly how it drifted
 * from the rows that sum to it.
 *
 * Sorting is hand-rolled rather than TanStack's row model because the table is a
 * two-level tree: the comparator runs over top-level rows (ungrouped people and
 * group rows) and again over each group's members, so a member can never be
 * sorted away from its parent.
 */

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, AlertTriangle } from "lucide-react";
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
import { formatMoney, formatPercent } from "@/lib/finance/sueldos-fields";
import type { GroupPanel, PersonPanel } from "./actions";
import { updatePersonField, updateSalaryForYear, deletePerson } from "./actions";
import type { Coverage } from "../lib/sueldos-planning";
import { AddPersonDialog } from "./add-person-dialog";

const MONEY_FORMATTERS = { amount: (v: number | null) => formatMoney(v) };

type SortCol = "name" | "role" | "group" | "cost" | "funded" | "uncovered" | "percent";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortCol; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Persona", align: "left" },
  { key: "role", label: "Figura en rol de pagos", align: "left" },
  { key: "group", label: "Grupo", align: "left" },
  { key: "cost", label: "Sueldo anual", align: "right" },
  { key: "funded", label: "Financiado", align: "right" },
  { key: "uncovered", label: "Sin cubrir", align: "right" },
  { key: "percent", label: "% cubierto", align: "right" },
];

/** What the comparator sees, for a person row or a group row alike. */
interface SortableRow {
  name: string;
  role: string | null;
  groupName: string | null;
  cost: number;
  funded: number;
  uncovered: number;
  percentCovered: number;
}

function compare(a: SortableRow, b: SortableRow, col: SortCol, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  switch (col) {
    case "name":
      return sign * a.name.localeCompare(b.name, "es");
    case "role":
      return sign * (a.role ?? "").localeCompare(b.role ?? "", "es");
    case "group":
      return sign * (a.groupName ?? "").localeCompare(b.groupName ?? "", "es");
    case "cost":
      return sign * (a.cost - b.cost);
    case "funded":
      return sign * (a.funded - b.funded);
    case "uncovered":
      // Over-funded rows carry uncovered 0; sort them by their overage instead so
      // "sin cubrir" ordering stays meaningful in both directions.
      return sign * (a.uncovered - b.uncovered);
    case "percent":
      return sign * (a.percentCovered - b.percentCovered);
  }
}

/** Shortfall / exact / overage, rendered so an overage never reads as a negative. */
function CoverageCell({ c }: { c: Coverage }) {
  if (c.state === "over") {
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-800 tabular-nums">
        +{formatMoney(c.overfunded)}
      </Badge>
    );
  }
  if (c.state === "covered") {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="font-medium tabular-nums text-red-600 dark:text-red-400">
      {formatMoney(c.uncovered)}
    </span>
  );
}

/** Beyond this many names the note collapses to a count — the members are listed
 *  row by row right underneath anyway, and spelling out all 13 FCATeros pushed
 *  the whole table into a horizontal scroll. */
const MAX_NAMES_IN_NOTE = 3;

/** The group row's second cell: a warning, or the group's description. */
function GroupNote({ group, year }: { group: GroupPanel; year: number }) {
  if (group.memberCount === 0 && group.funded > 0) {
    return (
      <span className="inline-flex items-start gap-1 text-amber-700 dark:text-amber-500">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Financiamiento sin personas asignadas</span>
      </span>
    );
  }

  const missing = group.membersMissingSalary;
  if (missing.length > 0) {
    return (
      <span
        className="inline-flex items-start gap-1 text-amber-700 dark:text-amber-500"
        title={`Sin sueldo ${year}: ${missing.join(", ")}`}
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Sin sueldo {year}:{" "}
          {missing.length <= MAX_NAMES_IN_NOTE
            ? missing.join(", ")
            : `${missing.length} de ${group.memberCount} personas`}
        </span>
      </span>
    );
  }

  return <>{group.description ?? ""}</>;
}

function PercentCell({ c }: { c: Coverage }) {
  if (c.cost === 0) return <span className="text-muted-foreground">—</span>;
  const pct = c.percentCovered;
  const tone =
    pct >= 0.999 ? "text-green-700 dark:text-green-400" : pct >= 0.75 ? "" : "text-red-600 dark:text-red-400";
  return <span className={`tabular-nums ${tone}`}>{formatPercent(pct)}</span>;
}

function RowActions({
  person,
  onDeleted,
}: {
  person: PersonPanel;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function toggleActive() {
    startTransition(async () => {
      await updatePersonField(person.id, "active", person.active ? "false" : "true");
      onDeleted();
    });
  }

  function remove() {
    startTransition(async () => {
      await deletePerson(person.id);
      setConfirming(false);
      onDeleted();
    });
  }

  return (
    <DropdownMenu open={confirming ? true : undefined} onOpenChange={(o) => !o && setConfirming(false)}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={pending}>
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Acciones</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggleActive(); }}>
          {person.active ? "Marcar como inactivo" : "Reactivar"}
        </DropdownMenuItem>
        {confirming ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(e) => { e.preventDefault(); remove(); }}
          >
            Confirmar eliminación
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(e) => { e.preventDefault(); setConfirming(true); }}
          >
            Eliminar…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonRow({
  person,
  year,
  canEdit,
  groupOptions,
  indented,
  onChanged,
}: {
  person: PersonPanel;
  year: number;
  canEdit: boolean;
  groupOptions: { value: string; label: string }[];
  indented: boolean;
  onChanged: () => void;
}) {
  return (
    <TableRow className={person.active ? "" : "opacity-55"}>
      <TableCell className={indented ? "pl-10" : ""}>
        <div className="flex items-center gap-2">
          <EditableField
            id={person.id}
            field="name"
            value={person.name}
            kind="text"
            canEdit={canEdit}
            action={updatePersonField}
          />
          {!person.active && (
            <Badge variant="outline" className="shrink-0 text-xs">
              Inactivo
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <EditableField
          id={person.id}
          field="role"
          value={person.role}
          kind="text"
          canEdit={canEdit}
          action={updatePersonField}
          placeholder="Figura en rol de pagos"
        />
      </TableCell>
      <TableCell>
        <EditableSelect
          id={person.id}
          field="groupId"
          value={person.groupId == null ? null : String(person.groupId)}
          options={groupOptions}
          canEdit={canEdit}
          action={updatePersonField}
          emptyLabel="— sin grupo —"
        />
      </TableCell>
      <TableCell className="text-right">
        {/* Addressed by person + YEAR: the salary row may not exist yet, so the
            field slot carries the year rather than a column name. */}
        <EditableField
          id={person.id}
          field={String(year)}
          value={person.hasSalary ? person.cost : null}
          kind="amount"
          canEdit={canEdit}
          action={updateSalaryForYear}
          formatters={MONEY_FORMATTERS}
          align="right"
          placeholder={`Sueldo ${year}`}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(person.funded)}</TableCell>
      <TableCell className="text-right">
        <CoverageCell c={person} />
      </TableCell>
      <TableCell className="text-right">
        <PercentCell c={person} />
      </TableCell>
      <TableCell className="w-8 text-right">
        {canEdit && <RowActions person={person} onDeleted={onChanged} />}
      </TableCell>
    </TableRow>
  );
}

export function PeopleTable({
  groups,
  ungrouped,
  total,
  year,
  canEdit,
}: {
  groups: GroupPanel[];
  ungrouped: PersonPanel[];
  total: Coverage;
  year: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [sortCol, setSortCol] = useState<SortCol>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(groups.map((g) => g.id)));

  const groupOptions = useMemo(
    () => groups.map((g) => ({ value: String(g.id), label: g.name })),
    [groups]
  );
  const groupNameById = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups]
  );

  function toggleSort(col: SortCol) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      // Money columns are most useful biggest-first on the first click.
      setSortDir(col === "name" || col === "role" || col === "group" ? "asc" : "desc");
    }
  }

  const asSortable = (p: PersonPanel): SortableRow => ({
    name: p.name,
    role: p.role,
    groupName: p.groupId == null ? null : groupNameById.get(p.groupId) ?? null,
    cost: p.cost,
    funded: p.funded,
    uncovered: p.uncovered,
    percentCovered: p.percentCovered,
  });

  /** Top level: ungrouped people and group rows, interleaved and sorted together. */
  const topLevel = useMemo(() => {
    type Entry =
      | { kind: "person"; person: PersonPanel; sortable: SortableRow }
      | { kind: "group"; group: GroupPanel; sortable: SortableRow };

    const entries: Entry[] = [
      ...ungrouped.map((p) => ({ kind: "person" as const, person: p, sortable: asSortable(p) })),
      ...groups.map((g) => ({
        kind: "group" as const,
        group: g,
        sortable: {
          name: g.name,
          role: null,
          groupName: null,
          cost: g.cost,
          funded: g.funded,
          uncovered: g.uncovered,
          percentCovered: g.percentCovered,
        },
      })),
    ];

    return entries.sort((a, b) => compare(a.sortable, b.sortable, sortCol, sortDir));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ungrouped, groups, sortCol, sortDir, groupNameById]);

  const sortedMembers = useMemo(() => {
    const out = new Map<number, PersonPanel[]>();
    for (const g of groups) {
      out.set(
        g.id,
        [...g.members].sort((a, b) => compare(asSortable(a), asSortable(b), sortCol, sortDir))
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, sortCol, sortDir, groupNameById]);

  const refresh = () => router.refresh();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="text-base">Personas · {year}</CardTitle>
        {canEdit && (
          <AddPersonDialog year={year} groups={groups.map((g) => ({ id: g.id, name: g.name }))}>
            <Button size="sm" variant="outline">
              <Plus className="h-4 w-4" />
              <span className="ml-1">Agregar persona</span>
            </Button>
          </AddPersonDialog>
        )}
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((c) => (
                  <TableHead
                    key={c.key}
                    className={c.align === "right" ? "text-right" : ""}
                  >
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
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {topLevel.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    Sin personas registradas todavía
                  </TableCell>
                </TableRow>
              )}

              {topLevel.map((entry) => {
                if (entry.kind === "person") {
                  return (
                    <PersonRow
                      key={`p-${entry.person.id}`}
                      person={entry.person}
                      year={year}
                      canEdit={canEdit}
                      groupOptions={groupOptions}
                      indented={false}
                      onChanged={refresh}
                    />
                  );
                }

                const g = entry.group;
                const isOpen = expanded.has(g.id);
                const members = sortedMembers.get(g.id) ?? [];

                return (
                  <Fragment key={`g-${g.id}`}>
                    <TableRow className="bg-muted/40 font-medium">
                      <TableCell className="whitespace-normal">
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(g.id)) next.delete(g.id);
                              else next.add(g.id);
                              return next;
                            })
                          }
                          className="inline-flex items-start gap-1.5 text-left hover:text-foreground"
                        >
                          {isOpen ? (
                            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />
                          ) : (
                            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
                          )}
                          <span>
                            {g.name}{" "}
                            <span className="text-xs font-normal text-muted-foreground">
                              ({g.memberCount})
                            </span>
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-normal text-xs font-normal text-muted-foreground">
                        {/* Capped + wrapping: an auto-layout table sizes this column to
                            its longest line, so an uncapped note widens every row. */}
                        <div className="max-w-[18rem] leading-snug">
                          <GroupNote group={g} year={year} />
                        </div>
                      </TableCell>
                      <TableCell />
                      {/* Derived from members — deliberately not editable. */}
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(g.cost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(g.funded)}
                      </TableCell>
                      <TableCell className="text-right">
                        <CoverageCell c={g} />
                      </TableCell>
                      <TableCell className="text-right">
                        <PercentCell c={g} />
                      </TableCell>
                      <TableCell />
                    </TableRow>

                    {isOpen &&
                      members.map((m) => (
                        <PersonRow
                          key={`gm-${m.id}`}
                          person={m}
                          year={year}
                          canEdit={canEdit}
                          groupOptions={groupOptions}
                          indented
                          onChanged={refresh}
                        />
                      ))}
                  </Fragment>
                );
              })}
            </TableBody>

            <tfoot className="border-t-2">
              <TableRow className="font-semibold hover:bg-transparent">
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(total.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(total.funded)}
                </TableCell>
                <TableCell className="text-right">
                  <CoverageCell c={total} />
                </TableCell>
                <TableCell className="text-right">
                  <PercentCell c={total} />
                </TableCell>
                <TableCell />
              </TableRow>
            </tfoot>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
