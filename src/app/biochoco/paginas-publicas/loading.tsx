import { Skeleton } from "@/components/ui/skeleton";

export default function PaginasPublicasLoading() {
  return (
    <div className="space-y-6 min-w-0">
      <div>
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="flex gap-2 border-b pb-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
