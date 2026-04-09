"use client";

import type { ReactNode } from "react";

export interface CompactStat {
  icon?: ReactNode;
  value: string | number;
  label: string;
}

interface CompactStatBarProps {
  stats: CompactStat[];
}

/**
 * Single-row compact stat pills used at the top of biochoco site
 * results pages. Wraps to multiple rows on narrow screens. Replaces the
 * earlier 3-card grid that wasted vertical space and didn't match the
 * compact style of other dashboards in the portal.
 */
export function CompactStatBar({ stats }: CompactStatBarProps) {
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {stats.map((stat, i) => (
        <div
          key={i}
          className="bg-muted rounded-lg px-3 py-1.5 flex items-center gap-2"
        >
          {stat.icon && (
            <span className="text-muted-foreground shrink-0">{stat.icon}</span>
          )}
          <span className="font-semibold">{stat.value}</span>
          <span className="text-xs text-muted-foreground">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}
