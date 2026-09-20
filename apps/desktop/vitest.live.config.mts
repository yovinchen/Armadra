import { defineConfig } from "vitest/config";

/**
 * The live-browser test alone, after the parallel suite has finished (see the
 * `exclude` note in `vitest.config.mts`). One file, one fork, a budget that
 * covers a cold Chromium start on a loaded machine.
 */
export default defineConfig({
  test: {
    include: ["src/core/browser/headless/live.integration.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
