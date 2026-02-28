"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { queueProcessing } from "../../actions";

export function PreviewProcessButton({
  deploymentId,
}: {
  deploymentId: number;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleProcess = () => {
    startTransition(async () => {
      const result = await queueProcessing([deploymentId]);
      if (result.success) {
        window.dispatchEvent(new Event("job-started"));
        router.refresh();
      }
    });
  };

  return (
    <Button onClick={handleProcess} disabled={isPending}>
      {isPending ? "Iniciando..." : "Procesar"}
    </Button>
  );
}
