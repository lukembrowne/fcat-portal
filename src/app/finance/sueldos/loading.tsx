import { Skeleton } from "@/components/ui/skeleton";

export default function SueldosLoading() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Sueldos</h1>

      {/* Metrics + filter row */}
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
      </div>

      {/* Person panels */}
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-96 rounded-lg" />
      ))}
    </div>
  );
}
