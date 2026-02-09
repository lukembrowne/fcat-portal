"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface SubNavItem {
  href: string;
  label: string;
}

export function SubNav({ items }: { items: SubNavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="border-b mb-6">
      <div className="flex gap-1">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              pathname === item.href
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
