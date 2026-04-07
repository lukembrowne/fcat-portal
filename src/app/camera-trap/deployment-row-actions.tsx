"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Play, Loader2, Eye, ChevronRight } from "lucide-react";
import type { DeploymentRow } from "./actions";
import { DeploymentActionsMenu } from "./deployment-actions-menu";
import { ProcessConfirmDialog } from "./process-confirm-dialog";

interface DeploymentRowActionsProps {
  deployment: DeploymentRow;
  canEdit: boolean;
  isAdmin: boolean;
}

export function DeploymentRowActions({
  deployment,
  canEdit,
  isAdmin,
}: DeploymentRowActionsProps) {
  const router = useRouter();
  const [quickProcessIds, setQuickProcessIds] = useState<number[] | null>(null);

  const isProcessing = deployment.status === "processing";
  const hasImages = (deployment.totalImages ?? 0) > 0;
  const hasVideos = (deployment.totalVideos ?? 0) > 0;
  const hasResults = !!deployment.lastCompletedJobId;

  return (
    <div
      className="flex items-center justify-end gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Primary action — fixed-width slot so rows align vertically. */}
      <div className="w-[108px] flex justify-end">
        {isProcessing ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Procesando…
          </span>
        ) : hasResults ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs font-medium"
            asChild
          >
            <Link href={`/camera-trap/results/${deployment.lastCompletedJobId}`}>
              <Eye className="h-3.5 w-3.5 mr-1" />
              Resultados
            </Link>
          </Button>
        ) : canEdit && (hasImages || hasVideos) ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs font-medium border-green-600/40 text-green-700 hover:bg-green-50 hover:text-green-800 hover:border-green-600 dark:text-green-400 dark:hover:bg-green-950"
            onClick={() => setQuickProcessIds([deployment.id])}
          >
            <Play className="h-3.5 w-3.5 mr-1 fill-current" />
            Procesar
          </Button>
        ) : null}
      </div>

      {/* Overflow menu — muted at rest, full opacity on row hover / focus / open. */}
      <div className="opacity-50 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
        <DeploymentActionsMenu
          deploymentId={deployment.id}
          deploymentName={deployment.name}
          status={deployment.status}
          totalDetections={deployment.totalDetections ?? 0}
          totalImages={deployment.totalImages ?? 0}
          hasImages={hasImages}
          hasVideos={hasVideos}
          hasResults={hasResults}
          driveFolderId={deployment.driveFolderId}
          lastCompletedJobId={deployment.lastCompletedJobId}
          revertibleImageCount={deployment.revertibleImageCount ?? 0}
          pendingImageCount={deployment.pendingImageCount ?? 0}
          pendingVideoCount={deployment.pendingVideoCount ?? 0}
          canEdit={canEdit}
          isAdmin={isAdmin}
          showDetailsLink
          compact
        />
      </div>

      {/* Subtle chevron affordance — the row itself is clickable. */}
      <ChevronRight
        className="h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-hover/row:text-muted-foreground"
        aria-hidden
      />

      {/* Dialog for the green quick-action button. The shared menu has its
          own ProcessConfirmDialog instance for the menu item path. */}
      <ProcessConfirmDialog
        deploymentIds={quickProcessIds}
        isAdmin={isAdmin}
        hasImages={hasImages}
        hasVideos={hasVideos}
        onClose={() => setQuickProcessIds(null)}
        onStarted={() => {
          window.dispatchEvent(new Event("job-started"));
          router.refresh();
        }}
      />
    </div>
  );
}
