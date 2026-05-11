"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import type { ActionResult } from "@/lib/types";

interface CtProjectOption {
  id: number;
  name: string;
}

/**
 * Field set the dialog can apply. All fields are optional — only those whose
 * `apply*` checkbox is ticked are populated and sent to `onSubmit`. Modules
 * that don't care about a field can simply ignore it server-side.
 */
export interface BatchEditFields {
  cameraTrapProjectId?: number | null;
  siteName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  excluded?: boolean;
  qaNotes?: string | null;
}

interface BatchEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  distinctProjects: CtProjectOption[];
  /** Module-specific mutation. Called with the IDs and the subset of fields
   *  whose `apply*` checkbox was ticked. */
  onSubmit: (
    ids: number[],
    fields: BatchEditFields
  ) => Promise<ActionResult<unknown>>;
  /** Called after a successful submit so the caller can clear selection,
   *  invalidate caches, etc. */
  onComplete: () => void;
}

/**
 * Bulk-edit deployment metadata. Shared between camera-trap and audio: each
 * module passes its own `onSubmit` callback that hits the appropriate server
 * action. Fields map 1:1 to columns on the `deployments` table, which both
 * modules share.
 */
export function BatchEditDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  distinctProjects,
  onSubmit,
  onComplete,
}: BatchEditDialogProps) {
  const [applyProject, setApplyProject] = useState(false);
  const [applyLocation, setApplyLocation] = useState(false);
  const [applyDates, setApplyDates] = useState(false);
  const [applySite, setApplySite] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [applyExcluded, setApplyExcluded] = useState(false);
  const [excludedValue, setExcludedValue] = useState("");
  const [applyQaNotes, setApplyQaNotes] = useState(false);
  const [qaNotes, setQaNotes] = useState("");
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    startSaving(async () => {
      setError(null);
      const fields: BatchEditFields = {};
      if (applyProject) {
        fields.cameraTrapProjectId = selectedProjectId
          ? parseInt(selectedProjectId, 10)
          : null;
      }
      if (applySite) fields.siteName = siteName.trim() || null;
      if (applyLocation) {
        fields.latitude = latitude ? parseFloat(latitude) : null;
        fields.longitude = longitude ? parseFloat(longitude) : null;
      }
      if (applyDates) {
        fields.dateStart = dateStart || null;
        fields.dateEnd = dateEnd || null;
      }
      if (applyExcluded) {
        fields.excluded = excludedValue === "true";
      }
      if (applyQaNotes) {
        fields.qaNotes = qaNotes.trim() || null;
      }

      if (Object.keys(fields).length === 0) {
        setError("Selecciona al menos un campo para aplicar.");
        return;
      }

      const result = await onSubmit(selectedIds, fields);
      if (result.success) {
        onOpenChange(false);
        onComplete();
        // Reset form
        setApplyProject(false);
        setApplyLocation(false);
        setApplyDates(false);
        setApplySite(false);
        setSelectedProjectId("");
        setSiteName("");
        setLatitude("");
        setLongitude("");
        setDateStart("");
        setDateEnd("");
        setApplyExcluded(false);
        setExcludedValue("");
        setApplyQaNotes(false);
        setQaNotes("");
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar {selectedCount} Instalaciones</DialogTitle>
          <DialogDescription>
            Solo los campos marcados serán actualizados.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Project */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="apply-project"
              checked={applyProject}
              onCheckedChange={(v) => setApplyProject(!!v)}
              className="mt-2"
            />
            <div className="flex-1">
              <Label htmlFor="batch-project">Proyecto</Label>
              <Select
                value={selectedProjectId}
                onValueChange={setSelectedProjectId}
                disabled={!applyProject}
              >
                <SelectTrigger id="batch-project">
                  <SelectValue placeholder="Seleccionar proyecto" />
                </SelectTrigger>
                <SelectContent>
                  {distinctProjects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Site */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="apply-site"
              checked={applySite}
              onCheckedChange={(v) => setApplySite(!!v)}
              className="mt-2"
            />
            <div className="flex-1">
              <Label htmlFor="batch-site">Sitio</Label>
              <Input
                id="batch-site"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                disabled={!applySite}
                placeholder="Nombre del sitio"
              />
            </div>
          </div>

          {/* Location */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="apply-location"
              checked={applyLocation}
              onCheckedChange={(v) => setApplyLocation(!!v)}
              className="mt-2"
            />
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="batch-lat">Latitud</Label>
                <Input
                  id="batch-lat"
                  type="number"
                  step="any"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  disabled={!applyLocation}
                />
              </div>
              <div>
                <Label htmlFor="batch-lng">Longitud</Label>
                <Input
                  id="batch-lng"
                  type="number"
                  step="any"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  disabled={!applyLocation}
                />
              </div>
            </div>
          </div>

          {/* Dates */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="apply-dates"
              checked={applyDates}
              onCheckedChange={(v) => setApplyDates(!!v)}
              className="mt-2"
            />
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="batch-start">Fecha inicio</Label>
                <Input
                  id="batch-start"
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  disabled={!applyDates}
                />
              </div>
              <div>
                <Label htmlFor="batch-end">Fecha fin</Label>
                <Input
                  id="batch-end"
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  disabled={!applyDates}
                />
              </div>
            </div>
          </div>

          {/* Exclusion */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="apply-excluded"
              checked={applyExcluded}
              onCheckedChange={(v) => setApplyExcluded(!!v)}
              className="mt-2"
            />
            <div className="flex-1">
              <Label htmlFor="batch-excluded">Excluir</Label>
              <Select
                value={excludedValue}
                onValueChange={setExcludedValue}
                disabled={!applyExcluded}
              >
                <SelectTrigger id="batch-excluded">
                  <SelectValue placeholder="No cambiar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Excluir</SelectItem>
                  <SelectItem value="false">Incluir</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* QA Notes */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="apply-qa-notes"
              checked={applyQaNotes}
              onCheckedChange={(v) => setApplyQaNotes(!!v)}
              className="mt-2"
            />
            <div className="flex-1">
              <Label htmlFor="batch-qa-notes">Notas QA</Label>
              <Textarea
                id="batch-qa-notes"
                value={qaNotes}
                onChange={(e) => setQaNotes(e.target.value)}
                disabled={!applyQaNotes}
                placeholder="Notas de calidad"
                rows={2}
                maxLength={2000}
              />
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            )}
            Aplicar Cambios
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
