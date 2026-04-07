"use client";

import { useState, useTransition } from "react";
import { MessageSquare, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { updateDeploymentFieldNotes } from "./actions";

const MAX_LENGTH = 2000;

interface FieldNotesPopoverProps {
  deploymentName: string;
  initialNotes: string | null;
  canEdit: boolean;
}

export function FieldNotesPopover({
  deploymentName,
  initialNotes,
  canEdit,
}: FieldNotesPopoverProps) {
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [open, setOpen] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const hasNotes = !!(initialNotes?.trim());
  const isDirty = (notes.trim() || null) !== initialNotes;

  const handleSave = () => {
    startSaving(async () => {
      setError(null);
      const result = await updateDeploymentFieldNotes(
        deploymentName,
        notes.trim() || null
      );
      if (result.success) {
        setSaved(true);
        setTimeout(() => {
          setSaved(false);
          setOpen(false);
        }, 1000);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center"
          title={hasNotes ? "Ver notas de campo" : "Agregar notas de campo"}
        >
          <MessageSquare
            className={`h-3.5 w-3.5 ${
              hasNotes
                ? "fill-amber-500 text-amber-600"
                : "text-muted-foreground/40"
            }`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Notas de campo
          </p>
          <p className="text-xs text-muted-foreground">{deploymentName}</p>

          {canEdit ? (
            <>
              <div>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Problemas con equipos, datos faltantes, condiciones del sitio..."
                  rows={4}
                  maxLength={MAX_LENGTH}
                  className="text-sm"
                />
                <div className="flex items-center justify-between mt-1">
                  <span
                    className={`text-xs ${
                      notes.length > MAX_LENGTH
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {notes.length} / {MAX_LENGTH}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {isDirty && (
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3 mr-1" />
                    )}
                    Guardar
                  </Button>
                )}
                {saved && (
                  <span className="text-xs text-green-600">Guardado</span>
                )}
                {error && (
                  <span className="text-xs text-destructive">{error}</span>
                )}
              </div>
            </>
          ) : (
            // Read-only view
            hasNotes ? (
              <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                <p className="text-sm whitespace-pre-wrap">{initialNotes}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                Sin notas de campo
              </p>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
