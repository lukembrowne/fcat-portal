"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Thermometer } from "lucide-react";
import { processAllIbutton } from "./actions";
import { SummaryCards } from "./summary-cards";
import { HabitatChart } from "./habitat-chart";
import { DeploymentsTable } from "./deployments-table";
import type { IbuttonStatus, HabitatSummary, DeploymentSummary } from "./types";

type ProcessingState = "idle" | "processing" | "success" | "error";

export function TemperatureShell({
  status,
  habitatSummary,
  deployments,
  isEditor,
}: {
  status: IbuttonStatus | null;
  habitatSummary: HabitatSummary[];
  deployments: DeploymentSummary[];
  isEditor: boolean;
}) {
  const router = useRouter();
  const [processingState, setProcessingState] =
    useState<ProcessingState>("idle");
  const [processingMessage, setProcessingMessage] = useState("");

  async function handleProcessAll() {
    setProcessingState("processing");
    setProcessingMessage("Procesando archivos iButton...");

    try {
      const result = await processAllIbutton();
      if (result.success) {
        const { processed, failed, errors } = result.data;
        if (processed === 0 && failed === 0) {
          setProcessingMessage(errors[0] ?? "No hay nada que procesar.");
        } else {
          setProcessingMessage(
            `${processed} procesado(s), ${failed} con error.${errors.length > 0 ? ` ${errors[0]}` : ""}`
          );
        }
        setProcessingState("success");
        router.refresh();
      } else {
        setProcessingMessage(result.error);
        setProcessingState("error");
      }
    } catch (err) {
      setProcessingMessage(
        err instanceof Error ? err.message : "Error inesperado"
      );
      setProcessingState("error");
    }
  }

  const hasUnprocessed = status && status.unprocessed > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Thermometer className="h-5 w-5 text-orange-600" />
          <h1 className="text-2xl font-bold">Temperatura (iButton)</h1>
        </div>

        {isEditor && (
          <div className="flex items-center gap-3">
            {processingState !== "idle" && (
              <p
                className={`text-sm ${
                  processingState === "error"
                    ? "text-red-600"
                    : processingState === "success"
                      ? "text-emerald-600"
                      : "text-muted-foreground"
                }`}
              >
                {processingMessage}
              </p>
            )}
            <Button
              onClick={handleProcessAll}
              disabled={processingState === "processing" || !hasUnprocessed}
            >
              {processingState === "processing" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Procesando...
                </>
              ) : (
                <>
                  Procesar iButton
                  {hasUnprocessed && (
                    <span className="ml-1 text-xs">
                      ({status!.unprocessed})
                    </span>
                  )}
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Summary Cards */}
      <SummaryCards status={status} />

      {/* Habitat Comparison Chart */}
      <HabitatChart data={habitatSummary} />

      {/* Deployments Table */}
      <DeploymentsTable deployments={deployments} isEditor={isEditor} />
    </div>
  );
}
