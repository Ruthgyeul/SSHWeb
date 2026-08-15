"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * On-screen key bar for touch devices, whose keyboards lack Esc / Ctrl / arrows
 * and friends. Two kinds of buttons:
 *
 *   • **Modifier keys** (Ctrl, Alt) are *sticky one-shot*: tap to arm, and the
 *     next character — whether tapped here or typed on the phone's own keyboard
 *     — is sent with that modifier, then it disarms. The arming lives in the
 *     parent (it must transform the terminal's own input), so this component
 *     just reflects `ctrlActive`/`altActive` and calls the toggles.
 *   • **Character keys** go through the same modifier pipeline (`onChar`);
 *     **sequence keys** (arrows, Esc, Fn keys, …) send a fixed escape sequence
 *     and clear any armed modifier (`onSeq`).
 *
 * Buttons use `onMouseDown`/`onTouchStart` preventDefault so tapping them never
 * steals focus from the terminal — the phone keyboard stays open, which is what
 * makes "arm Ctrl, then type a letter" work.
 */

interface KeyDef {
  label: string;
  seq: string;
  title?: string;
}

const NAV_KEYS: KeyDef[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "←", seq: "\x1b[D", title: "Left" },
  { label: "↓", seq: "\x1b[B", title: "Down" },
  { label: "↑", seq: "\x1b[A", title: "Up" },
  { label: "→", seq: "\x1b[C", title: "Right" },
  { label: "Home", seq: "\x1b[H" },
  { label: "End", seq: "\x1b[F" },
  { label: "Del", seq: "\x1b[3~", title: "Delete (forward)" },
];

const CHAR_KEYS = ["|", "/", ".", "~", "_"];

const EDIT_KEYS: KeyDef[] = [
  { label: "Undo", seq: "\x1f", title: "Undo (Ctrl+_)" },
  { label: "Redo", seq: "\x12", title: "Redo (Ctrl+R)" },
];

const FN_KEYS: KeyDef[] = [
  { label: "F1", seq: "\x1bOP" },
  { label: "F2", seq: "\x1bOQ" },
  { label: "F3", seq: "\x1bOR" },
  { label: "F4", seq: "\x1bOS" },
  { label: "F5", seq: "\x1b[15~" },
  { label: "F6", seq: "\x1b[17~" },
  { label: "F7", seq: "\x1b[18~" },
  { label: "F8", seq: "\x1b[19~" },
  { label: "F9", seq: "\x1b[20~" },
  { label: "F10", seq: "\x1b[21~" },
  { label: "F11", seq: "\x1b[23~" },
  { label: "F12", seq: "\x1b[24~" },
];

const KEY_BASE =
  "flex-none select-none rounded border px-2.5 py-1.5 text-xs font-mono transition-colors active:scale-95";

export function MobileKeys({
  ctrlActive,
  altActive,
  onToggleCtrl,
  onToggleAlt,
  onChar,
  onSeq,
  onCopy,
  onPaste,
}: {
  ctrlActive: boolean;
  altActive: boolean;
  onToggleCtrl: () => void;
  onToggleAlt: () => void;
  onChar: (ch: string) => void;
  onSeq: (seq: string) => void;
  onCopy: () => void;
  onPaste: () => void;
}) {
  const [fnMode, setFnMode] = useState(false);

  // Keep the terminal focused so the phone keyboard doesn't close on tap.
  const keepFocus = (e: React.SyntheticEvent) => e.preventDefault();

  const plain = cn(
    KEY_BASE,
    "border-term-border bg-term-panel text-term-dim hover:text-term-text",
  );
  const modBtn = (on: boolean) =>
    cn(
      KEY_BASE,
      on
        ? "border-term-accent bg-term-accent/20 text-term-accent"
        : "border-term-border bg-term-panel text-term-dim hover:text-term-text",
    );

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-t border-term-border bg-term-panel/80 px-2 py-1.5">
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={() => setFnMode((v) => !v)}
        className={modBtn(fnMode)}
        title="Function keys (F1–F12)"
      >
        Fn
      </button>
      <span className="mx-0.5 h-5 w-px flex-none bg-term-border" aria-hidden />

      {fnMode ? (
        FN_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            onMouseDown={keepFocus}
            onClick={() => onSeq(k.seq)}
            className={plain}
          >
            {k.label}
          </button>
        ))
      ) : (
        <>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onToggleCtrl}
            className={modBtn(ctrlActive)}
            title="Ctrl (applies to the next key)"
          >
            Ctrl
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onToggleAlt}
            className={modBtn(altActive)}
            title="Alt (applies to the next key)"
          >
            Alt
          </button>
          <span
            className="mx-0.5 h-5 w-px flex-none bg-term-border"
            aria-hidden
          />

          {NAV_KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              onMouseDown={keepFocus}
              onClick={() => onSeq(k.seq)}
              className={plain}
              title={k.title ?? k.label}
            >
              {k.label}
            </button>
          ))}
          <span
            className="mx-0.5 h-5 w-px flex-none bg-term-border"
            aria-hidden
          />

          {CHAR_KEYS.map((ch) => (
            <button
              key={ch}
              type="button"
              onMouseDown={keepFocus}
              onClick={() => onChar(ch)}
              className={plain}
            >
              {ch}
            </button>
          ))}
          <span
            className="mx-0.5 h-5 w-px flex-none bg-term-border"
            aria-hidden
          />

          {EDIT_KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              onMouseDown={keepFocus}
              onClick={() => onSeq(k.seq)}
              className={plain}
              title={k.title}
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onCopy}
            className={plain}
            title="Copy terminal selection"
          >
            Copy
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onPaste}
            className={plain}
            title="Paste from clipboard"
          >
            Paste
          </button>
        </>
      )}
    </div>
  );
}
