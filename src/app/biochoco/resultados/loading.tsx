import { Skeleton } from "@/components/ui/skeleton";

export default function ResultadosLoading() {
  return (
    <div className="space-y-6 min-w-0">
      <div>
        <Skeleton className="h-8 w-32 mb-2" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="flex gap-2 border-b pb-1">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-[500px] w-full rounded-xl" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
