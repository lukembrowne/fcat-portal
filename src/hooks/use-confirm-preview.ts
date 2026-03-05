import { useState, useEffect } from "react";
import type { ActionResult } from "@/lib/types";

/**
 * Fetches preview data when a trigger ID becomes non-null.
 * Resets to null when trigger becomes null (dialog closes).
 *
 * Handles both ActionResult<T> and plain T returns from the fetch function.
 */
export function useConfirmPreview<T>(
  triggerId: number | null,
  fetchFn: (id: number) => Promise<ActionResult<T>>,
): T | null;
export function useConfirmPreview<T>(
  triggerId: number | null,
  fetchFn: (id: number) => Promise<T>,
  opts: { raw: true },
): T | null;
export function useConfirmPreview<T>(
  triggerId: number | null,
  fetchFn: (id: number) => Promise<ActionResult<T> | T>,
  opts?: { raw: boolean },
): T | null {
  const [preview, setPreview] = useState<T | null>(null);

  useEffect(() => {
    if (!triggerId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    fetchFn(triggerId).then((result) => {
      if (cancelled) return;
      if (opts?.raw) {
        setPreview(result as T);
      } else {
        const ar = result as ActionResult<T>;
        if (ar.success) setPreview(ar.data);
      }
    });
    return () => { cancelled = true; };
  }, [triggerId, fetchFn, opts?.raw]);

  return preview;
}
