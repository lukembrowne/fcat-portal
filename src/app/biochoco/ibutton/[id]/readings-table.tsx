"use client";

import { useState, useTransition } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Flag } from "lucide-react";
import { toggleReadingFlag } from "../actions";

const PAGE_SIZE = 50;

interface Reading {
  id: number;
  timestamp: string;
  temperatureC: number;
  flagged: boolean;
}

export function ReadingsTable({
  readings: initialReadings,
  isEditor,
}: {
  readings: Reading[];
  isEditor: boolean;
}) {
  const [readings, setReadings] = useState(initialReadings);
  const [page, setPage] = useState(0);
  const [isPending, startTransition] = useTransition();

  const totalPages = Math.ceil(readings.length / PAGE_SIZE);
  const paged = readings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function handleToggleFlag(readingId: number) {
    startTransition(async () => {
      const result = await toggleReadingFlag(readingId);
      if (result.success) {
        setReadings((prev) =>
          prev.map((r) =>
            r.id === readingId ? { ...r, flagged: result.data.flagged } : r
          )
        );
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Lecturas ({readings.length.toLocaleString("es")})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha/Hora</TableHead>
              <TableHead className="text-right">Temperatura (°C)</TableHead>
              <TableHead className="text-center">Marcado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((r) => (
              <TableRow
                key={r.id}
                className={r.flagged ? "bg-amber-50 dark:bg-amber-950/20" : ""}
              >
                <TableCell className="font-mono text-sm">
                  {r.timestamp}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.temperatureC}
                </TableCell>
                <TableCell className="text-center">
                  {isEditor ? (
                    <button
                      onClick={() => handleToggleFlag(r.id)}
                      disabled={isPending}
                      className="p-1 rounded hover:bg-muted"
                    >
                      <Flag
                        className={`h-4 w-4 ${
                          r.flagged
                            ? "text-amber-500 fill-amber-500"
                            : "text-muted-foreground/30"
                        }`}
                      />
                    </button>
                  ) : r.flagged ? (
                    <Flag className="h-4 w-4 text-amber-500 fill-amber-500 mx-auto" />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-muted-foreground">
              Página {page + 1} de {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
