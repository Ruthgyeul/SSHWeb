"use client";

import { useSyncExternalStore } from "react";
import { ErrorScreen } from "@/components/ErrorScreen";

// The requested path never changes for a given render, so there is nothing to
// subscribe to — we just need a client value (the real path) with an SSR
// fallback that avoids a hydration mismatch.
const subscribe = () => () => {};

/**
 * 404 page. Reflects the actually-requested path back in the "command" so it
 * reads like a real failed shell request (`curl /some/missing/path`).
 */
export default function NotFound() {
  const path = useSyncExternalStore(
    subscribe,
    () => window.location.pathname || "/unknown",
    () => "/unknown",
  );

  return (
    <ErrorScreen
      command={`curl ${path}`}
      code="404"
      codeClassName="text-term-red"
      message="Error: the requested path was not found on this server."
      details={[
        { key: "status", value: "404", valueClassName: "text-term-yellow" },
        { key: "message", value: "'page not found'" },
        { key: "path", value: `'${path}'` },
      ]}
    />
  );
}
