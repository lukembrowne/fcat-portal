"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save } from "lucide-react";
import { updateAudioDeploymentQa } from "../actions";

interface AudioQaSectionProps {
  deploymentId: number;
  canEdit: boolean;
  excludedAudio: boolean;
  qaNotes: string | null;
}

export function AudioQaSection({
  deploymentId,
  canEdit,
  excludedAudio: initialExcluded,
  qaNotes: initialQaNotes,
}: AudioQaSectionProps) {
  const [excluded, setExcluded] = useState(initialExcluded);
  const [qaNotes, setQaNotes] = useState(initialQaNotes ?? "");
  const [savingQa, setSavingQa] = useState(false);
  const [qaSaved, setQaSaved] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);

  const qaChanged =
    excluded !== initialExcluded || qaNotes !== (initialQaNotes ?? "");

  if (!canEdit) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox id="qa-excluded" checked={excluded} disabled />
          <Label htmlFor="qa-excluded" className="text-sm font-normal text-muted-foreground">
            Excluir del análisis de audio
          </Label>
        </div>
        {qaNotes && (
          <div>
            <p className="text-xs text-muted-foreground">Notas de calidad</p>
            <p className="text-sm whitespace-pre-wrap">{qaNotes}</p>
          </div>
        )}
      </div>
    );
  }

  async function handleSaveQa() {
    setSavingQa(true);
    setQaError(null);
    setQaSaved(false);

    const result = await updateAudioDeploymentQa(deploymentId, {
      excludedAudio: excluded,
      qaNotes: qaNotes || null,
    });

    setSavingQa(false);
    if (result.success) {
      setQaSaved(true);
      setTimeout(() => setQaSaved(false), 3000);
    } else {
      setQaError(result.error);
    }
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
          Excluir del análisis de audio
        </Label>
      </div>

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
          placeholder="Problemas con la grabadora, datos, etc."
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
            disabled={savingQa}
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
