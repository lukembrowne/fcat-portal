import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for /audio/validacion and the species pages under it, so a click
 * responds at once while the species table's counts load.
 */
export default function ValidationLoading() {
  return (
    <div className="mx-auto max-w-[104rem] space-y-4 p-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-full max-w-xs" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>

      <div className="rounded-md border">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-4 w-full max-w-3xl" />
        </div>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            <Skeleton className="h-4 w-48 shrink-0" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-5 w-16 rounded-full sm:block" />
            <Skeleton className="hidden h-4 w-24 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
