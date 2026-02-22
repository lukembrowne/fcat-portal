import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />

      {/* Filter bar */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>

      {/* Charts */}
      <Skeleton className="h-[350px] rounded-xl" />

      {/* Table */}
      <Skeleton className="h-[400px] rounded-xl" />
    </div>
  );
}
