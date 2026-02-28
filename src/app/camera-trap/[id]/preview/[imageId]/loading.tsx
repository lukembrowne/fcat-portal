import { Skeleton } from "@/components/ui/skeleton";

export default function ImagePreviewLoading() {
  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <Skeleton className="h-4 w-80 mb-4" />

      {/* Header with navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <Skeleton className="h-4 w-40 mb-1" />
          <Skeleton className="h-7 w-56" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>

      {/* Full-size image */}
      <Skeleton className="aspect-[4/3] rounded-lg" />
    </div>
  );
}
