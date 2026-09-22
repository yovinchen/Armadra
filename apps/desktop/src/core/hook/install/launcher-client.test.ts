import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherClientBinary, resolveClientBinary } from "./shared";

/** What `resolveClientBinary` looks for next to the executable. */
function clientName(): string {
  return process.platform === "win32" ? "armadra-hook.cmd" : "armadra-hook";
}

const dirs: string[] = [];
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "armadra-launcher-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("the TypeScript client's launcher", () => {
  it("is written under the data directory and execs the bundle through the runner", () => {
    const dataDir = temporary();
    const bundle = join(temporary(), "armadra-hook.js");
    writeFileSync(bundle, "// bundle\n");
    const launcher = launcherClientBinary({
      dataDir,
      bundleCandidates: [join(dataDir, "missing.js"), bundle],
      runner: "/Applications/Armadra.app/Contents/MacOS/Armadra",
    });
    expect(launcher).toBe(
      join(
        dataDir,
        "bin",
        process.platform === "win32" ? "armadra-hook.cmd" : "armadra-hook",
      ),
    );
    const script = readFileSync(launcher as string, "utf8");
    expect(script).toContain(bundle);
    expect(script).toContain(
      "/Applications/Armadra.app/Contents/MacOS/Armadra",
    );
    if (process.platform !== "win32")
      expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
  });

  it("is absent when no bundle exists, so the sidecar and PATH are tried instead", () => {
    const dataDir = temporary();
    expect(
      launcherClientBinary({
        dataDir,
        bundleCandidates: [join(dataDir, "nope.js")],
      }),
    ).toBe(undefined);
    expect(existsSync(join(dataDir, "bin"))).toBe(false);
    const sidecarDir = temporary();
    // Windows resolves an executable by extension: the sidecar the installer
    // looks for is `armadra-hook.cmd` there, not the extensionless name.
    const sidecar = join(sidecarDir, clientName());
    writeFileSync(sidecar, "");
    expect(
      resolveClientBinary({
        env: {},
        executableDir: sidecarDir,
        launcher: { dataDir, bundleCandidates: [join(dataDir, "nope.js")] },
      }),
    ).toBe(sidecar);
  });

  it("wins over the sidecar when the bundle is there", () => {
    const dataDir = temporary();
    const bundle = join(temporary(), "armadra-hook.js");
    writeFileSync(bundle, "");
    const sidecarDir = temporary();
    writeFileSync(join(sidecarDir, clientName()), "");
    const resolved = resolveClientBinary({
      env: {},
      executableDir: sidecarDir,
      launcher: {
        dataDir,
        bundleCandidates: [bundle],
        runner: "/usr/bin/node",
      },
    });
    expect(resolved.startsWith(join(dataDir, "bin"))).toBe(true);
  });
});
