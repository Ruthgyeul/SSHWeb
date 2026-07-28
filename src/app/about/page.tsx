import type { Metadata } from "next";
import Link from "next/link";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalWindow } from "@/components/TerminalWindow";
import { Prompt } from "@/components/Prompt";
import { SITE_NAME } from "@/config/siteConfig";

/**
 * Example second route.
 *
 * This exists to show the pattern for adding a page to the template:
 *   1. Create `src/app/<route>/page.tsx`.
 *   2. Export `metadata` (title/description) — the layout title template turns
 *      `title` into "About · <short name>". `alternates.canonical` points search
 *      engines at the canonical URL for this path.
 *   3. Register the route in `src/app/sitemap.ts` so it gets crawled.
 *
 * Server component: static, prerenders to HTML. Replace the copy with your own.
 */
export const metadata: Metadata = {
  title: "About",
  description: `Learn more about ${SITE_NAME}.`,
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <main className="terminal-bg min-h-screen">
      <TerminalBar branch="main" />

      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12 sm:py-16">
        <TerminalWindow title="~/about" className="term-fade-up">
          <div className="flex flex-col gap-4">
            <Prompt command={<span className="text-term-text">cat about.md</span>} />
            <div>
              <h1 className="text-2xl font-semibold text-term-text sm:text-3xl">
                About {SITE_NAME}
              </h1>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-term-muted">
                This is an example second page. It demonstrates how routes,
                per-page metadata, and the sitemap fit together in this template
                — duplicate this folder to add your own pages.
              </p>
            </div>

            <Prompt
              className="mt-2"
              command={<span className="text-term-text">cd ~</span>}
            />
            <Link
              href="/"
              className="inline-block w-fit rounded-md border border-term-border bg-term-panel px-4 py-2.5 text-sm text-term-text hover:border-term-accent hover:text-term-accent"
            >
              ← Back to home
            </Link>
          </div>
        </TerminalWindow>
      </div>
    </main>
  );
}
