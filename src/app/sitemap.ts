import type { MetadataRoute } from "next";
import { SITE_URL } from "@/config/siteConfig";

/**
 * Generates /sitemap.xml.
 *
 * List every public route here. As the site grows, add entries (or map over a
 * data source — CMS, filesystem, etc.) so search engines discover new pages.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  // Public routes, relative to SITE_URL. Add a line per page (or map over a
  // data source) as the site grows; `priority` is relative importance (home = 1).
  const routes: Array<{
    path: string;
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
    priority: number;
  }> = [
    { path: "/", changeFrequency: "monthly", priority: 1 },
    { path: "/about", changeFrequency: "yearly", priority: 0.8 },
    { path: "/preview", changeFrequency: "yearly", priority: 0.3 },
    { path: "/preview/loading", changeFrequency: "yearly", priority: 0.3 },
  ];

  return routes.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
