"use client";

import { useEffect } from "react";
import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * Route-level error boundary (500). Next.js renders this when a runtime error
 * escapes a page or nested layout. `reset()` retries the failed segment.
 *
 * `error.digest` is a server-generated hash you can correlate with server logs;
 * the raw message is intentionally NOT shown to visitors.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for debugging; wire real error reporting (Sentry, etc.) here.
    console.error(error);
  }, [error]);

  return (
    <div>
      <ErrorScreen
        command="systemctl status app.service"
        code="500"
        codeClassName="text-term-yellow"
        message="Error: something went wrong on the server. It has been logged."
        details={[
          { key: "status", value: "500", valueClassName: "text-term-red" },
          { key: "service", value: "'app'" },
          {
            key: "digest",
            value: error.digest ? `'${error.digest}'` : "'n/a'",
          },
        ]}
      />
      {/* Overlay a retry button; the ErrorScreen's own link goes home. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-8 flex justify-center">
        <button
          onClick={reset}
          className="pointer-events-auto rounded-md border border-term-border bg-term-panel px-4 py-2.5 text-sm text-term-text hover:border-term-accent hover:text-term-accent"
        >
          ↻ Try again
        </button>
      </div>
    </div>
  );
}
