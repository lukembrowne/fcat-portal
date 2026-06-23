"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { label: "Grants", href: "/grants" },
  { label: "Funders", href: "/grants/funders" },
  { label: "Analytics", href: "/grants/analytics" },
] as const;

function activeHref(pathname: string): string {
  if (pathname.startsWith("/grants/funders")) return "/grants/funders";
  if (pathname.startsWith("/grants/analytics")) return "/grants/analytics";
  return "/grants";
}

/** Horizontal section switcher so Grants / Funders / Analytics read as three peers. */
export function GrantsNav() {
  const pathname = usePathname();
  const active = activeHref(pathname);

  return (
    <nav className="flex gap-1 border-b">
      {SECTIONS.map((s) => {
        const isActive = active === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted"
            }`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
