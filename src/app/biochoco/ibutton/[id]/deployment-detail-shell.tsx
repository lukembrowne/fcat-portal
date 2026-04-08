"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, Loader2 } from "lucide-react";
import { reprocessDeployment } from "../actions";
import { TemperatureLineChart } from "./temperature-line-chart";
import { StatsPanel } from "./stats-panel";
import { ReadingsTable } from "./readings-table";
import type { DeploymentDetail } from "../types";
import { getHabitatName } from "@/app/biochoco/overview/types";

export function DeploymentDetailShell({
  data,
  isEditor,
}: {
  data: DeploymentDetail;
  isEditor: boolean;
}) {
  const router = useRouter();
  const [reprocessing, setReprocessing] = useState(false);

  async function handleReprocess() {
    setReprocessing(true);
    try {
      const result = await reprocessDeployment(data.deployment.id);
      if (result.success) {
        router.refresh();
      } else {
        alert(result.error);
      }
    } finally {
      setReprocessing(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/biochoco/ibutton">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Volver
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold">{data.deployment.name}</h1>
            <p className="text-sm text-muted-foreground">
              {data.deployment.siteName && `${data.deployment.siteName} · `}
              {data.deployment.habitatType &&
                getHabitatName(data.deployment.habitatType)}
            </p>
          </div>
        </div>

        {isEditor && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleReprocess}
            disabled={reprocessing}
          >
            {reprocessing ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Reprocesar
          </Button>
        )}
      </div>

      {/* Temperature Chart */}
      {data.readings.length > 0 && (
        <TemperatureLineChart
          readings={data.readings}
          odkDeployAt={data.upload?.odkDeployAt ?? null}
          odkRetrieveAt={data.upload?.odkRetrieveAt ?? null}
        />
      )}

      {/* Stats + Device Info */}
      <StatsPanel stats={data.stats} upload={data.upload} />

      {/* Readings Table */}
      {data.readings.length > 0 && (
        <ReadingsTable
          readings={data.readings}
          isEditor={isEditor}
        />
      )}
    </div>
  );
}
