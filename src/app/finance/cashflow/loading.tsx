import { Skeleton } from "@/components/ui/skeleton";

export default function CashflowLoading() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Flujo de Caja</h1>

      {/* Metrics row */}
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-lg" />
        <Skeleton className="h-80 rounded-lg" />
      </div>

      {/* Projections table */}
      <Skeleton className="h-64 rounded-lg" />

      {/* Balance table */}
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
