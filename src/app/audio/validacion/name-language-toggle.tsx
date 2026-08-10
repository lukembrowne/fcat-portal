"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";

import {
  NAME_LANG_COOKIE,
  otherLangLabel,
  type NameLang,
} from "./name-language";

/**
 * Switch common names between Spanish and English.
 *
 * Writes the cookie client-side and refreshes so the server re-renders with the
 * other language. A server action would work too but costs a round-trip before
 * the refresh, and there is nothing to validate — the server treats any
 * unrecognised value as Spanish.
 */
export function NameLanguageToggle({ current }: { current: NameLang }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const swap = () => {
    const next: NameLang = current === "es" ? "en" : "es";
    // One year, site-wide path so the choice survives navigation within the
    // module. `SameSite=Lax` keeps it off cross-site requests.
    document.cookie = `${NAME_LANG_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
    startTransition(() => router.refresh());
  };

  return (
    <button
      type="button"
      onClick={swap}
      disabled={pending}
      title="Cambiar el idioma de los nombres comunes"
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
    >
      <Languages className="h-3 w-3" />
      {otherLangLabel(current)}
    </button>
  );
}
