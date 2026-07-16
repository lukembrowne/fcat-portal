"use client";

import type { Lang } from "./lib/snapshot-types";
import { CONTENT } from "./content";

/**
 * Controlled EN/ES toggle. Shows the label of the language it switches TO,
 * so the button reads as the action ("Español" while viewing English).
 */
export function LanguageToggle({
  lang,
  onToggle,
}: {
  lang: Lang;
  onToggle: (next: Lang) => void;
}) {
  const next: Lang = lang === "en" ? "es" : "en";
  return (
    <button
      type="button"
      onClick={() => onToggle(next)}
      aria-label={`Switch language to ${CONTENT[next].ui.toLanguage}`}
      className="abtn"
    >
      {CONTENT[lang].ui.toLanguage}
    </button>
  );
}
