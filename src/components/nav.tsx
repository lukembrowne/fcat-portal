/**
 * Navigation — Async Server Component
 *
 * Permission-filtered links, Spanish labels. No 'use client'.
 */

import Link from "next/link";
import { UserBadge } from "@/components/user-badge";
import type { AuthUser } from "@/lib/types";

interface NavProps {
  user: AuthUser;
}

function hasProjectAccess(user: AuthUser, projectId: string): boolean {
  if (user.globalRole === "super_admin") return true;
  return user.permissions.some((p) => p.projectId === projectId);
}

export function Nav({ user }: NavProps) {
  const navItems: { href: string; label: string; show: boolean }[] = [
    { href: "/", label: "Inicio", show: true },
    {
      href: "/camera-trap",
      label: "Cámaras Trampa",
      show: hasProjectAccess(user, "camera-trap"),
    },
    {
      href: "/giz",
      label: "GIZ",
      show: hasProjectAccess(user, "giz"),
    },
    {
      href: "/biochoco",
      label: "BioChocó",
      show: hasProjectAccess(user, "biochoco"),
    },
    {
      href: "/admin",
      label: "Administración",
      show: user.globalRole === "super_admin",
    },
  ];

  const visibleItems = navItems.filter((item) => item.show);

  return (
    <nav className="border-b bg-primary text-primary-foreground">
      <div className="container mx-auto px-4">
        <div className="flex h-14 items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold text-sm"
          >
            Portal FCAT
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-1">
            {visibleItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3 py-2 text-sm font-medium text-primary-foreground/70 hover:text-primary-foreground transition-colors rounded-md hover:bg-primary-foreground/10"
              >
                {item.label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-4">
            <UserBadge user={user} />
            {/* Mobile menu */}
            <div className="md:hidden">
              <MobileMenu items={visibleItems} />
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}

function MobileMenu({
  items,
}: {
  items: { href: string; label: string }[];
}) {
  return (
    <details className="relative">
      <summary className="cursor-pointer px-2 py-1 text-sm font-medium text-primary-foreground/70 hover:text-primary-foreground list-none">
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
          />
        </svg>
      </summary>
      <div className="absolute right-0 top-full mt-1 w-48 rounded-md border bg-popover p-1 shadow-lg z-50">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="block px-3 py-2 text-sm text-popover-foreground hover:bg-accent rounded-sm"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </details>
  );
}
