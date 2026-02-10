"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle } from "lucide-react";

interface UnlinkedTablesProps {
  unlinkedAccounting: string[];
  unlinkedBudget: string[];
}

export function UnlinkedTables({
  unlinkedAccounting,
  unlinkedBudget,
}: UnlinkedTablesProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Accounting categories not mapped to budget */}
      {unlinkedAccounting.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-base">
                Categorias contables sin presupuesto
              </CardTitle>
            </div>
            <p className="text-xs text-muted-foreground">
              Categorias de gastos en contabilidad que no estan vinculadas a una
              categoria de presupuesto
            </p>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Categoria Contable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unlinkedAccounting.map((cat) => (
                    <TableRow key={cat}>
                      <TableCell>{cat}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Budget categories with no accounting matches */}
      {unlinkedBudget.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-base">
                Categorias de presupuesto sin contabilidad
              </CardTitle>
            </div>
            <p className="text-xs text-muted-foreground">
              Categorias del presupuesto anual que no tienen categorias contables
              vinculadas
            </p>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Categoria de Presupuesto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unlinkedBudget.map((cat) => (
                    <TableRow key={cat}>
                      <TableCell>{cat}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
