import type { MetadataRoute } from "next";
import { SITE_URL, ALLOW_INDEXING } from "@/config/siteConfig";

/**
 * Generates /robots.txt. Indexing is env-controlled: set
 * NEXT_PUBLIC_ALLOW_INDEXING=false on staging/preview deploys to keep them out
 * of search results, and leave it unset/true in production.
 */
export default function robots(): MetadataRoute.Robots {
  if (!ALLOW_INDEXING) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
