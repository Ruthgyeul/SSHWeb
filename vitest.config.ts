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
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
