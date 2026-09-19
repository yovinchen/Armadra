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
    exclude: ["**/node_modules/**", "**/.claude/**", "**/out/**"],
    environment: "node",
    pool: "forks",
    // The Host and Runtime process tests wait on real timeouts.
    testTimeout: 60_000,
  },
});
