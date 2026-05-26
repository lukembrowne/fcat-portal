"use client";

import { useRouter } from "next/navigation";
import { DeploymentActionsMenu } from "../deployment-actions-menu";

interface DeploymentDetailActionsProps {
  deploymentId: number;
  deploymentName: string;
  status: string;
  isProcessing: boolean;
  totalDetections: number;
  revertibleImageCount: number;
  pendingImageCount: number;
  pendingVideoCount: number;
  totalImages: number;
  hasImages: boolean;
  hasVideos: boolean;
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
  isProcessing,
  totalDetections,
  revertibleImageCount,
  pendingImageCount,
  pendingVideoCount,
  totalImages,
  hasImages,
  hasVideos,
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
      isProcessing={isProcessing}
      totalDetections={totalDetections}
      totalImages={totalImages}
      hasImages={hasImages}
      hasVideos={hasVideos}
      hasResults={hasResults}
      driveFolderId={driveFolderId}
      lastCompletedJobId={lastCompletedJobId}
      revertibleImageCount={revertibleImageCount}
      pendingImageCount={pendingImageCount}
      pendingVideoCount={pendingVideoCount}
      canEdit={canEdit}
      isAdmin={isAdmin}
      onDeleted={() => router.push("/camera-trap")}
    />
  );
}
