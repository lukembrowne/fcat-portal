"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Suspense, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DateRangePreset } from "./types";

const TABS = [
  { label: "Flujo de Caja", href: "/finance/cashflow" },
  { label: "Ingresos", href: "/finance/revenue" },
  { label: "Gastos", href: "/finance/expenses" },
  { label: "Sueldos", href: "/finance/sueldos" },
  { label: "Presupuesto", href: "/finance/budget" },
  { label: "Comparación Anual", href: "/finance/annual" },
  { label: "Cargar Datos", href: "/finance/data" },
] as const;

/** Tabs that use the date filter */
const DATE_FILTER_TABS = new Set(["/finance/revenue", "/finance/expenses", "/finance/sueldos"]);

const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: "this-year", label: "Este Año" },
  { value: "last-year", label: "Año Pasado" },
  { value: "this-month", label: "Este Mes" },
  { value: "last-month", label: "Mes Pasado" },
  { value: "custom", label: "Personalizado" },
];

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

function DateFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const showFilter = DATE_FILTER_TABS.has(pathname);
  if (!showFilter) return null;

  const currentRange = (searchParams.get("range") || "this-year") as DateRangePreset;
  const customFrom = searchParams.get("from") || "";
  const customTo = searchParams.get("to") || "";

  const setRange = useCallback(
    (preset: DateRangePreset) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("range", preset);
      if (preset !== "custom") {
        params.delete("from");
        params.delete("to");
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, searchParams, router]
  );

  const setCustomDate = useCallback(
    (key: "from" | "to", value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("range", "custom");
      params.set(key, value);
      // Keep existing other date
      if (key === "from" && !params.get("to")) {
        params.set("to", new Date().toISOString().slice(0, 10));
      }
      if (key === "to" && !params.get("from")) {
        const y = new Date().getFullYear();
        params.set("from", `${y}-01-01`);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, searchParams, router]
  );

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-muted/30">
      <span className="text-sm font-medium text-muted-foreground mr-1">Período:</span>
      {PRESETS.map((p) => (
        <Button
          key={p.value}
          variant={currentRange === p.value ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => setRange(p.value)}
        >
          {p.label}
        </Button>
      ))}
      {currentRange === "custom" && (
        <div className="flex items-center gap-1 ml-2">
          <Input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomDate("from", e.target.value)}
            className="h-7 text-xs w-[130px]"
          />
          <span className="text-xs text-muted-foreground">—</span>
          <Input
            type="date"
            value={customTo}
            onChange={(e) => setCustomDate("to", e.target.value)}
            className="h-7 text-xs w-[130px]"
          />
        </div>
      )}
    </div>
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
      <Suspense>
        <DateFilter />
      </Suspense>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}
