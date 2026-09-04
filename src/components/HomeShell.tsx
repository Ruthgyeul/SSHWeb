"use client";

import { useState } from "react";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalFooter } from "@/components/TerminalFooter";
import { SshClient } from "@/components/ssh/SshClient";
import { AccessGate } from "@/components/ssh/AccessGate";

/**
 * Client shell for the home route. The {@link TerminalBar} header is always
 * shown (a persistent page header on every state). The {@link TerminalFooter}
 * is shown only on the access-key lock screen; once the app itself is visible
 * (connect form or a live session) the footer is dropped so the tool gets the
 * full viewport.
 *
 * The `locked` signal is reported by {@link AccessGate}.
 */
export function HomeShell() {
  const [locked, setLocked] = useState(false);

  return (
    <>
      <TerminalBar branch="main" />
      <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
        <AccessGate onLockedChange={setLocked}>
          <SshClient />
        </AccessGate>
      </div>
      {locked && <TerminalFooter />}
    </>
  );
}
