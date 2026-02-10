"use client";

import { useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import type {
  AnnualSummaryRow,
  MonthlyByYear,
  CategoryByYear,
} from "./actions";

const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

function formatCurrency(val: number) {
  return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SortIcon({ column }: { column: { getIsSorted: () => false | "asc" | "desc" } }) {
  const sorted = column.getIsSorted();
  if (sorted === "asc") return <ArrowUp className="h-3.5 w-3.5" />;
  if (sorted === "desc") return <ArrowDown className="h-3.5 w-3.5" />;
  return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
}

// ---------------------------------------------------------------------------
// Reusable table renderer
// ---------------------------------------------------------------------------
function DataTable<T>({
  title,
  columns,
  data,
}: {
  title: string;
  columns: ColumnDef<T, unknown>[];
  data: T[];
}) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
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
                        <SortIcon column={h.column} />
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
interface CategoryExpenseRow {
  category: string;
  [year: string]: string | number;
}

function CategoryExpensesTable({
  data,
  years,
}: {
  data: CategoryByYear[];
  years: number[];
}) {
  const tableData = useMemo<CategoryExpenseRow[]>(() => {
    // Collect all categories
    const categorySet = new Set<string>();
    for (const entry of data) categorySet.add(entry.category);

    const rows: CategoryExpenseRow[] = [];
    for (const cat of categorySet) {
      const row: CategoryExpenseRow = { category: cat };
      for (const y of years) {
        const entry = data.find((d) => d.year === y && d.category === cat);
        row[String(y)] = entry?.amount ?? 0;
      }
      if (years.length >= 2) {
        const latest = (row[String(years[years.length - 1])] as number) ?? 0;
        const prev = (row[String(years[years.length - 2])] as number) ?? 0;
        row["_change"] = latest - prev;
      }
      rows.push(row);
    }

    // Sort by latest year amount descending
    if (years.length > 0) {
      const latestYear = String(years[years.length - 1]);
      rows.sort((a, b) => ((b[latestYear] as number) ?? 0) - ((a[latestYear] as number) ?? 0));
    }

    return rows;
  }, [data, years]);

  const columns = useMemo<ColumnDef<CategoryExpenseRow, unknown>[]>(() => {
    const cols: ColumnDef<CategoryExpenseRow, unknown>[] = [
      {
        accessorKey: "category",
        header: "Categoria",
        size: 200,
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
      title="Gastos por Categoria por Ano"
      columns={columns}
      data={tableData}
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
