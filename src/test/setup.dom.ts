/**
 * Vitest setup shared by every test. It registers the `@testing-library/jest-dom`
 * custom matchers (`toBeInTheDocument`, `toHaveTextContent`, …) on Vitest's
 * `expect`. The import only extends `expect`; it needs no DOM at load time, so it
 * is harmless for the node-environment unit tests too. Component tests that need
 * a DOM opt in per-file with a `// @vitest-environment jsdom` docblock — the
 * suite default stays `node` so the pure-logic tests remain fast.
 */
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement IntersectionObserver, which grid-tile thumbnails use
// to lazily request media as they scroll into view. Provide a no-op stub so
// component tests can render the file browser's grid view.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error — minimal stub, not the full DOM interface
  globalThis.IntersectionObserver = IntersectionObserverStub;
}
