"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import type { DeploymentRow } from "./actions";
import { updateDeploymentMetadata } from "./actions";

interface DeploymentEditFormProps {
  deployment: DeploymentRow;
  distinctProjects: string[];
  onCancel: () => void;
  onSaved: () => void;
}

export function DeploymentEditForm({
  deployment,
  distinctProjects,
  onCancel,
  onSaved,
}: DeploymentEditFormProps) {
  const [name, setName] = useState(deployment.name);
  const [ctProject, setCtProject] = useState(deployment.ctProject ?? "");
  const [siteName, setSiteName] = useState(deployment.siteName ?? "");
  const [latitude, setLatitude] = useState(
    deployment.latitude != null ? String(deployment.latitude) : ""
  );
  const [longitude, setLongitude] = useState(
    deployment.longitude != null ? String(deployment.longitude) : ""
  );
  const [dateStart, setDateStart] = useState(deployment.dateStart ?? "");
  const [dateEnd, setDateEnd] = useState(deployment.dateEnd ?? "");
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startSaving(async () => {
      setError(null);
      const result = await updateDeploymentMetadata(deployment.id, {
        name: name.trim() || deployment.name,
        ctProject: ctProject.trim() || null,
        siteName: siteName.trim() || null,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        dateStart: dateStart || null,
        dateEnd: dateEnd || null,
      });
      if (result.success) {
        onSaved();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="edit-name">Nombre</Label>
        <Input
          id="edit-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <Label htmlFor="edit-project">Proyecto</Label>
        <Input
          id="edit-project"
          value={ctProject}
          onChange={(e) => setCtProject(e.target.value)}
          list="project-options"
          placeholder="Ej: BioChoco"
        />
        <datalist id="project-options">
          {distinctProjects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>

      <div>
        <Label htmlFor="edit-site">Sitio</Label>
        <Input
          id="edit-site"
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
          placeholder="Nombre del sitio de monitoreo"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="edit-lat">Latitud</Label>
          <Input
            id="edit-lat"
            type="number"
            step="any"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
            placeholder="-0.1234"
          />
        </div>
        <div>
          <Label htmlFor="edit-lng">Longitud</Label>
          <Input
            id="edit-lng"
            type="number"
            step="any"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
            placeholder="-79.5678"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="edit-start">Fecha inicio</Label>
          <Input
            id="edit-start"
            type="date"
            value={dateStart}
            onChange={(e) => setDateStart(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="edit-end">Fecha fin</Label>
          <Input
            id="edit-end"
            type="date"
            value={dateEnd}
            onChange={(e) => setDateEnd(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Guardar
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}
