"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { deleteJob, getJobDeleteStats } from "./actions";

interface DeleteJobDialogProps {
  jobId: number | null;
  onClose: () => void;
  onDeleted: (jobId: number) => void;
}

export function DeleteJobDialog({ jobId, onClose, onDeleted }: DeleteJobDialogProps) {
  const [stats, setStats] = useState<{ detectionsCount: number; verifiedCount: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!jobId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    getJobDeleteStats(jobId).then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => { cancelled = true; };
  }, [jobId]);

  const handleDelete = async () => {
    if (!jobId) return;
    setDeleting(true);
    const result = await deleteJob(jobId);
    setDeleting(false);
    if (result.success) {
      onDeleted(jobId);
      onClose();
    } else {
      alert(result.error);
    }
  };

  return (
    <Dialog open={!!jobId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Eliminar trabajo #{jobId}?</DialogTitle>
          <DialogDescription>
            {stats ? (
              <>
                Se eliminarán{" "}
                <strong>{stats.detectionsCount} detecciones</strong> y sus
                identificaciones
                {stats.verifiedCount > 0 && (
                  <>
                    {" "}
                    (<strong>{stats.verifiedCount} verificadas</strong>)
                  </>
                )}
                . Las imágenes se conservarán pero perderán sus resultados.
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Cargando información...
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-destructive font-medium">
          Esta acción no se puede deshacer.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting || !stats}
          >
            {deleting ? "Eliminando..." : "Eliminar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
