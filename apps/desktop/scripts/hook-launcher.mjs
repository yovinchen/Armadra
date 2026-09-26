/**
 * Builds `armadra-hook.exe`, the Windows launcher of the hook client
 * (`src/cli/armadra-hook/windows-launcher.cs`).
 *
 * Why an `.exe` at all: the `.cmd` launcher it replaces is run through
 * `cmd.exe`, which re-reads the whole command line — `&`, `|`, `%`, `^` and an
 * escaped quote inside `canvas send --body …` turn into command separators,
 * variable expansions or a shifted quote state. A console `.exe` receives the
 * caller's command line untouched and hands it to Electron verbatim.
 *
 * Why C# and `csc.exe`: every Windows 10/11 ships the .NET Framework 4 C#
 * compiler under `%WINDIR%\Microsoft.NET\Framework*\v4.0.30319\`, so the
 * Windows build needs no extra toolchain, and the result is a few kilobytes
 * that runs natively on x64 and arm64 (`/platform:anycpu`). A Node single
 * executable would be ~80 MB; a Go or Rust shim would add a toolchain the
 * release runners do not otherwise need.
 *
 * Compiling only works on a Windows host. `after-pack.mjs` calls this for a
 * Windows target; the core falls back to the `.cmd` launcher when no `.exe`
 * sits next to the bundle.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));

/** The C# source, relative to `apps/desktop`. */
export const HOOK_LAUNCHER_SOURCE = "src/cli/armadra-hook/windows-launcher.cs";

/** Where the launcher goes in a packaged app, beside `cli/armadra-hook.js`. */
export const HOOK_LAUNCHER_RESOURCE = "cli/armadra-hook.exe";

/**
 * The `csc.exe` candidates, most preferred first. `Framework64` exists on x64
 * and on arm64 (as x64 under emulation); `FrameworkArm64` only on arm64; the
 * 32-bit `Framework` everywhere. The compiler is a managed program, so any of
 * them produces the same anycpu image.
 */
export function cscCandidates(env = process.env) {
  const windir = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  return ["FrameworkArm64", "Framework64", "Framework"].map((framework) =>
    join(windir, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
  );
}

/** The first `csc.exe` that exists, or `undefined`. */
export function findCsc({ env = process.env, exists = existsSync } = {}) {
  return cscCandidates(env).find((candidate) => exists(candidate));
}

/** The `csc` arguments that build `output` from `source`. */
export function cscArguments(source, output) {
  return [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/debug-",
    `/out:${output}`,
    source,
  ];
}

/**
 * Compiles the launcher into `output` and returns its path. Throws with the
 * compiler's own output when it fails, or when there is no compiler.
 */
export function compileHookLauncher(
  output,
  {
    source = join(app, HOOK_LAUNCHER_SOURCE),
    env = process.env,
    run = spawnSync,
  } = {},
) {
  const csc = findCsc({ env });
  if (csc === undefined) {
    throw new Error(
      `hook-launcher: no csc.exe under ${cscCandidates(env).join(", ")}`,
    );
  }
  mkdirSync(dirname(output), { recursive: true });
  const result = run(csc, cscArguments(source, output), { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `hook-launcher: csc exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return output;
}

// `node scripts/hook-launcher.mjs <out>` builds it by hand, e.g. into `out/cli`
// on a Windows development machine so an unpackaged core picks it up too.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ?? join(app, "out", "cli", "armadra-hook.exe");
  console.log(`hook-launcher: built ${compileHookLauncher(output)}`);
}
