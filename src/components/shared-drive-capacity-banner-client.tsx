"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";

const DISMISS_KEY = "sd-capacity-banner-dismissed";
const CHANGE_EVENT = "sd-capacity-banner-change";

function subscribe(callback: () => void) {
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

function readDismissedSignature(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Client wrapper for the Shared Drive capacity banner — handles per-session
 * dismissal. Dismissal is keyed by a `signature` of the current alert state, so
 * the banner reappears (even after dismissal) if the situation gets worse.
 * Reads sessionStorage via useSyncExternalStore to stay hydration-safe.
 */
export function CapacityBannerClient({
  critical,
  message,
  trashHint,
  signature,
}: {
  critical: boolean;
  message: string;
  trashHint: boolean;
  signature: string;
}) {
  const dismissedSignature = useSyncExternalStore(
    subscribe,
    readDismissedSignature,
    () => null, // server snapshot: never dismissed during SSR
  );

  if (dismissedSignature === signature) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, signature);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  const tone = critical
    ? "border-red-300 bg-red-50 text-red-900"
    : "border-amber-300 bg-amber-50 text-amber-900";

  return (
    <div
      className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${tone}`}
      role="alert"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">
          {critical
            ? "Shared Drive cerca del límite de Google"
            : "Capacidad de Shared Drive"}
        </span>{" "}
        <span className="text-current/90">{message}.</span>{" "}
        {trashHint && (
          <span className="text-current/80">
            Vaciar la papelera puede recuperar espacio.{" "}
          </span>
        )}
        <Link
          href="/admin/shared-drives"
          className="font-medium underline underline-offset-2 hover:opacity-80"
        >
          Ver Shared Drives →
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Descartar"
        className="shrink-0 rounded p-1 hover:bg-black/5"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
