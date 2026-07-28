import type { Metadata } from "next";
import Link from "next/link";
import { TerminalBar } from "@/components/TerminalBar";
import { SshClient } from "@/components/ssh/SshClient";

export const metadata: Metadata = {
  title: "SSH Terminal",
  description:
    "Connect to any SSH server from your browser — an interactive terminal plus SFTP file access, relayed through a self-hosted bridge.",
  alternates: { canonical: "/ssh" },
};

/**
 * The web SSH client. The heavy lifting lives in the client `SshClient`
 * component (it owns the WebSocket to the `server.mjs` bridge); this route is a
 * thin, full-height server-rendered shell around it.
 */
export default function SshPage() {
  return (
    <main className="terminal-bg flex h-[100dvh] flex-col">
      <TerminalBar />
      <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-sm text-term-muted">
            <span className="text-term-green">ssh</span> — web terminal &amp;
            file access
          </h1>
          <Link href="/" className="text-xs text-term-faint hover:text-term-accent">
            ← home
          </Link>
        </div>
        <SshClient />
      </div>
    </main>
  );
}
