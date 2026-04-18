import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

type SortDirection = false | "asc" | "desc" | null | undefined;

export function SortIcon({ direction }: { direction: SortDirection }) {
  if (direction === "asc") return <ArrowUp className="h-3.5 w-3.5" />;
  if (direction === "desc") return <ArrowDown className="h-3.5 w-3.5" />;
  return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
}
