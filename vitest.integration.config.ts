import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

/**
 * Config for the end-to-end bridge integration test (`npm run test:integration`).
 * It's kept separate from the default unit config so the fast `npm test` never
 * boots a server: this one includes only the `*.integration.test.mjs` file,
 * runs it in a single fork (one server process at a time), and allows generous
 * timeouts for the server to boot and complete a full SSH round-trip.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.mjs"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One server process at a time — no parallel boots fighting over ports.
    fileParallelism: false,
    pool: "forks",
  },
});
