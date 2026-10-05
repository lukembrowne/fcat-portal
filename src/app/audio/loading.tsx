import { Skeleton } from "@/components/ui/skeleton";

/**
 * Table-shaped placeholder for /audio, so a click responds at once instead of
 * holding the previous page until the deployment totals arrive.
 *
 * Also the fallback for every route under /audio that has no loading.tsx of its
 * own (/audio/[id], /audio/species), so it carries no page-specific text.
 */
export default function AudioLoading() {
  return (
    <div className="max-w-7xl mx-auto min-w-0">
      <div className="mb-6">
        <Skeleton className="h-9 w-56 mb-2" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      <Skeleton className="mb-4 h-10 w-full rounded-md" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-full max-w-xs" />
      </div>

      <div className="rounded-md border">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            <Skeleton className="h-4 w-32 shrink-0" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-4 w-20 sm:block" />
            <Skeleton className="hidden h-4 w-20 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
