import type { Metadata } from "next";
import { TerminalBar } from "@/components/TerminalBar";
import { SshClient } from "@/components/ssh/SshClient";
import { AccessGate } from "@/components/ssh/AccessGate";
import { SITE_DESCRIPTION } from "@/config/siteConfig";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * Home — the SSH client itself.
 *
 * SSHWeb puts the tool front and center: a connection form, an interactive
 * terminal, and an SFTP file browser. The client work lives in the `SshClient`
 * component (it owns the WebSocket to the `server.mjs` bridge); this route is a
 * thin, full-height server-rendered shell around it.
 */
export default function Home() {
  return (
    <main className="terminal-bg flex h-[100dvh] flex-col">
      <TerminalBar />
      <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-sm text-term-muted">
            <span className="text-term-green">ssh</span> — web terminal &amp;
            file access
          </h1>
          <p className="hidden truncate text-xs text-term-faint sm:block">
            {SITE_DESCRIPTION}
          </p>
        </div>
        <AccessGate>
          <SshClient />
        </AccessGate>
      </div>
    </main>
  );
}
