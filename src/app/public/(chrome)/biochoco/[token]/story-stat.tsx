"use client";

import { useEffect, useRef, useState } from "react";

interface StoryStatProps {
  speciesCount: number;
  days: number;
}

/**
 * Pure copy builder for the count-up stat block. Kept exported so the
 * singular/plural and days===0 rules stay unit-testable without rendering.
 */
export function buildStoryStatText({ speciesCount, days }: StoryStatProps): {
  lead: string;
  unit: string;
  sub: string;
} {
  const unit =
    speciesCount === 1 ? "especie de animal" : "especies de animales";
  const dayClause =
    days > 0
      ? ` a lo largo de ${days} ${days === 1 ? "día" : "días"} de monitoreo`
      : "";
  return {
    lead: "En su bosque encontramos",
    unit,
    sub: `Nuestras cámaras y grabadores registraron esta vida${dayClause}, sin molestar al bosque.`,
  };
}

/**
 * The big species number, revealed with a count-up animation the first time it
 * scrolls into view. Accessibility / robustness rules:
 *  - Initial state is the FINAL number, so SSR, no-JS, `prefers-reduced-motion`,
 *    and browsers without IntersectionObserver all show the real count with no
 *    animation (the animated path resets to 0 and counts up only on view).
 *  - A visually-hidden full sentence carries the number for screen readers.
 */
export function StoryStat({ speciesCount, days }: StoryStatProps) {
  const { lead, unit, sub } = buildStoryStatText({ speciesCount, days });
  const [display, setDisplay] = useState(speciesCount);
  const numRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || typeof IntersectionObserver === "undefined") {
      // No animation: show the final number immediately.
      setDisplay(speciesCount);
      return;
    }

    const el = numRef.current;
    if (!el) return;

    let started = false;
    let raf = 0;
    setDisplay(0);

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !started) {
            started = true;
            io.unobserve(entry.target);
            const duration = 1100;
            let t0: number | null = null;
            const step = (ts: number) => {
              if (t0 == null) t0 = ts;
              const p = Math.min((ts - t0) / duration, 1);
              const eased = 1 - Math.pow(1 - p, 3);
              setDisplay(Math.round(eased * speciesCount));
              if (p < 1) raf = requestAnimationFrame(step);
            };
            raf = requestAnimationFrame(step);
          }
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [speciesCount]);

  return (
    <section className="pb-2 pt-8">
      <p className="font-serif text-lg italic text-muted-foreground">{lead}</p>
      <div
        ref={numRef}
        aria-hidden="true"
        className="mt-1 bg-gradient-to-b from-emerald-500 to-emerald-700 bg-clip-text font-bold leading-[0.9] tracking-tight text-transparent tabular-nums text-[clamp(4rem,22vw,6rem)] dark:from-emerald-300 dark:to-emerald-500"
      >
        {display}
      </div>
      <span className="-mt-1 block font-bold tracking-tight text-foreground text-[clamp(1.375rem,7vw,1.875rem)]">
        {unit}
      </span>
      <p className="mt-3.5 max-w-[34ch] text-[15px] leading-relaxed text-muted-foreground">
        <span className="sr-only">
          {speciesCount} {unit}. {sub}
        </span>
        <span aria-hidden="true">{sub}</span>
      </p>
    </section>
  );
}
