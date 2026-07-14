"use client";

import { useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
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
import { SortIcon } from "@/components/sort-icon";
import { Search } from "lucide-react";
import type {
  AnnualSummaryRow,
  MonthlyByYear,
  CategoryByYear,
} from "./actions";
import { buildCategoryYearRows, type CategoryYearRow } from "./category-rows";

const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

function formatCurrency(val: number) {
  return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Reusable table renderer
// ---------------------------------------------------------------------------
function DataTable<T>({
  title,
  columns,
  data,
  searchable = false,
  searchPlaceholder,
  globalFilterFn,
}: {
  title: string;
  columns: ColumnDef<T, unknown>[];
  data: T[];
  searchable?: boolean;
  searchPlaceholder?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalFilterFn?: (row: any, columnId: string, filterValue: string) => boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: searchable ? getFilteredRowModel() : undefined,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {searchable && (
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder ?? "Buscar..."}
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="pl-8 w-56"
              />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
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
                    Sin datos disponibles
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

// ---------------------------------------------------------------------------
// Annual Summary Table
// ---------------------------------------------------------------------------
function AnnualSummaryTable({ data }: { data: AnnualSummaryRow[] }) {
  const columns = useMemo<ColumnDef<AnnualSummaryRow, unknown>[]>(
    () => [
      {
        accessorKey: "year",
        header: "Ano",
        size: 80,
      },
      {
        accessorKey: "totalRevenue",
        header: "Ingresos Totales",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
        ),
      },
      {
        accessorKey: "totalExpenses",
        header: "Gastos Totales",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
        ),
      },
      {
        id: "net",
        header: "Neto",
        accessorFn: (row) => row.totalRevenue - row.totalExpenses,
        cell: ({ getValue }) => {
          const val = getValue<number>();
          return (
            <span
              className={`tabular-nums font-medium ${val >= 0 ? "text-green-600" : "text-red-600"}`}
            >
              {formatCurrency(val)}
            </span>
          );
        },
      },
    ],
    []
  );

  return <DataTable title="Resumen Anual" columns={columns} data={data} />;
}

// ---------------------------------------------------------------------------
// Monthly Expenses Table
// ---------------------------------------------------------------------------
interface MonthlyExpenseRow {
  month: string;
  monthNum: number;
  [year: string]: string | number;
}

function MonthlyExpensesTable({
  data,
  years,
}: {
  data: MonthlyByYear[];
  years: number[];
}) {
  const tableData = useMemo<MonthlyExpenseRow[]>(() => {
    const rows: MonthlyExpenseRow[] = [];
    for (let m = 1; m <= 12; m++) {
      const row: MonthlyExpenseRow = {
        month: MONTH_NAMES[m - 1],
        monthNum: m,
      };
      for (const y of years) {
        const entry = data.find((d) => d.year === y && d.month === m);
        row[String(y)] = entry?.amount ?? 0;
      }
      // Change: latest year - previous year
      if (years.length >= 2) {
        const latest = (row[String(years[years.length - 1])] as number) ?? 0;
        const prev = (row[String(years[years.length - 2])] as number) ?? 0;
        row["_change"] = latest - prev;
      }
      rows.push(row);
    }
    return rows;
  }, [data, years]);

  const columns = useMemo<ColumnDef<MonthlyExpenseRow, unknown>[]>(() => {
    const cols: ColumnDef<MonthlyExpenseRow, unknown>[] = [
      {
        accessorKey: "month",
        header: "Mes",
        size: 80,
      },
    ];

    for (const y of years) {
      cols.push({
        accessorKey: String(y),
        header: String(y),
        cell: ({ getValue }) => (
          <span className="tabular-nums">
            {formatCurrency(getValue<number>())}
          </span>
        ),
      });
    }

    if (years.length >= 2) {
      cols.push({
        accessorKey: "_change",
        header: "Cambio",
        cell: ({ getValue }) => {
          const val = getValue<number>();
          return (
            <span
              className={`tabular-nums font-medium ${val > 0 ? "text-red-600" : val < 0 ? "text-green-600" : ""}`}
            >
              {val > 0 ? "+" : ""}
              {formatCurrency(val)}
            </span>
          );
        },
      });
    }

    return cols;
  }, [years]);

  return (
    <DataTable
      title="Gastos Mensuales por Ano"
      columns={columns}
      data={tableData}
    />
  );
}

// ---------------------------------------------------------------------------
// Expenses by Category Table
// ---------------------------------------------------------------------------
function CategoryExpensesTable({
  data,
  years,
}: {
  data: CategoryByYear[];
  years: number[];
}) {
  const tableData = useMemo<CategoryYearRow[]>(
    () => buildCategoryYearRows(data, years),
    [data, years]
  );

  const columns = useMemo<ColumnDef<CategoryYearRow, unknown>[]>(() => {
    const cols: ColumnDef<CategoryYearRow, unknown>[] = [
      {
        accessorKey: "category",
        header: "Categoria",
        size: 240,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="min-w-[200px]">
              <span>{r.category}</span>
              <div
                aria-hidden
                className="mt-1 h-1.5 rounded-full opacity-70"
                style={{
                  width: `${Math.max(r.barFraction * 100, 1.5)}%`,
                  backgroundColor: "var(--chart-1)",
                }}
              />
            </div>
          );
        },
      },
    ];

    for (const y of years) {
      const key = String(y);
      cols.push({
        id: key,
        accessorFn: (row) => row.perYear[key] ?? 0,
        header: key,
        cell: ({ getValue }) => (
          <span className="tabular-nums">
            {formatCurrency(getValue<number>())}
          </span>
        ),
      });
    }

    cols.push({
      accessorKey: "total",
      header: "Total",
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">
          {formatCurrency(getValue<number>())}
        </span>
      ),
    });

    if (years.length >= 2) {
      cols.push({
        id: "_change",
        accessorFn: (row) => row.change ?? 0,
        header: "Cambio",
        cell: ({ getValue }) => {
          const val = getValue<number>();
          return (
            <span
              className={`tabular-nums font-medium ${val > 0 ? "text-red-600" : val < 0 ? "text-green-600" : ""}`}
            >
              {val > 0 ? "+" : ""}
              {formatCurrency(val)}
            </span>
          );
        },
      });
    }

    return cols;
  }, [years]);

  return (
    <DataTable
      title="Gastos por Categoria por Ano"
      columns={columns}
      data={tableData}
      searchable
      searchPlaceholder="Buscar categoria..."
      globalFilterFn={(row, _columnId, filterValue) =>
        String(row.original.category)
          .toLowerCase()
          .includes(filterValue.toLowerCase())
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export function AnnualTables({
  annualSummary,
  monthlyExpenses,
  expensesByCategory,
}: {
  annualSummary: AnnualSummaryRow[];
  monthlyExpenses: MonthlyByYear[];
  expensesByCategory: CategoryByYear[];
}) {
  const years = useMemo(
    () => [...new Set(annualSummary.map((r) => r.year))].sort((a, b) => a - b),
    [annualSummary]
  );

  return (
    <div className="space-y-4">
      <AnnualSummaryTable data={annualSummary} />
      <MonthlyExpensesTable data={monthlyExpenses} years={years} />
      <CategoryExpensesTable data={expensesByCategory} years={years} />
    </div>
  );
}
