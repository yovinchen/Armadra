import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo-root";

describe("the repository root", () => {
  it("is four levels above the built main bundle", () => {
    // The layout the bundle sees: apps/desktop/out/main/index.js.
    expect(repoRoot("/repo/apps/desktop/out/main")).toBe("/repo");
  });

  it("really names this repository when resolved from the source tree", () => {
    // Under vitest `__dirname` is src/main, which is the same depth as
    // out/main — which is why one wrong `..` produced a Host binary path that
    // silently did not exist while the Runtime's did.
    const root = repoRoot();
    expect(existsSync(join(root, "apps/desktop/package.json")), root).toBe(
      true,
    );
    expect(existsSync(join(root, "repo.rules.json")), root).toBe(true);
  });
});
