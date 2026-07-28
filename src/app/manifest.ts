import type { MetadataRoute } from "next";
import {
  SITE_NAME,
  SITE_SHORT_NAME,
  SITE_DESCRIPTION,
  SITE_LANG,
  THEME_COLOR,
} from "@/config/siteConfig";

/**
 * Generates /manifest.webmanifest (PWA install metadata).
 *
 * Derived from siteConfig so it stays in sync with the rest of the site's
 * branding. The scalable SVG favicon doubles as the app icon; drop real PNG
 * icons into /public/icons and add them here if you want richer install prompts
 * / maskable icons on Android.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_SHORT_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    id: "/",
    display: "standalone",
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    lang: SITE_LANG,
    dir: "ltr",
    orientation: "portrait-primary",
    categories: ["productivity", "utilities"],
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
