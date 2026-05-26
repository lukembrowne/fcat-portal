"use client";

import { useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SortIcon } from "@/components/sort-icon";
import type { ScheduleRow } from "@/lib/schedule-types";
import { getDeploymentStatus } from "./types";

interface NoteRow {
  deploymentId: string;
  siteName: string;
  status: "scheduled" | "deployed" | "retrieved";
  notes: string;
}

type SortKey = "deploymentId" | "siteName" | "status";

const STATUS_ORDER: Record<NoteRow["status"], number> = {
  scheduled: 0,
  deployed: 1,
  retrieved: 2,
};

function statusBadge(status: NoteRow["status"]) {
  switch (status) {
    case "retrieved":
      return <Badge variant="secondary">Recuperado</Badge>;
    case "deployed":
      return <Badge variant="default">Instalado</Badge>;
    default:
      return <Badge variant="outline">Programado</Badge>;
  }
}

interface FieldNotesTableProps {
  schedule: ScheduleRow[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
}

export function FieldNotesTable({ schedule, deployedSet, retrievedSet }: FieldNotesTableProps) {
  const [sortBy, setSortBy] = useState<SortKey>("deploymentId");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const rows = useMemo<NoteRow[]>(() => {
    return schedule
      .filter((r) => r.fieldNotes && r.fieldNotes.trim().length > 0)
      .map((r) => ({
        deploymentId: r.deploymentId,
        siteName: r.siteName,
        status: getDeploymentStatus(r.deploymentId, deployedSet, retrievedSet),
        notes: r.fieldNotes!.trim(),
      }));
  }, [schedule, deployedSet, retrievedSet]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp: number;
      if (sortBy === "status") {
        cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      } else {
        cmp = a[sortBy].localeCompare(b[sortBy]);
      }
      if (cmp !== 0) return cmp * dir;
      // Stable tiebreaker on deployment id
      return a.deploymentId.localeCompare(b.deploymentId);
    });
  }, [rows, sortBy, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir("asc");
    }
  }

  function sortableHead(key: SortKey, label: string) {
    return (
      <TableHead
        className="cursor-pointer select-none"
        onClick={() => toggleSort(key)}
      >
        <span className="flex items-center gap-1">
          {label}
          <SortIcon direction={sortBy === key ? sortDir : false} />
        </span>
      </TableHead>
    );
  }

  return (
    <div className="rounded-xl border overflow-auto">
      <Table className="text-sm">
        <TableHeader>
          <TableRow>
            {sortableHead("deploymentId", "ID Instalación")}
            {sortableHead("siteName", "Sitio")}
            {sortableHead("status", "Estado")}
            <TableHead className="w-full">Nota</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                Sin notas de campo registradas
              </TableCell>
            </TableRow>
          ) : (
            sortedRows.map((r) => (
              <TableRow key={r.deploymentId}>
                <TableCell className="font-mono text-xs whitespace-nowrap">{r.deploymentId}</TableCell>
                <TableCell className="max-w-[16rem] truncate" title={r.siteName}>{r.siteName}</TableCell>
                <TableCell className="whitespace-nowrap">{statusBadge(r.status)}</TableCell>
                <TableCell className="w-full whitespace-pre-wrap">{r.notes}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
