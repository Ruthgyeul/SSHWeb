"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/errorReporting";

/**
 * Root error boundary. This catches errors thrown in the root layout itself —
 * the one case the regular error.tsx cannot handle — so it must render its own
 * <html>/<body> (it REPLACES the root layout when active).
 *
 * Kept intentionally self-contained with inline styles: if the root layout is
 * broken, global CSS and fonts may not have loaded, so we don't depend on them.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, "global-error-boundary");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#0a0d13",
          color: "#e6e8ee",
          fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
        }}
      >
        {/* Self-contained keyframes — this boundary renders when global CSS may
            be unavailable, so the blinking cursor can't rely on globals.css. */}
        <style>{"@keyframes ge-blink{0%,100%{opacity:1}50%{opacity:0}}"}</style>

        {/* Page header (inline copy of TerminalBar — no external CSS here). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 40,
            padding: "0 16px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            background: "#0d1119",
          }}
        >
          {["#f87171", "#fbbf24", "#34d399"].map((c) => (
            <span
              key={c}
              style={{
                width: 11,
                height: 11,
                borderRadius: 999,
                background: c,
              }}
            />
          ))}
          <span style={{ marginLeft: 8, fontSize: 12, color: "#5c6478" }}>
            system — ~/.ssh — zsh
          </span>
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "#5c6478",
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <circle cx="6" cy="6" r="2.2" />
              <circle cx="6" cy="18" r="2.2" />
              <circle cx="18" cy="12" r="2.2" />
              <path d="M6 8.2v7.6M6 6h6a4 4 0 014 4" />
            </svg>
            main
          </span>
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 480,
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              background: "#111621",
              boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
              overflow: "hidden",
            }}
          >
            {/* Window title bar with the macOS traffic-light dots. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 36,
                padding: "0 14px",
                borderBottom: "1px solid rgba(255,255,255,0.08)",
                background: "#0d1119",
              }}
            >
              {["#f87171", "#fbbf24", "#34d399"].map((c) => (
                <span
                  key={c}
                  style={{
                    width: 11,
                    height: 11,
                    borderRadius: 999,
                    background: c,
                  }}
                />
              ))}
              <span style={{ marginLeft: 8, fontSize: 12, color: "#5c6478" }}>
                system — ~ — zsh
              </span>
            </div>

            <div style={{ padding: 24 }}>
              <p style={{ fontSize: 13, color: "#8b93a7", margin: 0 }}>
                <span style={{ color: "#34d399" }}>system</span>
                <span style={{ color: "#5c6478" }}>:~$</span> reboot
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: "0.6em",
                    height: "1.1em",
                    marginLeft: 4,
                    verticalAlign: "text-bottom",
                    background: "#34d399",
                    animation: "ge-blink 1s step-end infinite",
                  }}
                />
              </p>
              <p
                style={{
                  fontSize: 56,
                  fontWeight: 700,
                  margin: "16px 0 8px",
                  color: "#f87171",
                }}
              >
                500
              </p>
              <p style={{ color: "#c3c8d4", marginBottom: 20 }}>
                A fatal error occurred while rendering the application.
              </p>
              <button
                onClick={reset}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "#0d1119",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  padding: "10px 16px",
                  fontSize: 13,
                  color: "#e6e8ee",
                  cursor: "pointer",
                }}
              >
                {/* Inline SVG (explicit size) — this boundary renders when global CSS
                may be unavailable, so it can't rely on utility classes. */}
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v5h-5" />
                </svg>
                Try again
              </button>
            </div>
          </div>
        </div>

        {/* Page footer (inline copy of TerminalFooter). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 36,
            padding: "0 16px",
            borderTop: "1px solid rgba(255,255,255,0.08)",
            background: "#0d1119",
            fontSize: 12,
            color: "#5c6478",
          }}
        >
          <span style={{ color: "#34d399" }}>$</span>
          <span>system — fatal error while rendering the application</span>
        </div>
      </body>
    </html>
  );
}
