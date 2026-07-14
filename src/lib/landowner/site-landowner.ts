import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { siteShareTokens } from "@/db/schema";
import { isValidShareToken } from "@/lib/public-tokens";
import { fetchEntities } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";

export interface LandownerContactInfo {
  siteId: string;
  landownerName: string;
  landownerPhone: string;
}

/**
 * Resolve the landowner name/phone for a share token, SERVER-SIDE ONLY.
 *
 * Landowner identity never crosses to the public client (see toPublicSiteInfo);
 * this helper exists so the contact-form server action can build a
 * click-to-WhatsApp reply link for the team email. Guarded by `server-only`.
 * Returns null for an invalid/revoked token or an unresolvable site.
 */
export async function resolveLandownerForToken(
  token: string
): Promise<LandownerContactInfo | null> {
  if (!isValidShareToken(token)) return null;

  const [tokenRow] = await db
    .select()
    .from(siteShareTokens)
    .where(
      and(eq(siteShareTokens.token, token), isNull(siteShareTokens.revokedAt))
    );
  if (!tokenRow) return null;

  const sites = await fetchEntities<OdkSiteEntity>(
    BIOCHOCO_PROJECT_ID,
    BIOCHOCO_DATASET_SITES
  );
  const entity = sites.find(
    (s) => (s.site_id ?? s.label) === tokenRow.biochocoSiteId
  );
  if (!entity) return null;

  return {
    siteId: tokenRow.biochocoSiteId,
    landownerName: entity.landowner_name ?? "",
    landownerPhone: entity.landowner_phone ?? "",
  };
}
