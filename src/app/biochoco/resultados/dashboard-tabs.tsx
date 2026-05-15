import Link from "next/link";
import { cn } from "@/lib/utils";

export type DashboardView = "sitio" | "habitat";

const TABS: ReadonlyArray<{ key: DashboardView; label: string }> = [
  { key: "sitio", label: "Por sitio" },
  { key: "habitat", label: "Por hábitat" },
];

/**
 * URL-driven tab triggers. The default view is "sitio" (no `?view` written),
 * matching today's bookmarks. Only `?view=habitat` is serialized so existing
 * links keep working.
 */
export function DashboardTabs({ active }: { active: DashboardView }) {
  return (
    <div
      role="tablist"
      aria-label="Vistas de resultados"
      className="flex items-center gap-1 border-b"
    >
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        const href =
          tab.key === "sitio" ? "/biochoco/resultados" : "/biochoco/resultados?view=habitat";
        return (
          <Link
            key={tab.key}
            href={href}
            role="tab"
            aria-selected={isActive}
            scroll={false}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
