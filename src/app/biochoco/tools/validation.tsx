"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { runValidation } from "./actions";

export function Validation() {
  const [errors, setErrors] = useState<string[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleValidate() {
    setFetchError(null);
    startTransition(async () => {
      const result = await runValidation();
      if (result.success) {
        setErrors(result.data);
      } else {
        setFetchError(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Validación del Cronograma</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Verificar el cronograma contra las restricciones de días hábiles y límites mensuales.
        </p>

        <Button onClick={handleValidate} disabled={isPending} variant="secondary">
          {isPending ? "Validando..." : "Ejecutar Validación"}
        </Button>

        {fetchError && <p className="text-sm text-destructive">{fetchError}</p>}

        {errors !== null && (
          errors.length > 0 ? (
            <div className="rounded-md bg-red-50 p-4 text-sm">
              <p className="font-medium text-red-800">Se encontraron {errors.length} problemas:</p>
              <ul className="mt-2 list-disc pl-5 text-red-700 space-y-1">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-green-600 font-medium">
              El cronograma pasa todas las verificaciones.
            </p>
          )
        )}

        <div className="border-t pt-4">
          <h3 className="text-sm font-medium mb-2">Reglas de Restricción</h3>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li><strong>Días hábiles:</strong> Solo días 11-30 de cada mes</li>
            <li><strong>Límites mensuales:</strong> Máximo 20 instalaciones, máximo 20 recuperaciones por mes</li>
            <li><strong>Unicidad:</strong> Máximo 1 instalación/recuperación por día</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
