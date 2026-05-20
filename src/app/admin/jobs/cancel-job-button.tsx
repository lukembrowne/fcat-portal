"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cancelJobById } from "./actions";

export function CancelJobButton({
  jobId,
  size = "sm",
}: {
  jobId: number;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handle = () => {
    if (!confirm("¿Cancelar este trabajo?")) return;
    startTransition(async () => {
      const result = await cancelJobById(jobId);
      if (!result.success) {
        alert(result.error);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <Button
      variant="ghost"
      size={size}
      onClick={handle}
      disabled={isPending}
      className="text-destructive hover:text-destructive"
    >
      {isPending ? "Cancelando..." : "Cancelar"}
    </Button>
  );
}
