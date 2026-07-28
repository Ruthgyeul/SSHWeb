import type { Metadata } from "next";
import Link from "next/link";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalWindow } from "@/components/TerminalWindow";
import { Prompt } from "@/components/Prompt";
import { Terminal } from "@/components/Terminal";
import {
  SITE_NAME,
  SITE_DESCRIPTION,
  GITHUB_URL,
  CONTACT_EMAIL,
} from "@/config/siteConfig";

export const metadata: Metadata = {
  // Home is the canonical title, so no page-specific override beyond the default.
  alternates: { canonical: "/" },
};

/**
 * Demo landing page.
 *
 * Purely illustrative — it shows the terminal design language (bar + window +
 * prompt) so a fresh clone renders something coherent. Replace this with your
 * real home page; the components and layout are the reusable parts.
 *
 * Server component: everything here is static, so it prerenders to plain HTML.
 */
export default function Home() {
  const features = [
    "SEO metadata, robots.ts & sitemap.ts",
    "Dynamic Open Graph / Twitter card images",
    "Terminal-styled 404, 500 & error boundary",
    "Env-driven config (src/config/siteConfig.ts)",
    "PWA manifest, favicon & theme color",
    "Hardened security headers + CSP",
  ];

  return (
    <main className="terminal-bg min-h-screen">
      <TerminalBar branch="main" />

      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12 sm:py-16">
        <TerminalWindow title="~/welcome" className="term-fade-up">
          <div className="flex flex-col gap-4">
            <Prompt command={<span className="text-term-text">whoami</span>} />
            <div>
              <h1 className="text-2xl font-semibold text-term-text sm:text-3xl">
                {SITE_NAME}
              </h1>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-term-muted">
                {SITE_DESCRIPTION}
              </p>
            </div>

            <Prompt
              className="mt-2"
              command={<span className="text-term-text">cat features.txt</span>}
            />
            <ul className="flex flex-col gap-1.5 text-sm text-term-dim">
              {features.map((feature) => (
                <li key={feature} className="flex gap-2">
                  <span className="text-term-green" aria-hidden>
                    ✓
                  </span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <Prompt className="mt-2" command={<span className="term-cursor" aria-hidden />} />
          </div>
        </TerminalWindow>

        <TerminalWindow title="~/console" contentClassName="p-0">
          <Terminal
            className="p-5 sm:p-6"
            intro={[
              "Interactive shell — try a command.",
              "Type 'help' to get started.",
              "",
            ]}
          />
        </TerminalWindow>

        <TerminalWindow title="~/links">
          <div className="flex flex-wrap gap-3 text-sm">
            <Link
              href="/about"
              className="card rounded-lg border border-term-border bg-term-panel px-4 py-2 text-term-dim hover:text-term-accent"
            >
              About →
            </Link>
            <a
              href={GITHUB_URL}
              className="card rounded-lg border border-term-border bg-term-panel px-4 py-2 text-term-dim hover:text-term-accent"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub ↗
            </a>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="card rounded-lg border border-term-border bg-term-panel px-4 py-2 text-term-dim hover:text-term-accent"
            >
              Email ↗
            </a>
          </div>
          <p className="mt-4 text-xs text-term-faint">
            Configure these in{" "}
            <code className="text-term-muted">.env.local</code> — see{" "}
            <code className="text-term-muted">.env.example</code>.
          </p>
        </TerminalWindow>
      </div>
    </main>
  );
}
