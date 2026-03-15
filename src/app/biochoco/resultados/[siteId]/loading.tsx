import { Skeleton } from "@/components/ui/skeleton";

export default function SiteDetailLoading() {
  return (
    <div className="space-y-6 min-w-0">
      <Skeleton className="h-5 w-48" />
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
          <div className="flex gap-4 pt-2">
            <Skeleton className="h-16 w-32" />
            <Skeleton className="h-16 w-32" />
            <Skeleton className="h-16 w-32" />
          </div>
        </div>
        <Skeleton className="h-[200px] w-full lg:w-[300px] rounded-xl" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
