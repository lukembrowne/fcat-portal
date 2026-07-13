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

interface UnlinkedBudgetCardProps {
  unlinkedBudget: string[];
}

/**
 * Read-only card listing budget categories that have no linked accounting
 * category. The inverse gap (accounting categories with no budget) is now
 * handled by the editable CategoryLinkEditor.
 */
export function UnlinkedBudgetCard({ unlinkedBudget }: UnlinkedBudgetCardProps) {
  return (
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
  );
}
