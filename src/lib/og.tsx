import { ImageResponse } from "next/og";
import { color } from "@/lib/theme";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/config/siteConfig";

/**
 * Shared Open Graph / Twitter card image generator.
 *
 * Rendered at request time by Next.js for the `opengraph-image` and
 * `twitter-image` file conventions, so the site ships a proper 1200×630 social
 * preview without committing a binary asset. The look mirrors the site's
 * terminal aesthetic. Uses theme.ts tokens because this runs in a Satori
 * runtime with no DOM / CSS.
 *
 * Note: only a limited subset of CSS works here (flexbox, no `gap` on some
 * versions — margins used instead), which is why the styles are verbose.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = SITE_NAME;

/** Strip the scheme so the card shows a clean "example.com" host label. */
const host = SITE_URL.replace(/^https?:\/\//, "");

export function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: color.bg,
          color: color.text,
          padding: "72px 80px",
          fontFamily: "monospace",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: color.accent,
            fontSize: 30,
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: color.green,
              marginRight: 16,
            }}
          />
          {host}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 30, color: color.faint }}>
            <span style={{ color: color.green }}>$</span>
            <span style={{ marginLeft: 12 }}>whoami</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1.1,
              marginTop: 18,
            }}
          >
            {SITE_NAME}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              color: color.muted,
              marginTop: 20,
              maxWidth: 940,
            }}
          >
            {SITE_DESCRIPTION}
          </div>
        </div>

        <div style={{ display: "flex", fontSize: 26, color: color.faint }}>
          Next.js · TypeScript · Tailwind CSS
        </div>
      </div>
    ),
    { ...size },
  );
}
