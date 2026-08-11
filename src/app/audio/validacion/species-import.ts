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

export interface ParsedSpeciesRow {
  name: string;
  /** The row's notes cell, or null when the input carries no notes column. */
  notes: string | null;
}

export interface ParsedSpeciesList {
  rows: ParsedSpeciesRow[];
  /** How many rows the input held. */
  totalFound: number;
  /** Spanish refusal when the paste exceeded MAX_PASTE_ROWS; rows is empty. */
  tooLarge: string | null;
  /**
   * Which column the notes were read from, or null when none was found.
   *
   * Surfaced so the preview can say "notes came from column 5" rather than
   * leaving the reader to infer it from a column that silently stayed empty.
   */
  notesColumn: number | null;
}

const HEADER_PATTERN =
  /^(especies?|species|scientific[\s_-]*name|nombre([\s_-]*(cient[ií]fico|com[uú]n))?|taxon|name)$/i;

/**
 * Header cells that mark the notes column.
 *
 * A header is the ONLY way a wide sheet's notes column is located — see
 * `findNotesColumn`. Both languages, because the source spreadsheets are
 * written in English by the taxonomists and in Spanish by the field team.
 */
const NOTES_HEADER_PATTERN =
  /^(notas?|notes?|observaci[oó]n(es)?|comentarios?|remarks?)$/i;

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
 * Split one pasted line into fields.
 *
 * Tab wins outright when the line has one: that is a block copied out of Excel
 * or Sheets, and its cells routinely contain commas ("Not on JF list, range
 * checks out"). Splitting such a line on every delimiter at once — which is
 * what this did before notes existed — cuts a note in half at its first comma.
 * Only a line with no tab at all is treated as comma/semicolon CSV.
 */
function splitFields(line: string): string[] {
  const parts = line.includes("\t") ? line.split("\t") : line.split(/[,;]/);
  return parts.map(stripQuotes);
}

/**
 * Is this the sheet's header row?
 *
 * A notes header anywhere counts, not just a species header in column 1: sheets
 * label their first column all sorts of ways, and a row containing a cell that
 * literally reads "Notas" is a header rather than a species.
 */
function isHeaderRow(fields: string[]): boolean {
  return (
    HEADER_PATTERN.test(fields[0] ?? "") ||
    fields.some((f) => NOTES_HEADER_PATTERN.test(f))
  );
}

/**
 * Locate the notes column.
 *
 * Two rules, and deliberately no third:
 *
 *  - WITH A HEADER — the column headed Notas/Notes/Observaciones, wherever it
 *    sits. The taxonomists' sheet is `Species | Common Name | Detections |
 *    Sites | Notes`, so "the second column" would import common names.
 *  - WITHOUT A HEADER — column 2, and only when the input is exactly two
 *    columns wide. Any wider and there is nothing to distinguish notes from
 *    counts, common names or whatever else was selected, so nothing is read.
 *    Guessing at column semantics is how importers become unpredictable.
 *
 * A numeric cell never becomes a note (see `parseSpeciesGrid`), which is what
 * keeps the common two-column `Name<TAB>500` paste from importing its counts.
 */
function findNotesColumn(header: string[] | null, body: string[][]): number | null {
  if (header) {
    const index = header.findIndex((cell) => NOTES_HEADER_PATTERN.test(cell));
    return index === -1 ? null : index;
  }
  const width = body.reduce((max, fields) => Math.max(max, fields.length), 0);
  return width === 2 ? 1 : null;
}

function capped(
  rows: ParsedSpeciesRow[],
  notesColumn: number | null
): ParsedSpeciesList {
  const totalFound = rows.length;
  if (totalFound > MAX_PASTE_ROWS) {
    return {
      rows: [],
      totalFound,
      notesColumn: null,
      tooLarge: `La lista tiene ${totalFound} filas. Pega como máximo ${MAX_PASTE_ROWS}: seguramente se copió una hoja entera en vez de la columna de especies.`,
    };
  }
  return { rows, totalFound, notesColumn, tooLarge: null };
}

/**
 * Read a grid of cells as species records.
 *
 * Each row is a record whose FIRST field is the species name — that is what a
 * copied spreadsheet block looks like, and it is why trailing count columns do
 * not become species. Notes come from whichever column `findNotesColumn`
 * identifies, or from nowhere.
 *
 * Takes a grid rather than text so the spreadsheet path never round-trips
 * through a delimiter: an .xlsx cell already knows where it ends, and
 * flattening it to a line only to split it again is what would truncate a note
 * at its first comma.
 */
export function parseSpeciesGrid(grid: string[][]): ParsedSpeciesList {
  const cleaned = grid
    .map((fields) => fields.map((f) => stripQuotes(String(f ?? ""))))
    .filter((fields) => fields.some((f) => f.length > 0));

  const hasHeader = cleaned.length > 1 && isHeaderRow(cleaned[0]);
  const header = hasHeader ? cleaned[0] : null;
  const body = hasHeader ? cleaned.slice(1) : cleaned;

  const notesColumn = findNotesColumn(header, body);

  const rows = body
    .map((fields) => {
      const note = notesColumn == null ? "" : (fields[notesColumn] ?? "");
      return {
        name: fields[0] ?? "",
        // A number is a count, a year or a site tally that happened to land in
        // the notes position — never a note.
        notes: note && !isNumeric(note) ? note : null,
      };
    })
    .filter((row) => row.name.length > 0);

  return capped(rows, notesColumn);
}

/**
 * Split pasted text into species records.
 *
 * Two shapes, distinguished by row count:
 *
 *  - MULTIPLE ROWS — a grid; see `parseSpeciesGrid`.
 *  - ONE ROW — the fields are a list of names, with no notes. Purely numeric
 *    fields are dropped, so a single CSV record (`Name,500`) does not import
 *    its count. A lone line cannot carry a notes column: there is no header to
 *    read and no second row to establish that the fields are columns.
 */
export function parseSpeciesList(text: string): ParsedSpeciesList {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return capped([], null);

  if (lines.length === 1) {
    const rows = splitFields(lines[0])
      .filter((value) => value.length > 0 && !isNumeric(value))
      .map((name) => ({ name, notes: null }));
    return capped(rows, null);
  }

  return parseSpeciesGrid(lines.map(splitFields));
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
  /** The row's notes cell, carried through to the created species unchanged. */
  notes: string | null;
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
  parsed: ParsedSpeciesRow[],
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

  return parsed.map(({ name: input, notes }) => {
    const matches = byName.get(normalizeSpeciesName(input)) ?? [];

    if (matches.length === 0) {
      return {
        input,
        outcome: "unknown" as const,
        scientificName: null,
        detectionCount: 0,
        notes,
      };
    }
    if (matches.length > 1) {
      return {
        input,
        outcome: "unknown" as const,
        scientificName: null,
        detectionCount: 0,
        notes,
        candidates: matches.map((m) => m.scientificName),
      };
    }

    const sp = matches[0];
    const base = {
      input,
      scientificName: sp.scientificName,
      detectionCount: sp.detectionCount,
      notes,
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
