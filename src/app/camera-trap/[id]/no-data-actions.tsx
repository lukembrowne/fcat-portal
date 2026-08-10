"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ImageOff, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { markNoData, undoNoData } from "../actions";

export function MarkNoDataButton({ deploymentId }: { deploymentId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(async () => {
      const result = await markNoData(deploymentId);
      if (result.success) {
        toast.success("Instalación marcada sin datos");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={pending}>
      <ImageOff className="h-4 w-4 mr-1.5" />
      {pending ? "Marcando..." : "Marcar sin datos"}
    </Button>
  );
}

export function UndoNoDataButton({ deploymentId }: { deploymentId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(async () => {
      const result = await undoNoData(deploymentId);
      if (result.success) {
        toast.success("Instalación reabierta para procesar");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={pending}>
      <Undo2 className="h-4 w-4 mr-1.5" />
      {pending ? "Deshaciendo..." : "Deshacer — marcar por procesar"}
    </Button>
  );
}
