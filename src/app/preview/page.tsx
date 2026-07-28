import type { Metadata } from "next";
import Link from "next/link";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalWindow } from "@/components/TerminalWindow";
import { LoadingScreen } from "@/components/LoadingScreen";
import { SITE_NAME } from "@/config/siteConfig";

/**
 * Component preview / showcase route.
 *
 * Loading UI is transient (Next.js only shows `loading.tsx` while a segment
 * streams), so this page renders the shared {@link LoadingScreen} in its
 * embeddable form (`fullScreen={false}`) to make its states easy to eyeball.
 * Add a frame here whenever you build a new shared component.
 */
export const metadata: Metadata = {
  title: "Preview",
  description: `Component previews for ${SITE_NAME}.`,
  alternates: { canonical: "/preview" },
};

const LOADING_VARIANTS: Array<{
  title: string;
  command: string;
  steps?: string[];
}> = [
  {
    title: "LoadingScreen — default",
    command: "loading",
  },
  {
    title: "LoadingScreen — with resolved steps",
    command: "npm run build",
    steps: ["compiled config", "resolved routes"],
  },
];

export default function PreviewPage() {
  return (
    <main className="terminal-bg min-h-screen">
      <TerminalBar branch="main" />

      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12 sm:py-16">
        <div className="term-fade-up">
          <h1 className="text-2xl font-semibold text-term-text sm:text-3xl">
            Component preview
          </h1>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-term-muted">
            A gallery of shared UI components rendered in isolation. Useful for
            eyeballing transient states — like loading screens — that are hard to
            catch in the running app.
          </p>
        </div>

        {LOADING_VARIANTS.map(({ title, command, steps }) => (
          <TerminalWindow
            key={title}
            title={title}
            className="term-fade-up"
            contentClassName="p-0"
          >
            <div className="h-64">
              <LoadingScreen
                command={command}
                steps={steps}
                fullScreen={false}
              />
            </div>
          </TerminalWindow>
        ))}

        <Link
          href="/preview/loading"
          className="inline-block w-fit text-sm text-term-accent hover:text-term-accent-soft"
        >
          → Open the full-screen LoadingScreen preview
        </Link>

        <Link
          href="/"
          className="inline-block w-fit rounded-md border border-term-border bg-term-panel px-4 py-2.5 text-sm text-term-text hover:border-term-accent hover:text-term-accent"
        >
          ← Back to home
        </Link>
      </div>
    </main>
  );
}
