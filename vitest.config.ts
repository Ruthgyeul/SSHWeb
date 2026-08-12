import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

// App code imports via the "@/..." alias; resolve the same alias in tests so
// unit tests can import from src without relative-path spaghetti.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Default to node (fast, no DOM) for the pure-logic unit tests. Component
    // tests opt into a DOM per-file with `// @vitest-environment jsdom`.
    environment: "node",
    // Enable globals so @testing-library/react auto-registers its afterEach
    // cleanup; test files still import from "vitest" explicitly for types.
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.dom.ts"],
  },
});
