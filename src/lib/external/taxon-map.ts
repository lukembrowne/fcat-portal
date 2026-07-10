/**
 * Mapping from external-dataset taxon names (e.g. LILA BC) to the portal's
 * canonical Chocó class labels, plus the licensing/targeting policy for what
 * we are willing to import.
 *
 * Pure module — no DB, no FS, no network. Unit-testable in isolation.
 *
 * Policy (see plan KTD8). The class a crop ends up in represents "what this
 * animal is when seen in the Chocó". So:
 *
 *  - EXACT match where multiple congeners co-occur locally and must stay
 *    distinct: `Leopardus pardalis` (margay/oncilla also occur — never lump
 *    Leopardus) and `Dicotyles tajacu` (exclude white-lipped `Tayassu pecari`,
 *    a separable different genus). `Procyon cancrivorus` is kept exact too
 *    (exclude the North-American `Procyon lotor`).
 *  - GENUS level where the genus is locally monotypic (any local individual
 *    *is* our species) or is unsplittable on a camera-trap image: `Mazama`
 *    (brocket; the americana complex is being split), `Proechimys` (spiny rats,
 *    indistinguishable on camera), and the locally-monotypic
 *    `Dasyprocta / Cuniculus / Tamandua / Nasua / Dasypus / Eira`.
 *
 * Genus-level classes use the portal's "<Genus> sp." label convention
 * (matches existing `Sciurus sp.`). `Mazama sp.` is a NEW class introduced by
 * external augmentation — it survives an export only if local data supplies its
 * val/test split (see plan KTD5).
 */

/** Canonical class label for the brocket-deer class introduced via augmentation. */
export const BROCKET_CLASS = "Mazama sp.";

/**
 * Genus (lowercased) → canonical class label. Used when no exact-species rule
 * matched and the taxon's genus is one we treat at genus granularity.
 */
const GENUS_LEVEL: Record<string, string> = {
  mazama: BROCKET_CLASS,
  proechimys: "Proechimys semispinosus",
  dasyprocta: "Dasyprocta punctata",
  dasypus: "Dasypus fenestratus",
  cuniculus: "Cuniculus paca",
  nasua: "Nasua narica",
  sciurus: "Sciurus sp.",
  tamandua: "Tamandua mexicana",
  eira: "Eira barbara",
};

/**
 * Exact binomial (lowercased) → canonical class label. These override genus
 * rules and are the ONLY way taxa in a congener-ambiguous genus get mapped.
 * Synonyms are listed explicitly.
 */
const EXACT_SPECIES: Record<string, string> = {
  "leopardus pardalis": "Leopardus pardalis",
  "dicotyles tajacu": "Dicotyles tajacu",
  "pecari tajacu": "Dicotyles tajacu", // synonym
  "procyon cancrivorus": "Procyon cancrivorus",
  "cuniculus paca": "Cuniculus paca",
  "agouti paca": "Cuniculus paca", // old genus synonym
};

/**
 * Taxa explicitly refused even though a looser rule might otherwise catch them.
 * Self-documents the exclusions that protect class purity and honest eval.
 */
const EXCLUDED: ReadonlySet<string> = new Set([
  // Other Leopardus — must not be folded into ocelot.
  "leopardus wiedii",
  "leopardus tigrinus",
  "leopardus guttulus",
  "leopardus geoffroyi",
  "leopardus colocola",
  // White-lipped peccary — separable, and absent from western Ecuador.
  "tayassu pecari",
  // Mountain paca — highland congener, not the lowland Chocó paca.
  "cuniculus taczanowskii",
  // North-American raccoon — wrong region/appearance.
  "procyon lotor",
]);

/** Normalize a free-text taxon to a lowercase, single-spaced key. */
function normalizeTaxon(taxon: string): string {
  return taxon
    .normalize("NFC")
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map an external taxon name to a canonical Chocó class label, or `null` if it
 * is not a target (unknown, excluded, or a congener-ambiguous taxon with no
 * exact rule). Resolution order: exclusions → exact species → genus.
 */
export function mapTaxonToClass(taxon: string): string | null {
  const key = normalizeTaxon(taxon);
  if (!key) return null;
  if (EXCLUDED.has(key)) return null;

  if (key in EXACT_SPECIES) return EXACT_SPECIES[key];

  const genus = key.split(" ")[0];
  if (genus in GENUS_LEVEL) return GENUS_LEVEL[genus];

  return null;
}

// ---------------------------------------------------------------------------
// Targeting & caps
// ---------------------------------------------------------------------------

/**
 * Which canonical classes we actively import from external data, and their
 * priority tier. Tier A = starved on count OR camera-site diversity; Tier B =
 * decent but could use site variety. Classes that are already rich AND
 * site-diverse (`Proechimys semispinosus`, `Dasyprocta punctata`,
 * `Dasypus fenestratus`) are intentionally OMITTED — augmenting them mostly
 * adds domain shift. `mapTaxonToClass` still maps them so they can be targeted
 * later, but the importer does not pull them by default.
 */
export const EXTERNAL_TARGET_TIERS: Record<string, "A" | "B"> = {
  [BROCKET_CLASS]: "A",
  "Eira barbara": "A",
  "Tamandua mexicana": "A",
  "Leopardus pardalis": "A",
  "Nasua narica": "A",
  "Dicotyles tajacu": "A",
  "Procyon cancrivorus": "A",
  "Cuniculus paca": "B",
  "Sciurus sp.": "B",
};

/**
 * Flat per-class cap on imported external (LILA) train images.
 *
 * A flat cap (rather than a fraction of local train count) intentionally boosts
 * the long tail — the rarest classes, which need the most help, are no longer
 * throttled by how little local data they have — and improves class balance.
 * Crucially, the model's open weights are meant to be shared for use in
 * AddaxAI on OTHER groups' cameras, so LILA's cross-domain imagery is a feature
 * (better out-of-domain generalization), not contamination. Honest eval is
 * preserved because val/test stay 100% FCAT (external is train-only), so a
 * regression from over-augmentation would still show up in per-class FCAT F1.
 */
export const EXTERNAL_CAP_PER_CLASS = 1000;

/** Max external train images allowed for a class. Flat — see EXTERNAL_CAP_PER_CLASS. */
export function externalCapForClass(): number {
  return EXTERNAL_CAP_PER_CLASS;
}

// ---------------------------------------------------------------------------
// Licensing
// ---------------------------------------------------------------------------

/**
 * Licenses we accept for redistribution-safe training data. LILA's target
 * camera-trap sets (Orinoquía, WCS) are CDLA-Permissive; some images are CC0.
 * Non-commercial (CC-BY-NC) and all-rights-reserved are refused.
 */
const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  "cc0",
  "cc0-1.0",
  "cc0 1.0",
  "public domain",
  "cdla-permissive-1.0",
  "cdla-permissive-2.0",
  "community data license agreement - permissive - version 1.0",
  "community data license agreement - permissive - version 2.0",
]);

/** True if `license` is on the redistribution-safe allowlist. */
export function isLicenseAllowed(license: string | null | undefined): boolean {
  if (!license) return false;
  const key = license
    .toLowerCase()
    .replace(/[–—]/g, "-") // en/em dash → hyphen
    .replace(/\s+/g, " ")
    .trim();
  return LICENSE_ALLOWLIST.has(key);
}
