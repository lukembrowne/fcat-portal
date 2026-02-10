"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Suspense } from "react";

const TABS = [
  { label: "Flujo de Caja", href: "/finance/cashflow" },
  { label: "Ingresos", href: "/finance/revenue" },
  { label: "Gastos", href: "/finance/expenses" },
  { label: "Sueldos", href: "/finance/sueldos" },
  { label: "Presupuesto", href: "/finance/budget" },
  { label: "Comparación Anual", href: "/finance/annual" },
  { label: "Cargar Datos", href: "/finance/data" },
] as const;

function FinanceTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();
  const qsSuffix = qs ? `?${qs}` : "";

  return (
    <nav className="border-b bg-background">
      <div className="flex overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={`${tab.href}${qsSuffix}`}
              className={cn(
                "whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0">
      <Suspense>
        <FinanceTabNav />
      </Suspense>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}
