"use client";

import { useState, useEffect, useTransition } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SortIcon } from "@/components/sort-icon";
import { AlertTriangle, Search } from "lucide-react";
import { setCategoryLink, type CategoryLinkEditorRow } from "./actions";

const NONE = "__none__";

function formatCurrency(val: number) {
  return (
    "$" +
    val.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

interface CategoryLinkEditorProps {
  rows: CategoryLinkEditorRow[];
  budgetCategoryOptions: string[];
}

export function CategoryLinkEditor({
  rows: initialRows,
  budgetCategoryOptions,
}: CategoryLinkEditorProps) {
  const [rows, setRows] = useState(initialRows);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync when the server sends fresh data after a revalidation.
  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  function handleChange(linkCategory: string, next: string | null) {
    const prev = rows.find((r) => r.linkCategory === linkCategory)?.budgetCategory ?? null;
    setError(null);
    setRows((rs) =>
      rs.map((r) =>
        r.linkCategory === linkCategory ? { ...r, budgetCategory: next } : r
      )
    );
    startTransition(async () => {
      const res = await setCategoryLink(linkCategory, next);
      if (!res.success) {
        // Revert the optimistic change and surface the error.
        setRows((rs) =>
          rs.map((r) =>
            r.linkCategory === linkCategory ? { ...r, budgetCategory: prev } : r
          )
        );
        setError(res.error);
      }
    });
  }

  const columns: ColumnDef<CategoryLinkEditorRow>[] = [
    {
      accessorKey: "linkCategory",
      header: "Categoría Contable",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex items-center gap-2">
            {r.budgetCategory === null && (
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            )}
            <span>{r.linkCategory}</span>
          </div>
        );
      },
    },
    {
      accessorKey: "spent",
      header: "Gasto (año)",
      size: 130,
      cell: ({ getValue }) => (
        <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "budgetCategory",
      header: "Categoría de Presupuesto",
      size: 260,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <Select
            value={r.budgetCategory ?? NONE}
            onValueChange={(v) =>
              handleChange(r.linkCategory, v === NONE ? null : v)
            }
          >
            <SelectTrigger className="w-full max-w-[260px]">
              <SelectValue placeholder="Sin vincular" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin vincular</SelectItem>
              {budgetCategoryOptions.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      },
      // Sort nulls (unlinked) first.
      sortingFn: (a, b) =>
        (a.original.budgetCategory ?? "").localeCompare(
          b.original.budgetCategory ?? ""
        ),
    },
  ];

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const unlinkedCount = rows.filter((r) => r.budgetCategory === null).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Vincular Categorías Contables</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Asigna cada categoría contable del sistema Link a una línea del
              presupuesto. {unlinkedCount} sin vincular de {rows.length}.
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-8 w-64"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-3 text-sm text-destructive">{error}</p>
        )}
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((h) => (
                    <TableHead
                      key={h.id}
                      className="cursor-pointer select-none whitespace-nowrap"
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <SortIcon direction={h.column.getIsSorted()} />
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No hay categorías contables
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="whitespace-nowrap">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
