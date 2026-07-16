import type { MetadataRoute } from "next";

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

/**
 * Site-wide robots policy.
 *
 * Note on the token-gated landowner/report/share pages under /public/…/[token]:
 * they are intentionally NOT Disallow-ed here. Each one serves an authoritative
 * `noindex` (page `robots` metadata + `X-Robots-Tag` on the media routes), and a
 * robots.txt Disallow would stop crawlers from fetching the page and therefore
 * from ever SEEING that noindex — which can leave a leaked URL indexed. Letting
 * them be crawled is what makes the noindex stick. The public recruiting page
 * (/public/biochoco-overview) stays fully indexable.
 *
 * We only block /api/ — internal endpoints that should never be listed as
 * standalone documents. The public media proxies under /api/public/ additionally
 * send `X-Robots-Tag: noindex` for crawlers that fetch them directly.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    host: PUBLIC_BASE_URL,
  };
}
