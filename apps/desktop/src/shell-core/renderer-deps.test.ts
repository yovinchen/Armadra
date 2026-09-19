import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The renderer target in `electron.vite.config.ts` imports `apps/web`'s own
 * Vite config, so the shell builds the front end exactly one way. electron-vite
 * bundles that config into a temporary module inside `apps/desktop`, which
 * means apps/web's build plugins have to resolve from HERE too.
 *
 * Listing them twice is the cost of that. This test is what keeps the second
 * list honest: a version bump in apps/web that is not mirrored here would
 * otherwise let the desktop bundle quietly diverge from the web bundle, and
 * the only symptom would be a packaged app that renders differently from the
 * one the front-end tests ran against.
 */
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "../..");

function devDependencies(manifest: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return parsed.devDependencies ?? {};
}

const SHARED = [
  "vite",
  "@vitejs/plugin-react",
  "@tailwindcss/vite",
  "tailwindcss",
] as const;

describe("the renderer build toolchain", () => {
  const desktop = devDependencies(join(app, "package.json"));
  const web = devDependencies(join(app, "../web/package.json"));

  it("is pinned to exactly the versions apps/web builds with", () => {
    for (const name of SHARED) {
      expect(web[name], `apps/web no longer declares ${name}`).toBeDefined();
      expect(desktop[name], name).toBe(web[name]);
    }
  });
});
