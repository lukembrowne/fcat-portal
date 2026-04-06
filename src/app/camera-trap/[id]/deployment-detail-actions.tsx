"use client";

import { useRouter } from "next/navigation";
import { DeploymentActionsMenu } from "../deployment-actions-menu";

interface DeploymentDetailActionsProps {
  deploymentId: number;
  deploymentName: string;
  status: string;
  totalDetections: number;
  revertibleImageCount: number;
  totalImages: number;
  hasImages: boolean;
  hasResults: boolean;
  driveFolderId: string | null;
  canEdit: boolean;
  isAdmin: boolean;
  lastCompletedJobId: number | null;
}

export function DeploymentDetailActions({
  deploymentId,
  deploymentName,
  status,
  totalDetections,
  revertibleImageCount,
  totalImages,
  hasImages,
  hasResults,
  driveFolderId,
  canEdit,
  isAdmin,
  lastCompletedJobId,
}: DeploymentDetailActionsProps) {
  const router = useRouter();

  return (
    <DeploymentActionsMenu
      deploymentId={deploymentId}
      deploymentName={deploymentName}
      status={status}
      totalDetections={totalDetections}
      totalImages={totalImages}
      hasImages={hasImages}
      hasResults={hasResults}
      driveFolderId={driveFolderId}
      lastCompletedJobId={lastCompletedJobId}
      revertibleImageCount={revertibleImageCount}
      canEdit={canEdit}
      isAdmin={isAdmin}
      onDeleted={() => router.push("/camera-trap")}
    />
  );
}
