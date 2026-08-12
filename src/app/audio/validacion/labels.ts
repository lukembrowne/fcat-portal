/**
 * User-facing vocabulary for the threshold validation module.
 *
 * The interface talks about SPECIES and STAGES. The word "campaña" does not
 * appear anywhere a user can read it — it described the implementation (a row
 * in `birdnet_validation_campaigns`) rather than the task, and readers could
 * not tell what one was or what to do with it. Internal identifiers still use
 * the word; only the rendered strings changed.
 *
 * Centralised here rather than inline per component so the wording cannot drift
 * between the species table, the detail page and the stage controls. A unit
 * test asserts both maps are total over `CampaignStatus` and that no string
 * reintroduces the retired word.
 */

import {
  CAMPAIGN_PRIORITIES,
  type CampaignPriority,
  type CampaignStatus,
} from "@/lib/birdnet-validation/types";

/** Short stage name, for table cells and headers. */
export const STAGE_LABEL: Record<CampaignStatus, string> = {
  draft: "Sin muestra",
  sampled: "Lista para revisar",
  reviewing: "En revisión",
  fitted: "Modelo ajustado",
  unusable: "Sin umbral utilizable",
  applied: "Umbral aplicado",
  abandoned: "Descartada",
};

/** One line saying what happens next, so a stage name is never a dead end. */
export const STAGE_HINT: Record<CampaignStatus, string> = {
  draft:
    "No se pudo extraer la muestra al añadir esta especie. Usa \"Extraer muestra\" para reintentarlo.",
  sampled: "La muestra ya está extraída. Empieza a revisar detecciones.",
  reviewing: "Sigue revisando hasta completar la muestra, luego ajusta el modelo.",
  fitted: "Revisa el umbral estimado y aplícalo si es correcto.",
  // Deliberately says nothing about WHICH way the fit failed. The old wording,
  // "BirdNET no acierta en ninguna puntuación para esta especie", is the most
  // common cause but not the only one — and on a species whose every review came
  // back correct it stated the exact opposite of the truth right above a card
  // reporting 100% correctas. The direction lives with the counts that establish
  // it; see `separationCase` on the species page.
  unusable:
    "El ajuste no produjo un umbral. El detalle abajo dice por qué y qué hacer.",
  applied: "El umbral filtra las detecciones de esta especie en todo el portal.",
  abandoned: "Se dejó de validar esta especie.",
};

/**
 * Tailwind tone per stage, for the table's status tag.
 *
 * `unusable` is NEUTRAL, not red, and that is load-bearing. Most species
 * BirdNET reports have no true positives at any score, so "sin umbral
 * utilizable" is the expected result of a correctly-run validation, not a
 * failure. Colouring it as an error would teach every reader the opposite of
 * the thing this module exists to establish. Red belongs to `abandoned`, which
 * is a person deciding to stop.
 *
 * `draft` is amber for the opposite reason: it is now reachable only when a
 * species' draw failed, so it is the one stage that always wants attention.
 */
export const STAGE_TONE: Record<CampaignStatus, string> = {
  draft: "border-amber-300 bg-amber-100 text-amber-900",
  sampled: "border-sky-300 bg-sky-100 text-sky-900",
  reviewing: "border-blue-300 bg-blue-100 text-blue-900",
  fitted: "border-violet-300 bg-violet-100 text-violet-900",
  unusable: "border-stone-300 bg-stone-100 text-stone-700",
  applied: "border-emerald-300 bg-emerald-100 text-emerald-900",
  abandoned: "border-rose-300 bg-rose-100 text-rose-900",
};

export function stageLabel(status: string): string {
  return STAGE_LABEL[status as CampaignStatus] ?? status;
}

/**
 * Fallback for a status the schema gained but this file has not.
 *
 * Deliberately its own constant rather than reusing `STAGE_TONE.draft`: draft
 * is amber because it means a draw failed, and an unrecognised status is not
 * known to be a problem — it should render as a plain pill, not an alarm.
 */
const UNKNOWN_TONE = "border-slate-300 bg-slate-100 text-slate-700";

export function stageTone(status: string): string {
  return STAGE_TONE[status as CampaignStatus] ?? UNKNOWN_TONE;
}

/**
 * Options for the stage filter, in lifecycle order.
 *
 * `activas` is the default view rather than `todas`: a discarded species stays
 * in the table forever, and once a few rounds have been run the list is mostly
 * ones nobody is working on.
 */
