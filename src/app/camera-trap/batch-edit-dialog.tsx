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
import { Loader2 } from "lucide-react";
import { bulkUpdateMetadata } from "./actions";

interface BatchEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  distinctProjects: string[];
  onComplete: () => void;
}

export function BatchEditDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  distinctProjects,
  onComplete,
}: BatchEditDialogProps) {
  const [applyProject, setApplyProject] = useState(false);
  const [applyLocation, setApplyLocation] = useState(false);
  const [applyDates, setApplyDates] = useState(false);
  const [applySite, setApplySite] = useState(false);
  const [ctProject, setCtProject] = useState("");
  const [siteName, setSiteName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    startSaving(async () => {
      setError(null);
      const fields: Record<string, unknown> = {};
      if (applyProject) fields.ctProject = ctProject.trim() || null;
      if (applySite) fields.siteName = siteName.trim() || null;
      if (applyLocation) {
        fields.latitude = latitude ? parseFloat(latitude) : null;
        fields.longitude = longitude ? parseFloat(longitude) : null;
      }
      if (applyDates) {
        fields.dateStart = dateStart || null;
        fields.dateEnd = dateEnd || null;
      }

      if (Object.keys(fields).length === 0) {
        setError("Selecciona al menos un campo para aplicar.");
        return;
      }

      const result = await bulkUpdateMetadata(selectedIds, fields);
      if (result.success) {
        onOpenChange(false);
        onComplete();
        // Reset form
        setApplyProject(false);
        setApplyLocation(false);
        setApplyDates(false);
        setApplySite(false);
        setCtProject("");
        setSiteName("");
        setLatitude("");
        setLongitude("");
        setDateStart("");
        setDateEnd("");
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
              <Input
                id="batch-project"
                value={ctProject}
                onChange={(e) => setCtProject(e.target.value)}
                disabled={!applyProject}
                list="batch-project-options"
                placeholder="Ej: BioChoco"
              />
              <datalist id="batch-project-options">
                {distinctProjects.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
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
