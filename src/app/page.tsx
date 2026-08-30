import type { Metadata } from "next";
import { HomeShell } from "@/components/HomeShell";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * Home — the SSH client itself.
 *
 * SSHWeb puts the tool front and center: a connection form, an interactive
 * terminal, and an SFTP file browser. The interactive shell lives in
 * `HomeShell` (a client component that owns the page chrome and mounts
 * `SshClient`, which holds the WebSocket to the `server.mjs` bridge); this
 * route is a thin, full-height server-rendered wrapper around it.
 */
export default function Home() {
  return (
    <main className="terminal-bg safe-area-inset flex h-[100dvh] flex-col">
      <HomeShell />
    </main>
  );
}
