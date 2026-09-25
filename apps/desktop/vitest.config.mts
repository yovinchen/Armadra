import { defineConfig } from "vitest/config";

/**
 * The shell's own unit tests. Everything under `src/` runs here; the build
 * scripts keep their `node:test` suites (`scripts/*.test.mjs`), which the
 * package's `test` script runs after this one.
 *
 * `pool: "forks"` because several tests spawn real child processes and signal
 * them — the assertions about SIGTERM, reaping and stdout draining are only
 * worth anything against a real OS process.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/out/**",
      // The one test that launches a real Chromium runs on its own afterwards
      // (`vitest.live.config.mts`): under two hundred parallel workers the
      // browser's start-up outran its budget often enough to be a flake, and a
      // flake teaches people to ignore the only test that proves the pipe
      // protocol against the real thing.
      "**/live.integration.test.ts",
    ],
    environment: "node",
    pool: "forks",
    // Each file's `tempDir()` directories are removed after it (and any tmux
    // server under them stopped).
    setupFiles: ["src/core/testing/setup.ts"],
    // The Host and Runtime process tests wait on real timeouts.
    testTimeout: 60_000,
  },
});