export const STAGE_FILTERS = [
  { value: "activas", label: "En curso" },
  { value: "todas", label: "Todas" },
  ...(
    [
      "draft",
      "sampled",
      "reviewing",
      "fitted",
      "unusable",
      "applied",
      "abandoned",
    ] as CampaignStatus[]
  ).map((status) => ({ value: status, label: STAGE_LABEL[status] })),
] as const;

export function stageHint(status: string): string | null {
  return STAGE_HINT[status as CampaignStatus] ?? null;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/** Short priority name, for the table cell and its editor. */
export const PRIORITY_LABEL: Record<CampaignPriority, string> = {
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

/**
 * One line saying what the level means, so "Media" is not read as a judgement
 * nobody made. Shown on the cell's tooltip and beside the editor.
 */
export const PRIORITY_HINT: Record<CampaignPriority, string> = {
  high: "Revisar antes que las demás.",
  medium: "Sin marcar: el nivel por defecto de toda especie añadida.",
  low: "Puede esperar; se revisará cuando no quede nada por encima.",
};

/**
 * Tailwind tone per priority.
 *
 * A single ramp of ATTENTION, not three categorical colours, because that is
 * what the levels are — and deliberately in hues the stage pill beside it does
 * not use, so two coloured pills in adjacent columns cannot be read as one
 * scale. Stage owns amber, sky, blue, violet, stone, emerald and rose.
 *
 * `low` is the faded one rather than a second alarm: a deprioritised species
 * should recede from the list, which is the whole point of marking it.
 */
export const PRIORITY_TONE: Record<CampaignPriority, string> = {
  high: "border-orange-300 bg-orange-100 text-orange-900",
  medium: "border-slate-200 bg-slate-50 text-slate-600",
  low: "border-dashed border-slate-200 bg-transparent text-slate-400",
};

/**
 * Sort rank, ascending = most urgent first.
 *
 * Numeric rather than alphabetical on the label: "Alta" < "Baja" < "Media" as
 * strings, which orders the list high, low, medium — the middle level at the
 * bottom. The rank is the meaning; the label is just how it is spelled.
 */
export const PRIORITY_RANK: Record<CampaignPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function priorityLabel(priority: string): string {
  return PRIORITY_LABEL[priority as CampaignPriority] ?? priority;
}

/**
 * Fallback tone for a priority level the schema gained but this file has not.
 * Its own constant, not a reuse of `PRIORITY_TONE.high` — an unrecognised level
 * is not known to be urgent and must not shout.
 */
const UNKNOWN_PRIORITY_TONE = "border-zinc-200 bg-zinc-50 text-zinc-600";

export function priorityTone(priority: string): string {
  return PRIORITY_TONE[priority as CampaignPriority] ?? UNKNOWN_PRIORITY_TONE;
}

/**
 * Unknown levels sort AFTER every known one rather than tying with `high` at 0,
 * which is what a missing map entry would otherwise do.
 */
export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority as CampaignPriority] ?? CAMPAIGN_PRIORITIES.length;
}

/** Options for the priority filter, most urgent first after the escape hatch. */
export const PRIORITY_FILTERS = [
  { value: "todas", label: "Toda prioridad" },
  ...CAMPAIGN_PRIORITIES.map((p) => ({
    value: p,
    label: `Prioridad ${PRIORITY_LABEL[p].toLowerCase()}`,
  })),
] as const;

/** Icon identifiers the table resolves to components on the client. */
export type RowActionIcon = "headphones" | "settings";

export interface RowAction {
  label: string;
  suffix: string;
  /**
   * A STRING, never a component. React components cannot cross the
   * Server→Client boundary as props, and `npm run build` does not catch it —
   * it fails at runtime.
   */
  icon: RowActionIcon;
  title: string;
}

/**
 * Which action a species row offers.
 *
 * A species with no sample drawn cannot be reviewed — sending someone to an
 * empty review queue is worse than sending them to the page with the controls.
 *
 * The label says where the button goes, because the row has TWO destinations:
 * this one and the species name, which leads to the species page. Unlabelled,
 * the pair reads as one control behaving inconsistently.
 */
export function rowAction(sampled: number): RowAction {
  return sampled > 0
    ? {
        label: "Revisar",
        suffix: "/revisar",
        icon: "headphones",
        title: "Escuchar y clasificar las detecciones muestreadas",
      }
    : {
        label: "Preparar",
        suffix: "",
        icon: "settings",
        title: "Extraer la muestra antes de poder revisar",
      };
}
