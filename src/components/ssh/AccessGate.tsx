"use client";

import { useCallback, useEffect, useState } from "react";
import { SITE_NAME } from "@/config/siteConfig";

/** Where the relay's access-gate probe/exchange endpoint lives (matches server.mjs). */
const ACCESS_PATH = "/api/access";

type GateState = "checking" | "open" | "locked" | "unlocked";

/**
 * Optional access gate for the whole relay. When the server sets
 * `SSH_ACCESS_TOKEN`, the bridge refuses WebSocket upgrades that don't carry a
 * valid access cookie. This component asks `GET /api/access` whether a token is
 * required (and whether this browser already holds the cookie); if it's required
 * and missing, it shows a single token prompt that `POST`s to the same endpoint
 * to obtain the (HttpOnly) cookie, then reveals the app.
 *
 * When no token is configured the gate is transparent — it renders its children
 * immediately after a quick probe, so the default open deployment is unchanged.
 */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Probe the gate once on mount. The setState calls run after `await`, so
  // they're asynchronous (not a synchronous cascade) — a `cancelled` flag guards
  // against a resolve landing after unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(ACCESS_PATH, { cache: "no-store" });
        const data = (await res.json()) as {
          required: boolean;
          authorized: boolean;
        };
        if (cancelled) return;
        setState(!data.required || data.authorized ? "open" : "locked");
      } catch {
        // If the probe can't be reached, don't hard-block the app — the
        // WebSocket upgrade remains the real gate and will surface errors.
        if (!cancelled) setState("open");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setSubmitting(true);
      setError("");
      try {
        const res = await fetch(ACCESS_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (res.ok) {
          setToken("");
          setState("unlocked");
        } else {
          setError("Incorrect access key.");
        }
      } catch {
        setError("Could not reach the server. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [token, submitting],
  );

  if (state === "open" || state === "unlocked") return <>{children}</>;

  if (state === "checking") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-term-faint">
        <span className="term-cursor" aria-hidden /> Checking access…
      </div>
    );
  }

  // Locked: ask for the shared access key.
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-term-border bg-term-card p-6"
      >
        <div className="mb-4 flex items-center gap-3">
          <span
            className="select-none font-mono text-2xl text-term-accent"
            aria-hidden
          >
            &gt;
            <span className="term-cursor ml-0.5 align-middle" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-term-text">
              {SITE_NAME}
            </p>
            <p className="truncate text-xs text-term-muted">
              This relay is protected
            </p>
          </div>
        </div>
        <label
          htmlFor="access-key"
          className="mb-1.5 block text-xs text-term-muted"
        >
          Access key
        </label>
        <input
          id="access-key"
          type="password"
          value={token}
          autoFocus
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-md border border-term-border bg-term-bg px-3 py-2 text-sm text-term-text outline-none focus:border-term-accent"
          placeholder="Enter the access key"
        />
        {error && (
          <p className="mt-2 rounded-md border border-term-red/40 bg-term-red/10 px-3 py-2 text-xs text-term-red">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || token.trim() === ""}
          className="mt-4 w-full rounded-md border border-term-accent/40 bg-term-accent/15 px-4 py-2 text-sm font-medium text-term-accent hover:bg-term-accent/25 disabled:opacity-40"
        >
          {submitting ? "Unlocking…" : "Unlock"}
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-term-faint">
          The access key gates this relay only — your SSH credentials are still
          relayed straight to the target host and never stored.
        </p>
      </form>
    </div>
  );
}
