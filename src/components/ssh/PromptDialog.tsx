"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A single request to show the in-app dialog. When `input` is present the dialog
 * collects a text value (with optional live `validate`); otherwise it's a plain
 * confirm. This replaces the browser's native `prompt()`/`confirm()` so the
 * dialogs match the terminal theme instead of the grey OS chrome.
 */
export interface DialogRequest {
  title: string;
  message?: string;
  /** Present for a text prompt; omit for a confirm-only dialog. */
  input?: {
    label?: string;
    initialValue?: string;
    placeholder?: string;
    /** Render a masked password field (e.g. for a sudo password). */
    password?: boolean;
  };
  confirmLabel?: string;
  /** Style the confirm button as a destructive action (e.g. delete). */
  danger?: boolean;
  /** Return an error string to block submission, or null when the value is ok. */
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
}

const inputClass =
  "w-full rounded-md border border-term-border bg-term-panel px-3 py-2 font-mono text-sm text-term-text outline-none placeholder:text-term-faint focus:border-term-accent";

export function PromptDialog({
  request,
  onClose,
}: {
  request: DialogRequest;
  onClose: () => void;
}) {
  const [value, setValue] = useState(request.input?.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus (and select) the field when the dialog opens.
  useEffect(() => {
    if (request.input) {
      const el = inputRef.current;
      el?.focus();
      el?.select();
    }
  }, [request.input]);

  const submit = () => {
    if (request.input && request.validate) {
      const err = request.validate(value);
      if (err) {
        setError(err);
        return;
      }
    }
    request.onConfirm(value);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-term-bg/80 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-term-border bg-term-card shadow-2xl">
        <div className="border-b border-term-border px-5 py-3">
          <h2 className="text-sm font-semibold text-term-text">{request.title}</h2>
          {request.message && (
            <p className="mt-1 text-xs leading-relaxed text-term-muted">
              {request.message}
            </p>
          )}
        </div>

        {request.input && (
          <div className="px-5 py-4">
            {request.input.label && (
              <label className="mb-1 block text-xs font-medium text-term-muted">
                {request.input.label}
              </label>
            )}
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              type={request.input.password ? "password" : "text"}
              placeholder={request.input.placeholder}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={inputClass}
            />
            {error && <p className="mt-2 text-xs text-term-red">{error}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-term-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-term-border px-4 py-1.5 text-xs text-term-muted hover:text-term-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className={cn(
              "rounded-md border px-4 py-1.5 text-xs font-medium",
              request.danger
                ? "border-term-red/40 bg-term-red/15 text-term-red hover:bg-term-red/25"
                : "border-term-accent/40 bg-term-accent/15 text-term-accent hover:bg-term-accent/25",
            )}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
