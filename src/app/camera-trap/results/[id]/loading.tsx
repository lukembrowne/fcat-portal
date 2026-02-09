import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ResultsLoading() {
  return (
    <div className="max-w-7xl mx-auto">
      <Skeleton className="h-4 w-48 mb-2" />
      <Skeleton className="h-9 w-72 mb-2" />
      <Skeleton className="h-5 w-96 mb-8" />

      <div className="grid gap-4 md:grid-cols-5 mb-8">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <Skeleton className="h-4 w-20 mb-2" />
              <Skeleton className="h-9 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <Card>
          <CardContent className="pt-6 space-y-4">
            <Skeleton className="h-4 w-16" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
