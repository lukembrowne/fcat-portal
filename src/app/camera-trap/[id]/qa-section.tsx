"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save } from "lucide-react";
import { updateDeploymentQa } from "../actions";

interface QaSectionProps {
  deploymentId: number;
  canEdit: boolean;
  excluded: boolean;
  validStart: string | null;
  validEnd: string | null;
  qaNotes: string | null;
}

export function QaSection({
  deploymentId,
  canEdit,
  excluded: initialExcluded,
  validStart: initialValidStart,
  validEnd: initialValidEnd,
  qaNotes: initialQaNotes,
}: QaSectionProps) {
  const [excluded, setExcluded] = useState(initialExcluded);
  const [validStart, setValidStart] = useState(initialValidStart ?? "");
  const [validEnd, setValidEnd] = useState(initialValidEnd ?? "");
  const [qaNotes, setQaNotes] = useState(initialQaNotes ?? "");
  const [savingQa, startSavingQa] = useTransition();
  const [qaError, setQaError] = useState<string | null>(null);
  const [qaSaved, setQaSaved] = useState(false);

  const qaChanged =
    excluded !== initialExcluded ||
    (validStart || null) !== initialValidStart ||
    (validEnd || null) !== initialValidEnd ||
    (qaNotes.trim() || null) !== initialQaNotes;

  const qaDateWarning =
    validStart && validEnd && validStart > validEnd
      ? "La fecha de inicio válida debe ser anterior a la fecha de fin"
      : null;

  const handleSaveQa = () => {
    startSavingQa(async () => {
      setQaError(null);
      const result = await updateDeploymentQa(deploymentId, {
        excluded,
        validStart: validStart || null,
        validEnd: validEnd || null,
        qaNotes: qaNotes.trim() || null,
      });
      if (result.success) {
        setQaSaved(true);
        setTimeout(() => setQaSaved(false), 2000);
      } else {
        setQaError(result.error);
      }
    });
  };

  if (!canEdit) {
    // Read-only view
    const hasQaData = initialExcluded || initialValidStart || initialValidEnd || initialQaNotes;
    if (!hasQaData) return null;

    return (
      <div className="space-y-2">
        {initialExcluded && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5">
            <div className="h-2 w-2 rounded-full bg-destructive shrink-0" />
            <p className="text-xs font-medium text-destructive">Excluida de exportaciones</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          {initialValidStart && (
            <div>
              <p className="text-sm text-muted-foreground">Inicio válido</p>
              <p className="text-sm font-medium">{initialValidStart}</p>
            </div>
          )}
          {initialValidEnd && (
            <div>
              <p className="text-sm text-muted-foreground">Fin válido</p>
              <p className="text-sm font-medium">{initialValidEnd}</p>
            </div>
          )}
        </div>
        {initialQaNotes && (
          <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide mb-0.5">Notas QA</p>
            <p className="text-sm whitespace-pre-wrap">{initialQaNotes}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id="qa-excluded"
          checked={excluded}
          onCheckedChange={(v) => setExcluded(!!v)}
        />
        <Label htmlFor="qa-excluded" className="text-sm font-normal">
          Excluir de exportaciones
        </Label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="qa-valid-start" className="text-xs text-muted-foreground">
            Inicio válido
          </Label>
          <Input
            id="qa-valid-start"
            type="datetime-local"
            className="h-8 text-sm"
            value={validStart}
            onChange={(e) => setValidStart(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="qa-valid-end" className="text-xs text-muted-foreground">
            Fin válido
          </Label>
          <Input
            id="qa-valid-end"
            type="datetime-local"
            className="h-8 text-sm"
            value={validEnd}
            onChange={(e) => setValidEnd(e.target.value)}
          />
        </div>
      </div>
      {qaDateWarning && (
        <p className="text-xs text-amber-600">{qaDateWarning}</p>
      )}

      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="qa-notes" className="text-xs text-muted-foreground">
            Notas de calidad
          </Label>
          <span className={`text-xs ${qaNotes.length > 2000 ? "text-destructive" : "text-muted-foreground"}`}>
            {qaNotes.length} / 2000
          </span>
        </div>
        <Textarea
          id="qa-notes"
          value={qaNotes}
          onChange={(e) => setQaNotes(e.target.value)}
          placeholder="Problemas con la cámara, datos, etc."
          rows={2}
          maxLength={2000}
          className="text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        {qaChanged && (
          <Button
            size="sm"
            onClick={handleSaveQa}
            disabled={savingQa || !!qaDateWarning}
          >
            {savingQa ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Save className="h-3 w-3 mr-1" />
            )}
            Guardar
          </Button>
        )}
        {qaSaved && (
          <span className="text-sm text-green-600">Guardado</span>
        )}
        {qaError && (
          <span className="text-sm text-destructive">{qaError}</span>
        )}
      </div>
    </div>
  );
}
