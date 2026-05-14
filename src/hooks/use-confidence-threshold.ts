"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CONFIDENCE_STORAGE_KEY,
  CONFIDENCE_URL_PARAM,
  DEFAULT_CONFIDENCE_THRESHOLD,
  canonicalThreshold,
  formatThreshold,
  parseThresholdParam,
} from "@/lib/audio-confidence";

const URL_DEBOUNCE_MS = 300;

function readInitial(urlValue: string | null): number {
  if (urlValue !== null) {
    return parseThresholdParam(urlValue);
  }
  if (typeof window === "undefined") {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
  try {
    const stored = window.localStorage.getItem(CONFIDENCE_STORAGE_KEY);
    if (stored !== null) return parseThresholdParam(stored);
  } catch {
    // localStorage unavailable (private mode, SSR mismatch) — fall through
  }
  return DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * Resolve the confidence threshold from URL > localStorage > default.
 * `setThreshold` updates the URL (debounced) and writes localStorage.
 *
 * URL hydration alone does NOT write to localStorage — so a shared
 * `?conf=` URL never silently mutates the recipient's preference.
 */
export function useConfidenceThreshold(): readonly [number, (next: number) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get(CONFIDENCE_URL_PARAM);

  const [threshold, setThresholdState] = useState<number>(() => readInitial(urlValue));

  // Sync state with URL when the URL changes from external sources (back/forward,
  // deep links, programmatic nav). We deliberately can't derive `threshold` purely
  // from `urlValue` in render: during a slider drag, local state must win until
  // the debounced URL update lands, or the slider would feel sticky.
  useEffect(() => {
    if (urlValue !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate external→local sync
      setThresholdState(parseThresholdParam(urlValue));
    }
  }, [urlValue]);

  // Hydrate-to-URL on first mount: if the URL has no `conf` param but
  // localStorage holds a non-default value, push that value to the URL.
  // Without this, server-side filtering (which only sees the URL) silently
  // uses the default while the slider visually shows the persisted value —
  // the user thinks they've filtered to 0.95 but the page returns 0.7 data.
  const didSyncFromStorageRef = useRef(false);
  useEffect(() => {
    if (didSyncFromStorageRef.current) return;
    didSyncFromStorageRef.current = true;
    if (urlValue !== null) return;
    if (threshold === DEFAULT_CONFIDENCE_THRESHOLD) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(CONFIDENCE_URL_PARAM, formatThreshold(threshold));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // Run once: depends on first-mount values, not subsequent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setThreshold = useCallback(
    (next: number) => {
      const canonical = canonicalThreshold(next);
      setThresholdState(canonical);

      // User-initiated change → persist to localStorage immediately.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            CONFIDENCE_STORAGE_KEY,
            formatThreshold(canonical)
          );
        } catch {
          // localStorage unavailable; ignore
        }
      }

      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString());
        params.set(CONFIDENCE_URL_PARAM, formatThreshold(canonical));
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }, URL_DEBOUNCE_MS);
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  return [threshold, setThreshold] as const;
}
