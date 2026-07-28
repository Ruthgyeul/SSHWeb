import type { NextConfig } from "next";

/**
 * Content-Security-Policy — defense-in-depth for a site that serves only its
 * own first-party assets (self-hosted fonts, images, the inline JSON-LD and
 * Next.js bootstrap scripts). Everything stays on `'self'`; no external origins
 * are allowed by default.
 *
 * `'unsafe-inline'` is required on a statically prerendered App-Router site for
 * two reasons we cannot avoid: React inline `style={{…}}` attributes (style-src)
 * and Next.js's inline hydration/bootstrap scripts (script-src). Proper nonces
 * need per-request dynamic rendering, which a static template deliberately
 * avoids. `'unsafe-eval'` is added only in `next dev`, where React Fast Refresh
 * needs it; production never allows eval.
 *
 * When you add third-party origins (analytics, an API on another host, a font
 * CDN), widen the relevant directive here rather than dropping the policy.
 */
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  // Don't advertise the framework/version to attackers.
  poweredByHeader: false,

  // Fail the build on type errors so a broken deploy never ships. (Linting runs
  // separately via the `lint` script in CI — see .github/workflows/ci.yml.)
  typescript: { ignoreBuildErrors: false },

  // Security headers, applied by the Node server to every response. HTTPS-only
  // headers (HSTS) are ignored by browsers over plain HTTP, so they're safe to
  // send in every environment.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
