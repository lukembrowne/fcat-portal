"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type NameDisplay = "common" | "spanish" | "scientific";
export const DISPLAY_KEY = "species-name-display";
const CHANGE_EVENT = "species-name-display-change";

export const DISPLAY_LABELS: Record<NameDisplay, string> = {
  common: "Inglés",
  spanish: "Español",
  scientific: "Científico",
};

export function getStoredDisplay(): NameDisplay {
  if (typeof window === "undefined") return "common";
  const stored = localStorage.getItem(DISPLAY_KEY);
  if (stored === "common" || stored === "spanish" || stored === "scientific") return stored;
  return "common";
}

function subscribe(callback: () => void): () => void {
  const handleStorage = (e: StorageEvent) => {
    if (e.key === DISPLAY_KEY) callback();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

const getServerSnapshot = (): NameDisplay => "common";

/**
 * Hook returning the user's name-display preference plus a cycle handler.
 * Synced across components in the same tab via a custom event, and across
 * tabs via the native `storage` event.
 */
export function useNameDisplay(): [NameDisplay, () => void] {
  const nameDisplay = useSyncExternalStore(subscribe, getStoredDisplay, getServerSnapshot);

  const cycle = useCallback(() => {
    const order: NameDisplay[] = ["common", "spanish", "scientific"];
    const current = getStoredDisplay();
    const next = order[(order.indexOf(current) + 1) % order.length];
    localStorage.setItem(DISPLAY_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [nameDisplay, cycle];
}

export interface SpeciesNameInfo {
  scientificName: string;
  commonName: string | null;
  spanishName: string | null;
}

export function getDisplayName(
  scientificName: string,
  info: SpeciesNameInfo | undefined,
  mode: NameDisplay,
): string {
  if (!info) return scientificName;
  switch (mode) {
    case "common":
      return info.commonName || scientificName;
    case "spanish":
      return info.spanishName || info.commonName || scientificName;
    case "scientific":
      return scientificName;
  }
}

interface SpeciesDisplayContextValue {
  nameDisplay: NameDisplay;
  cycle: () => void;
  getName: (scientificName: string) => string;
}

const SpeciesDisplayContext = createContext<SpeciesDisplayContextValue | null>(null);

/**
 * Provides a `getName(scientificName)` resolver and the current name-display
 * mode to descendants. Wrap any subtree that renders species labels (filter
 * sidebar, image grid badges, etc.) so they update together.
 */
export function SpeciesDisplayProvider({
  speciesInfo,
  children,
}: {
  speciesInfo: SpeciesNameInfo[];
  children: ReactNode;
}) {
  const [nameDisplay, cycle] = useNameDisplay();
  const map = useMemo(() => {
    const m = new Map<string, SpeciesNameInfo>();
    for (const sp of speciesInfo) m.set(sp.scientificName, sp);
    return m;
  }, [speciesInfo]);
  const getName = useCallback(
    (scientificName: string) => getDisplayName(scientificName, map.get(scientificName), nameDisplay),
    [map, nameDisplay],
  );
  const value = useMemo(
    () => ({ nameDisplay, cycle, getName }),
    [nameDisplay, cycle, getName],
  );
  return (
    <SpeciesDisplayContext.Provider value={value}>{children}</SpeciesDisplayContext.Provider>
  );
}

/** Returns the display context, or null when used outside a provider. */
export function useSpeciesDisplay(): SpeciesDisplayContextValue | null {
  return useContext(SpeciesDisplayContext);
}
