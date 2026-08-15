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
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Gate the pure, DOM-free logic in src/lib — the "two synchronized places"
      // source of truth that the bridge mirrors. The interactive UI layer is
      // exercised by component tests but not held to a line threshold here.
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/theme.ts", "src/lib/og.tsx"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
