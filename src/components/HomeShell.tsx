"use client";

import { useState } from "react";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalFooter } from "@/components/TerminalFooter";
import { SshClient } from "@/components/ssh/SshClient";
import { AccessGate } from "@/components/ssh/AccessGate";
import { SITE_DESCRIPTION } from "@/config/siteConfig";

/**
 * Client shell for the home route. Owns the page chrome (header/footer + title
 * line) and hides it once a session is live, so the connect / access screens are
 * framed like a page while a connected terminal gets the whole viewport.
 *
 * The `connected` signal is reported by {@link SshClient} for its active tab.
 */
export function HomeShell() {
  const [connected, setConnected] = useState(false);

  return (
    <>
      {!connected && <TerminalBar branch="main" />}
      <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
        {!connected && (
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-sm text-term-muted">
              <span className="text-term-green">ssh</span> — web terminal &amp;
              file access
            </h1>
            <p className="hidden truncate text-xs text-term-faint sm:block">
              {SITE_DESCRIPTION}
            </p>
          </div>
        )}
        <AccessGate>
          <SshClient onConnectedChange={setConnected} />
        </AccessGate>
      </div>
      {!connected && <TerminalFooter />}
    </>
  );
}
