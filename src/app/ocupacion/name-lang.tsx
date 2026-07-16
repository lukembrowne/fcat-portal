"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { ReadinessSpeciesRow } from "@/lib/occupancy/readiness";

/**
 * Which common-name language the occupancy tables display. Scientific name is
 * always its own column, so this only toggles the "Nombre común" column between
 * Spanish and English. Shared via context so a single control at the top of
 * `/ocupacion` drives both the camera and audio tables at once.
 */
export type NameLang = "es" | "en";

const NameLangContext = createContext<NameLang>("es");

export function useNameLang(): NameLang {
  return useContext(NameLangContext);
}

/**
 * Resolve the displayed common name for a row in the chosen language, always
 * falling back to something readable: Spanish → English → scientific string;
 * English → scientific string. (Spanish names are sparser than English on the
 * BirdNET-seeded rows, so Spanish falls through to English before scientific.)
 */
export function displayCommonName(
  r: Pick<ReadinessSpeciesRow, "species" | "commonName" | "spanishName">,
  lang: NameLang,
): string {
  if (lang === "en") return r.commonName || r.species;
  return r.spanishName || r.commonName || r.species;
}

/** Two-state segmented control: Español ↔ English. */
function Segmented({
  value,
  onChange,
}: {
  value: NameLang;
  onChange: (v: NameLang) => void;
}) {
  const opts: { key: NameLang; label: string }[] = [
    { key: "es", label: "Español" },
    { key: "en", label: "English" },
  ];
  return (
    <div className="inline-flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Nombre común:</span>
      <div className="inline-flex rounded-md border p-0.5">
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={value === o.key}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              value === o.key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Client provider that owns the name-language state and renders the toggle. The
 * server-rendered page content passes through as `children`, so wrapping the
 * page in this provider keeps the stream sections server-rendered.
 */
export function NameLangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<NameLang>("es");
  return (
    <NameLangContext.Provider value={lang}>
      <div className="flex justify-end">
        <Segmented value={lang} onChange={setLang} />
      </div>
      {children}
    </NameLangContext.Provider>
  );
}
