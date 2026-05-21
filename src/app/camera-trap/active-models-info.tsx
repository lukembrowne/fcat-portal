"use client";

import { useEffect, useState } from "react";
import { Cpu, Loader2 } from "lucide-react";

import {
  getActiveClassifierInfo,
  type ActiveClassifierInfo,
} from "./models/actions";

/**
 * Small read-only block shown inside Procesar/Procesar nuevas dialogs so
 * the user can confirm which detector + classifier the next ML run will
 * actually use.
 *
 * The job row's `classifierModel` string is stamped with the AI4G default
 * at creation and isn't authoritative — the real swap happens at spawn
 * time in ml-runner-env. This component resolves the same logic so the
 * dialog shows the truth before the job is queued.
 */
export function ActiveModelsInfo() {
  const [info, setInfo] = useState<ActiveClassifierInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getActiveClassifierInfo()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        // Failure is non-blocking — the dialog still works without this info.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Resolviendo modelos activos...
      </div>
    );
  }
  if (!info) return null;

  const classifierLabel =
    info.classifier.kind === "custom"
      ? `${info.classifier.version} (custom_timm · ${info.classifier.backbone}${
          info.classifier.top1Accuracy != null
            ? `, top1=${info.classifier.top1Accuracy.toFixed(3)}`
            : ""
        })`
      : `${info.classifier.name} (predeterminado)`;

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1">
      <div className="flex items-center gap-1.5 font-medium">
        <Cpu className="h-3.5 w-3.5" />
        Modelos a usar
      </div>
      <div className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
        <span>Detector:</span>
        <span className="font-mono text-foreground">{info.detector}</span>
        <span>Clasificador:</span>
        <span className="font-mono text-foreground">{classifierLabel}</span>
      </div>
      <p className="text-[11px] text-muted-foreground pt-0.5">
        Resuelto al iniciar el siguiente trabajo. Los trabajos ya en curso
        continúan con el clasificador con el que se lanzaron.
      </p>
    </div>
  );
}
