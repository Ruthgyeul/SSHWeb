import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";

import {
  SITE_URL,
  SITE_NAME,
  SITE_SHORT_NAME,
  SITE_DESCRIPTION,
  SITE_LOCALE,
  SITE_LANG,
  AUTHOR_NAME,
  AUTHOR_URL,
  THEME_COLOR,
} from "@/config/siteConfig";
import { toJsonLd } from "@/lib/utils";
import "@/styles/globals.css";

/**
 * Self-hosted Geist Mono. Bundling the font (rather than linking Google Fonts
 * at runtime) removes a third-party dependency from the critical path — better
 * availability, no layout shift, and it satisfies the strict CSP in
 * next.config.ts (`font-src 'self'`).
 */
const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-geist-mono",
});

/**
 * All site metadata is derived from siteConfig (env-driven), so branding a fork
 * means editing `.env.local`, not this file. `metadataBase` lets Next resolve
 * the relative OG/Twitter image routes to absolute URLs.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_SHORT_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: AUTHOR_NAME, url: AUTHOR_URL }],
  creator: AUTHOR_NAME,
  publisher: AUTHOR_NAME,
  keywords: [
    "SSH",
    "web SSH client",
    "browser terminal",
    "SFTP",
    "xterm.js",
    "web terminal",
  ],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    shortcut: ["/favicon.svg"],
    apple: [{ url: "/icons/apple-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: SITE_SHORT_NAME,
    statusBarStyle: "black-translucent",
  },
  formatDetection: { email: false, telephone: false, address: false },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    locale: SITE_LOCALE,
    // The image itself is generated on the fly by src/app/opengraph-image.tsx.
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
};

/**
 * Schema.org WebApplication markup so search/social/AI crawlers understand this
 * is a browser-based SSH tool. Keep it in sync with siteConfig.
 */
const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  alternateName: SITE_SHORT_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any (web browser)",
  inLanguage: SITE_LANG,
  author: {
    "@type": "Organization",
    name: AUTHOR_NAME,
    url: AUTHOR_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={SITE_LANG} className={geistMono.variable}>
      <body className="min-h-screen bg-term-bg text-term-text antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: toJsonLd(websiteJsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
