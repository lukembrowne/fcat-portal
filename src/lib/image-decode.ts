/**
 * Shared sharp input options for decoding camera-trap originals.
 *
 * Some field cameras write JPEGs whose entropy-coded scan data ends early. The
 * file is byte-for-byte intact on Drive (md5 and size match, `ffd8` … `ffd9`
 * markers present), but libjpeg emits "Corrupt JPEG data: premature end of data
 * segment" while decoding the final MCUs. POT-001 and POT-003 are affected for
 * every image; neighbouring deployments from other cameras are clean.
 *
 * sharp's default is `failOn: "warning"`, which turns that recoverable warning
 * into a hard throw. Every derivative then failed — thumbnail, 1920px annotate
 * tier, training crop, compression — and the annotation viewer rendered a broken
 * image icon behind a misleading `{"error":"Drive API error"}` 502.
 *
 * `failOn: "truncated"` decodes these frames in full (the damaged tail shows as a
 * partial band at the bottom) while still REJECTING a genuinely truncated buffer,
 * such as a half-finished Drive download. `failOn: "none"` would accept those too
 * and silently bake a corrupt half-image into the derivative cache, so it is
 * deliberately not used here.
 */
export const TOLERANT_DECODE = { failOn: "truncated" } as const;
