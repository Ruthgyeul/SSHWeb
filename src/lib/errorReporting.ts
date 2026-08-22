/**
 * Client-side error-reporting seam.
 *
 * The error boundaries (`error.tsx`, `global-error.tsx`) call {@link reportError}
 * so there is a single, real integration point for an external reporter (Sentry
 * or similar) instead of a bare `console.error` TODO. It stays dependency-free:
 * nothing is bundled and no CSP directive is widened here. A deployment that
 * wants external reporting sets `NEXT_PUBLIC_SENTRY_DSN` and registers a sink
 * (`globalThis.__sshwebErrorSink`) that forwards the report to its SDK — see
 * `.env.example`. With no DSN configured this is a no-op beyond a console log.
 *
 * The report shape is built by the pure {@link buildErrorReport} (unit-tested);
 * reporting itself must never throw, so the sink call is guarded.
 */

import { ERROR_REPORTING_DSN } from "@/config/siteConfig";

export interface ErrorReport {
  name: string;
  message: string;
  stack?: string;
  digest?: string;
  context?: string;
}

/** A registered external sink (e.g. a Sentry forwarder), if any. */
type ErrorSink = (report: ErrorReport) => void;

/**
 * Normalize any thrown value into a bounded, serializable report. Pure so it can
 * be unit-tested without a DOM. The stack is capped so a pathological error
 * can't produce an unbounded payload.
 */
const MAX_MESSAGE_CHARS = 1000;
const MAX_STACK_CHARS = 4000;

export function buildErrorReport(
  error: unknown,
  context?: string,
): ErrorReport {
  if (error instanceof Error) {
    const digest = (error as Error & { digest?: string }).digest;
    // Bound BOTH the message and the (first stack line normally repeats the
    // message) serialized stack so a huge error message can't produce a
    // multi-megabyte report despite the line cap.
    const stack = error.stack
      ? error.stack
          .split("\n")
          .slice(0, 20)
          .join("\n")
          .slice(0, MAX_STACK_CHARS)
      : undefined;
    return {
      name: error.name || "Error",
      message: (error.message || "").slice(0, MAX_MESSAGE_CHARS),
      stack,
      digest,
      context,
    };
  }
  return {
    name: typeof error,
    message: String(error).slice(0, MAX_MESSAGE_CHARS),
    context,
  };
}

/**
 * Report an error. Always logs to the console for local debugging; when a DSN is
 * configured and a sink is registered, also forwards a bounded report to it.
 * Never throws.
 */
export function reportError(error: unknown, context?: string): void {
  if (typeof console !== "undefined") {
    console.error("[sshweb]", context ?? "error", error);
  }
  if (!ERROR_REPORTING_DSN) return;
  try {
    const sink = (globalThis as { __sshwebErrorSink?: ErrorSink })
      .__sshwebErrorSink;
    if (typeof sink === "function") sink(buildErrorReport(error, context));
  } catch {
    /* reporting must never throw and break the error boundary */
  }
}
