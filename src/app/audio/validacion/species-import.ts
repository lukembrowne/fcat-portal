/**
 * Pure parsing and resolution for the bulk species import.
 *
 * The species list for a validation round arrives as a spreadsheet column, so
 * this accepts the union of what people actually paste: newline-separated,
 * comma- or tab-separated, quoted, with a header, with trailing junk columns.
 *
 * Both functions are pure and database-free so the messy input space can be
 * covered without a fixture database — the same factoring as `binning.ts` and
 * `agreement.ts` elsewhere in this module.
 */

import type { ValidatableSpecies } from "./actions";

/**
 * Species committed per HTTP request.
 *
 * NOT a limit on how many species an import can add — the client walks the
 * whole list in chunks of this size. It bounds one request.
 *
 * The bound is real work, not caution: `commitSpeciesImport` draws each
 * species' full stratified sample, measured at 1.4-2.0 s end to end against the
 * 2.5M-row `audio_identifications` table. Five measured at 8.9 s for a full
 * chunk — the same worst case the previous chunk of ten had when the
 * per-species cost was a 0.2-1.3 s triage draw.
 *
 * There is no per-species tuning available: the draw's cost is dominated by a
 * ~170 ms floor per score bin and is therefore nearly flat in how common the
 * species is (see `sample-core.ts`). Chunk size is the only lever.
 */
export const COMMIT_CHUNK_SIZE = 5;

/**
 * Rows a single paste may contain.
 *
 * A sanity ceiling, not a batch cap: BirdNET has only ever reported ~554
 * distinct labels in this portal, so a paste past this is a whole spreadsheet
 * dropped into the box by accident. Refused with a message rather than trimmed,
 * because a silent trim looks like a successful import of the wrong list.
 */
export const MAX_PASTE_ROWS = 2000;

export interface ParsedSpeciesList {
  names: string[];
  /** How many rows the input held. */
  totalFound: number;
  /** Spanish refusal when the paste exceeded MAX_PASTE_ROWS; names is empty. */
  tooLarge: string | null;
}

const HEADER_PATTERN =
  /^(especies?|species|scientific[\s_-]*name|nombre([\s_-]*(cient[ií]fico|com[uú]n))?|taxon|name)$/i;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

const isNumeric = (value: string) => value !== "" && !Number.isNaN(Number(value));

/**
 * Split pasted text into candidate species names.
 *
 * Two shapes, distinguished by row count:
 *
 *  - MULTIPLE ROWS — each row is a record and only its FIRST field can be a
 *    species name. This is what a copied spreadsheet column looks like once
 *    Excel adds a tab per column and a CRLF per row, and it is why trailing
 *    count columns do not become species.
 *  - ONE ROW — the fields are a list of names. Purely numeric fields are
 *    dropped, so a single CSV record (`Name,500`) does not import its count.
 */
export function parseSpeciesList(text: string): ParsedSpeciesList {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let fields: string[];
  if (lines.length > 1) {
    fields = lines.map((line) => stripQuotes(line.split(/[\t,;]/)[0] ?? ""));
  } else if (lines.length === 1) {
    fields = lines[0]
      .split(/[\t,;]/)
      .map(stripQuotes)
      .filter((value) => !isNumeric(value));
  } else {
    fields = [];
  }

  let names = fields.filter((value) => value.length > 0);

  // A header only makes sense as the first row of a multi-row paste.
  if (names.length > 1 && HEADER_PATTERN.test(names[0])) {
    names = names.slice(1);
  }

  const totalFound = names.length;
  if (totalFound > MAX_PASTE_ROWS) {
    return {
      names: [],
      totalFound,
      tooLarge: `La lista tiene ${totalFound} filas. Pega como máximo ${MAX_PASTE_ROWS}: seguramente se copió una hoja entera en vez de la columna de especies.`,
    };
  }

  return { names, totalFound, tooLarge: null };
}

export type ImportOutcome =
  | "ready"
  | "duplicate"
  | "no_detections"
  | "unknown"
  | "repeated";

export interface ResolvedImportRow {
  /** The text as pasted, so an unmatched row can be corrected by the reader. */
  input: string;
  outcome: ImportOutcome;
  scientificName: string | null;
  detectionCount: number;
  /** Populated when the text matched more than one species. */
  candidates?: string[];
}

/**
 * Canonical form for comparing species names.
 *
 * Shared with the picker's search so "found by typing" and "matched on import"
 * cannot disagree about what counts as the same name. Lowercases, strips
 * diacritics ("buho" matches "Búho") and collapses internal runs of whitespace,
 * which a pasted spreadsheet cell frequently carries.
 */
export function normalizeSpeciesName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify each pasted name against the catalog.
 *
 * Matching is EXACT on a normalised name, not substring: an import runs
 * unattended over dozens of rows, and a substring rule would quietly bind
 * "Tucán" to whichever toucan sorted first.
 *
 * Ambiguity resolves to `unknown` with both candidates named rather than
 * picking one — a silent wrong pick is the failure mode this whole preview
 * step exists to prevent.
 */
export function resolveSpeciesRows(
  rawNames: string[],
  catalog: ValidatableSpecies[]
): ResolvedImportRow[] {
  const byName = new Map<string, ValidatableSpecies[]>();
  const add = (key: string | null, sp: ValidatableSpecies) => {
    if (!key) return;
    const norm = normalizeSpeciesName(key);
    if (!norm) return;
    const list = byName.get(norm) ?? [];
    if (!list.includes(sp)) list.push(sp);
    byName.set(norm, list);
  };
  for (const sp of catalog) {
    add(sp.scientificName, sp);
    add(sp.commonName, sp);
    add(sp.spanishName, sp);
  }

  // Keyed on the resolved species, so the same species reached through two
  // different names still counts as a repeat.
  const seen = new Set<string>();

  return rawNames.map((input) => {
    const matches = byName.get(normalizeSpeciesName(input)) ?? [];

    if (matches.length === 0) {
      return { input, outcome: "unknown", scientificName: null, detectionCount: 0 };
    }
    if (matches.length > 1) {
      return {
        input,
        outcome: "unknown",
        scientificName: null,
        detectionCount: 0,
        candidates: matches.map((m) => m.scientificName),
      };
    }

    const sp = matches[0];
    const base = {
      input,
      scientificName: sp.scientificName,
      detectionCount: sp.detectionCount,
    };

    if (seen.has(sp.scientificName)) {
      return { ...base, outcome: "repeated" as const };
    }
    seen.add(sp.scientificName);

    if (sp.activeStatus != null) return { ...base, outcome: "duplicate" as const };
    if (sp.detectionCount <= 0) return { ...base, outcome: "no_detections" as const };
    return { ...base, outcome: "ready" as const };
  });
}

/** Spanish label per outcome, for the preview table. */
export const OUTCOME_LABEL: Record<ImportOutcome, string> = {
  ready: "Se añadirá",
  duplicate: "Ya en validación",
  no_detections: "Sin detecciones",
  unknown: "No reconocida",
  repeated: "Repetida en la lista",
};
