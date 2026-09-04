"use client";

import { useState } from "react";
import type { KbdPrompt } from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import { WarningIcon } from "./icons";
import { useModalA11y } from "./hooks/useModalA11y";

/** A host-key confirmation request (trust-on-first-use). */
export interface HostKeyPromptState {
  kind: "hostkey";
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
  /** `new` on first sight, `changed` when it differs from the stored key. */
  verdict: "new" | "changed";
}

/** A keyboard-interactive challenge (OTP / 2FA / interactive password). */
export interface KbdPromptState {
  kind: "kbd";
  name: string;
  instructions: string;
  prompts: KbdPrompt[];
}

export type AuthPromptState = HostKeyPromptState | KbdPromptState;

const boxClass = "term-input";

/**
 * Modal shown during the SSH handshake for the two flows that need user input:
 * confirming an unknown/changed host key, and answering a keyboard-interactive
 * challenge. It is fully controlled — the parent supplies the current prompt and
 * receives the user's decision.
 */
export function AuthPromptModal({
  prompt,
  onHostKeyDecision,
  onKbdSubmit,
}: {
  prompt: AuthPromptState;
  onHostKeyDecision: (accept: boolean) => void;
  onKbdSubmit: (responses: string[]) => void;
}) {
  // Trap focus, but don't map Escape to a close — an auth prompt must be
  // answered explicitly (reject/accept or submit), not dismissed.
  const dialogRef = useModalA11y<HTMLDivElement>({
    onClose: () => {},
    closeOnEscape: false,
  });
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-term-bg/80 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="SSH authentication"
        className="term-modal-in flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-term-border bg-term-card shadow-2xl"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          {prompt.kind === "hostkey" ? (
            <HostKeyBody prompt={prompt} onDecision={onHostKeyDecision} />
          ) : (
            <KbdBody
              // Remount (reset inputs) when a new challenge arrives.
              key={prompt.prompts.map((p) => p.prompt).join("|")}
              prompt={prompt}
              onSubmit={onKbdSubmit}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HostKeyBody({
  prompt,
  onDecision,
}: {
  prompt: HostKeyPromptState;
  onDecision: (accept: boolean) => void;
}) {
  const changed = prompt.verdict === "changed";
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2
          className={cn(
            "flex items-center gap-1.5 text-lg font-semibold",
            changed ? "text-term-red" : "text-term-text",
          )}
        >
          {changed && <WarningIcon className="h-4 w-4" />}
          {changed ? "Host key has changed" : "Verify host key"}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-term-muted">
          {changed ? (
            <>
              The key for{" "}
              <code className="text-term-text">
                {prompt.host}:{prompt.port}
              </code>{" "}
              is <span className="text-term-red">different</span> from the one
              you trusted before. This can mean the server was rebuilt — or a
              man-in-the-middle attack. Only continue if you know why it
              changed.
            </>
          ) : (
            <>
              The authenticity of{" "}
              <code className="text-term-text">
                {prompt.host}:{prompt.port}
              </code>{" "}
              can&apos;t be established. Confirm the fingerprint out-of-band,
              then accept to remember it for next time.
            </>
          )}
        </p>
      </div>

      <dl className="rounded-md border border-term-border bg-term-panel px-3 py-2 text-xs">
        <div className="flex gap-2">
          <dt className="text-term-faint">type</dt>
          <dd className="text-term-dim">{prompt.keyType}</dd>
        </div>
        <div className="mt-1 flex gap-2">
          <dt className="text-term-faint">key</dt>
          <dd className="break-all font-mono text-term-accent">
            {prompt.fingerprint}
          </dd>
        </div>
      </dl>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded-md border border-term-border px-4 py-2 text-sm text-term-muted hover:text-term-text"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onDecision(true)}
          className={cn(
            "rounded-md border px-4 py-2 text-sm font-medium",
            changed
              ? "border-term-red/50 bg-term-red/15 text-term-red hover:bg-term-red/25"
              : "border-term-accent/40 bg-term-accent/15 text-term-accent hover:bg-term-accent/25",
          )}
        >
          {changed ? "Accept anyway" : "Accept & continue"}
        </button>
      </div>
    </div>
  );
}

function KbdBody({
  prompt,
  onSubmit,
}: {
  prompt: KbdPromptState;
  onSubmit: (responses: string[]) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() =>
    prompt.prompts.map(() => ""),
  );

  const title = prompt.name.trim() || "Additional verification";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(answers);
      }}
      className="flex flex-col gap-4"
    >
      <div>
        <h2 className="text-lg font-semibold text-term-text">{title}</h2>
        {prompt.instructions.trim() && (
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-term-muted">
            {prompt.instructions}
          </p>
        )}
        {prompt.prompts.length === 0 && (
          <p className="mt-1 text-xs text-term-muted">
            The server sent an empty challenge — submit to continue.
          </p>
        )}
      </div>

      {prompt.prompts.map((p, i) => (
        <div key={i}>
          <label
            htmlFor={`kbd-${i}`}
            className="mb-1 block text-xs text-term-muted"
          >
            {p.prompt || "Response"}
          </label>
          <input
            id={`kbd-${i}`}
            type={p.echo ? "text" : "password"}
            className={boxClass}
            value={answers[i]}
            autoFocus={i === 0}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) =>
              setAnswers((prev) =>
                prev.map((v, j) => (j === i ? e.target.value : v)),
              )
            }
          />
        </div>
      ))}

      <div className="flex justify-end">
        <button
          type="submit"
          className="term-btn-primary rounded-md px-4 py-2 text-sm"
        >
          Submit
        </button>
      </div>
    </form>
  );
}
