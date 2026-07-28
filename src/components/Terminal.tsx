"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUTHOR_NAME,
  CONTACT_EMAIL,
  GITHUB_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  TERMINAL_HOST,
  TERMINAL_USER,
} from "@/config/siteConfig";
import { PromptLabel } from "@/components/PromptLabel";
import {
  completeCommand,
  runCommand,
  type TerminalContext,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

/** One executed line and the output it produced. */
interface Block {
  command: string;
  lines: string[];
}

/**
 * An interactive fake shell: type a command, press Enter, get output. This is
 * the one genuinely interactive surface in the template, so it opts into
 * `"use client"` — everything else stays a server component.
 *
 * The command logic lives in `src/lib/terminal.ts` (pure + unit-tested); this
 * component only owns input, history and rendering. Drop it inside a
 * `TerminalWindow` for the framed look.
 *
 * Keys: Enter runs · ↑/↓ browse history · Tab autocompletes.
 */
export function Terminal({
  intro,
  className,
}: {
  /** Lines printed once at the top, before any input (e.g. a welcome banner). */
  intro?: string[];
  className?: string;
}) {
  const ctx = useMemo<TerminalContext>(
    () => ({
      siteName: SITE_NAME,
      description: SITE_DESCRIPTION,
      author: AUTHOR_NAME,
      githubUrl: GITHUB_URL,
      email: CONTACT_EMAIL,
      user: TERMINAL_USER,
      host: TERMINAL_HOST,
    }),
    [],
  );

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState("");
  // Past commands for ↑/↓ recall; `historyIndex` is null when typing fresh.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Focus the prompt on mount without yanking the page down to it.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Keep the newest output in view as the log grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  function submit(raw: string) {
    const result = runCommand(raw, ctx);
    if (result.clear) {
      setBlocks([]);
    } else {
      setBlocks((prev) => [...prev, { command: raw, lines: result.lines }]);
    }
    if (raw.trim() !== "") setHistory((prev) => [...prev, raw]);
    setInput("");
    setHistoryIndex(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      submit(input);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const matches = completeCommand(input);
      if (matches.length === 1) {
        setInput(matches[0]);
      } else if (matches.length > 1) {
        setBlocks((prev) => [...prev, { command: input, lines: [matches.join("  ")] }]);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next]);
      }
    }
  }

  return (
    <div
      ref={scrollRef}
      onClick={() => inputRef.current?.focus({ preventScroll: true })}
      className={cn(
        "max-h-80 overflow-y-auto font-mono text-sm leading-relaxed text-term-dim",
        className,
      )}
    >
      {intro && intro.length > 0 && (
        <div className="mb-3 text-term-muted">
          {intro.map((line, i) => (
            <div key={i}>{line || " "}</div>
          ))}
        </div>
      )}

      {/* Command log — updates announced politely for screen readers. */}
      <div aria-live="polite" className="flex flex-col gap-2">
        {blocks.map((block, i) => (
          <div key={i}>
            <div>
              <PromptLabel />{" "}
              <span className="text-term-text">{block.command}</span>
            </div>
            {block.lines.map((line, j) => (
              <div key={j} className="whitespace-pre-wrap">
                {line || " "}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Live input line — styled to match the log's prompt. */}
      <div className="mt-2 flex items-center">
        <PromptLabel />
        <span className="ml-2 flex-1">
          <label htmlFor="terminal-input" className="sr-only">
            Terminal command input
          </label>
          <input
            id="terminal-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Terminal command input"
            className="w-full border-none bg-transparent p-0 text-term-text caret-term-green outline-none"
          />
        </span>
      </div>
    </div>
  );
}
