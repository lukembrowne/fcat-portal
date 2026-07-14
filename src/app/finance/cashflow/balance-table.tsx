"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import type { CashflowMonthRow } from "../types";

function fmt(n: number | null): string {
  if (n === null) return "—";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMonth(ym: string): string {
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const m = parseInt(ym.slice(5, 7), 10) - 1;
  return `${months[m]} ${ym.slice(0, 4)}`;
}

function exportCSV(rows: CashflowMonthRow[]) {
  const headers = [
    "Fecha",
    "Ingresos",
    "Gastos",
    "Neto",
    "Ingresos Proyectados",
    "Gastos Proyectados",
    "Gastos Adicionales Proy.",
    "Saldo",
    "Saldo Proyectado",
  ];
  const csvRows = rows.map((r) =>
    [
      r.yearMonth,
      r.revenue ?? "",
      r.expenses ?? "",
      r.net ?? "",
      r.projectedIncome ?? "",
      r.projectedExpenses ?? "",
      r.projectedAdditionalExpenses ?? "",
      r.balance ?? "",
      r.projectedBalance ?? "",
    ].join(",")
  );
  const csv = [headers.join(","), ...csvRows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "flujo-de-caja.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function BalanceTable({ monthRows }: { monthRows: CashflowMonthRow[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Balance Mensual
            {monthRows.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({monthRows.length} meses)
              </span>
            )}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => exportCSV(monthRows)}
          >
            <Download className="h-4 w-4 mr-1" />
            CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {monthRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Sin datos disponibles
          </p>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="whitespace-nowrap">Fecha</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Ingresos</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Gastos</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Neto</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Ing. Proy.</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Gastos Proy.</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Gastos Adic.</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Saldo</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Saldo Proy.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthRows.map((row) => (
                    <TableRow key={row.yearMonth}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {fmtMonth(row.yearMonth)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {fmt(row.revenue)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {fmt(row.expenses)}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-sm ${row.net !== null && row.net < 0 ? "text-red-600" : ""}`}>
                        {fmt(row.net)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-green-600">
                        {fmt(row.projectedIncome)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {fmt(row.projectedExpenses)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {fmt(row.projectedAdditionalExpenses)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">
                        {fmt(row.balance)}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-sm font-semibold ${row.projectedBalance !== null && row.projectedBalance < 0 ? "text-red-600" : "text-purple-600"}`}>
                        {fmt(row.projectedBalance)}
                      </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
