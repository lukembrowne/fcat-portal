import type { SiteInfo } from "@/app/biochoco/overview/types";

/**
 * The public-safe subset of SiteInfo that may cross to the landowner client.
 *
 * Deliberately omits landowner identity (name/phone), GPS (lat/lng), the ODK
 * entity uuid, and free-text notes — none of those belong on the token-gated
 * public page. The contact-form reply flow resolves landowner name/phone
 * server-side instead (see resolveLandownerForToken).
 */
export interface PublicSiteInfo {
  siteId: string;
  siteName: string;
  habitatType: string;
  habitatAssessed: string;
}

/** Project a full SiteInfo down to the public-safe subset (pure). */
export function toPublicSiteInfo(site: SiteInfo | null): PublicSiteInfo | null {
  if (!site) return null;
  return {
    siteId: site.siteId,
    siteName: site.siteName,
    habitatType: site.habitatType,
    habitatAssessed: site.habitatAssessed,
  };
}
