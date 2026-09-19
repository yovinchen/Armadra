import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Runtime's data directory, resolved the way the Runtime resolves it
 * itself (`apps/runtime/src/paths.rs`, `data_dir`) and the way the Rust shell
 * this one replaced did.
 *
 * Electron offers `app.getPath('userData')`, and on macOS it even lands in the
 * same place. It is still not used here, for the reason the Rust shell gave:
 * the Runtime socket and `endpoints.json` live in this directory, and the two
 * processes have to agree on where that is *before* either can talk to the
 * other. A path that comes from Electron's own conventions is a path the
 * Runtime has never heard of.
 *
 * `env` is a parameter rather than a read of `process.env` so the resolution
 * can be tested for all three platforms on any one of them.
 */
export type PlatformName = "darwin" | "win32" | (string & {});

export interface PathEnvironment {
  readonly ARMADRA_DATA_DIR?: string | undefined;
  readonly LOCALAPPDATA?: string | undefined;
  readonly XDG_DATA_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  // Lets `process.env` be passed directly; only the four names above are read.
  readonly [name: string]: string | undefined;
}

export function dataDir(
  platform: PlatformName = process.platform,
  env: PathEnvironment = process.env,
): string {
  // The override wins on every platform: it is how `armadra.sh`, the tests and
  // an isolated second instance all point a whole stack at one directory.
  if (env.ARMADRA_DATA_DIR) return env.ARMADRA_DATA_DIR;
  // Each platform branch is conditional on its own variable and falls through
  // when that variable is absent, exactly as the Rust `cfg!` chain does.
  if (platform === "darwin" && env.HOME) {
    return join(env.HOME, "Library/Application Support/Armadra");
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "Armadra");
  }
  // Linux and everything else: XDG, then its documented default, and only if
  // there is no home at all a temporary directory — matching `lib.rs:41-47`.
  const base =
    env.XDG_DATA_HOME ??
    (env.HOME ? join(env.HOME, ".local/share") : undefined);
  return join(base ?? tmpdir(), "armadra");
}

/** The shared endpoints document both services describe themselves in. */
export function endpointsFile(
  platform: PlatformName = process.platform,
  env: PathEnvironment = process.env,
): string {
  return join(dataDir(platform, env), "endpoints.json");
}
