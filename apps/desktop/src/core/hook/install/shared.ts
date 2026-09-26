import { writeLauncher } from "../../../cli/armadra-hook/launcher";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLIENT_NAME } from "./events";

/**
 * What every installer shares: where a CLI keeps its configuration, how a
 * command of ours is recognised, and the JSON manipulation the two grouped
 * formats need.
 *
 * Each provider keeps its hook configuration in a file the user also edits by
 * hand, so every installer obeys the same three rules:
 *
 *   * **recognise, do not remember.** An entry is ours when its command
 *     mentions the `armadra-hook` binary. Nothing is keyed on a marker we wrote
 *     earlier, so a half-finished install, a restored backup or a hand-copied
 *     entry all reconcile correctly.
 *   * **rewrite only ours.** Foreign entries — including foreign entries for
 *     the same event — survive install, reinstall and uninstall untouched.
 *   * **append last.** Our group goes at the end of each event's list, so the
 *     indices of existing entries never shift. That matters for Codex, whose
 *     trust state is keyed by index.
 *
 * Installing twice must produce a byte-identical file; the tests assert it.
 */

/** A refusal a route turns into `{ code, message }`. */
export class InstallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** What removing one CLI's old global hook install did. */
export interface InstallReport {
  readonly agentId: string;
  /** The file we wrote (or removed our entries from). */
  readonly configPath: string;
  /** Absolute path of the hook client the entries invoke. */
  readonly clientBin?: string;
  readonly clientRevision: number;
  readonly installed: boolean;
  /** Something worked but deserves a sentence in the settings page. */
  readonly warning?: string;
}

/** The "nothing is installed" answer, used by every uninstaller. */
export function removedReport(
  agentId: string,
  configPath: string,
  clientRevision: number,
): InstallReport {
  return {
    agentId,
    configPath,
    clientRevision,
    installed: false,
  };
}

/* ------------------------------ the client -------------------------------- */

export interface ClientEnvironment {
  readonly env?: NodeJS.ProcessEnv;
  /** Where the shell put this build; the sidecar sits beside it. */
  readonly executableDir?: string;
  /** `PATH` lookup, injectable so the resolution can be tested. */
  readonly onPath?: (name: string) => string | undefined;
  /**
   * The TypeScript client. When the bundle is found, a launcher is written
   * under `<dataDir>/bin` and *that* becomes the installed command — the
   * bundle is JavaScript, and the CLIs run hooks through a shell that has no
   * interpreter for it except the one this process runs on.
   */
  readonly launcher?: ClientLauncher;
}

export interface ClientLauncher {
  readonly dataDir: string;
  /** Where to look for `armadra-hook.js`; defaults cover the packaged and the built tree. */
  readonly bundleCandidates?: readonly string[];
  /** The runner the launcher execs; defaults to this process' executable. */
  readonly runner?: string;
  /** The built `armadra-hook.exe`; defaults to the one beside the bundle. */
  readonly windowsExe?: string;
  /** Which launcher to write; defaults to this process' platform (tests). */
  readonly platform?: NodeJS.Platform;
}

/** The places a built `armadra-hook.js` can be, in the order they are tried. */
export function defaultBundleCandidates(): string[] {
  const candidates: string[] = [];
  if (process.resourcesPath !== undefined)
    candidates.push(join(process.resourcesPath, "cli", "armadra-hook.js"));
  candidates.push(join(dirname(process.execPath), "cli", "armadra-hook.js"));
  // `out/core/main.js` → `out/cli/armadra-hook.js`; the source tree has no
  // bundle, and a test that wants one passes it explicitly.
  candidates.push(join(__dirname, "..", "cli", "armadra-hook.js"));
  return candidates;
}

/**
 * Writes the launcher for the TypeScript client and returns its path, or
 * `undefined` when no bundle is present (a source checkout running the core
 * with `node` and no build).
 */
export function launcherClientBinary(
  launcher: ClientLauncher,
): string | undefined {
  const bundle = (launcher.bundleCandidates ?? defaultBundleCandidates()).find(
    isFile,
  );
  if (bundle === undefined) return undefined;
  const platform = launcher.platform ?? process.platform;
  return writeLauncher(
    join(launcher.dataDir, "bin"),
    {
      runner: launcher.runner ?? process.execPath,
      bundle,
      // after-pack builds `armadra-hook.exe` beside the bundle; without it the
      // launcher is the `.cmd`, which `cmd.exe` re-parses (launcher.ts).
      ...(platform === "win32"
        ? {
            windowsExe:
              launcher.windowsExe ??
              join(dirname(bundle), `${CLIENT_NAME}.exe`),
          }
        : {}),
    },
    platform,
  );
}

/**
 * The sidecar's file names. On Windows the launcher is `armadra-hook.exe`
 * (a console program that runs the bundle on the shell's own Electron without
 * going through `cmd.exe`), with the `.cmd` as the fallback a build without
 * the `.exe` installs. The `armadra-hook` substring is preserved either way,
 * which is what {@link isManagedCommand} recognises.
 */
function clientFileNames(): string[] {
  return process.platform === "win32"
    ? [`${CLIENT_NAME}.exe`, `${CLIENT_NAME}.cmd`]
    : [CLIENT_NAME];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The first executable named `name` on `PATH`, or `undefined`. */
export function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const separator = process.platform === "win32" ? ";" : ":";
  for (const directory of (env.PATH ?? "").split(separator)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Where the hook client lives. In order: an explicit override, the sidecar
 * next to this executable, then the PATH.
 *
 * It is resolved once at install time and the absolute path is written into
 * the configuration, because the CLIs run hooks through a shell whose PATH is
 * not the core's.
 */
export function resolveClientBinary(options: ClientEnvironment = {}): string {
  const env = options.env ?? process.env;
  const override = env.ARMADRA_HOOK_BIN;
  if (override !== undefined && override !== "") {
    if (isFile(override)) return override;
    throw new InstallError(
      400,
      "bad_request",
      `ARMADRA_HOOK_BIN does not point at a file: ${override}`,
    );
  }
  if (options.launcher !== undefined) {
    const written = launcherClientBinary(options.launcher);
    if (written !== undefined) return written;
  }
  const directory = options.executableDir ?? dirname(process.execPath);
  for (const name of clientFileNames()) {
    const sidecar = join(directory, name);
    if (isFile(sidecar)) return sidecar;
  }
  const onPath = options.onPath ?? ((name) => resolveOnPath(name, env));
  for (const name of clientFileNames()) {
    const found = onPath(name);
    if (found !== undefined) return found;
  }
  throw new InstallError(
    404,
    "not_found",
    `Could not find the ${CLIENT_NAME} client next to the core or on PATH`,
  );
}

/**
 * The command string a hook entry runs. The binary is quoted only when it has
 * to be: an unquoted path is what a user comparing two configs expects to see.
 */
export function hookCommand(clientBin: string, agentId: string): string {
  return clientBin.includes(" ")
    ? `"${clientBin}" ${agentId}`
    : `${clientBin} ${agentId}`;
}

/** True when this command was written by us — see the module note. */
export function isManagedCommand(command: string): boolean {
  return command.includes(CLIENT_NAME);
}

/* ------------------------------ config homes ------------------------------ */

export type FromEnv = (name: string) => string | undefined;

export function envReader(env: NodeJS.ProcessEnv = process.env): FromEnv {
  return (name) => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined || home === "") {
    throw new InstallError(
      500,
      "internal",
      "No home directory to install hooks into",
    );
  }
  return home;
}

/**
 * A profile name that is safe to put in a path. OMP's own rules are stricter
 * (it also rejects reserved Windows device names); anything this lets through
 * that OMP would not simply resolves to a directory OMP never reads, which
 * costs a wasted install and never a write outside the config home.
 */
function isProfileName(profile: string): boolean {
  return (
    !profile.includes("/") &&
    !profile.includes("\\") &&
    profile.length > 0 &&
    profile.length <= 64 &&
    profile !== "default" &&
    /^[A-Za-z0-9_-]+$/.test(profile)
  );
}

function singleSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return !value.includes("/") && !value.includes("\\") ? value : undefined;
}

/**
 * The resolution rules, with the environment passed in so they can be tested
 * without mutating a process-global the rest of the suite also reads.
 *
 * Each CLI's own override is honoured so a user running with a redirected
 * config home does not get a second, unread configuration in `~`.
 */
export function configHomeWith(
  agentId: string,
  fromEnv: FromEnv,
  home: string,
): string {
  switch (agentId) {
    case "claude":
      return fromEnv("CLAUDE_CONFIG_DIR") ?? join(home, ".claude");
    case "codex":
      return fromEnv("CODEX_HOME") ?? join(home, ".codex");
    // Copilot's own override, documented alongside `~/.copilot/hooks/`.
    case "copilot":
      return fromEnv("COPILOT_HOME") ?? join(home, ".copilot");
    case "opencode": {
      const explicit = fromEnv("OPENCODE_CONFIG_DIR");
      if (explicit !== undefined) return explicit;
      const xdg = fromEnv("XDG_CONFIG_HOME");
      if (xdg !== undefined) return join(xdg, "opencode");
      return join(home, ".config", "opencode");
    }
    // Pi's own `ENV_AGENT_DIR`. The extensions directory hangs off the *agent*
    // directory (`~/.pi/agent`), not the config root.
    case "pi":
      return fromEnv("PI_CODING_AGENT_DIR") ?? join(home, ".pi", "agent");
    // OMP reads the same override, plus a profile that wins over it and a
    // configurable root name — `~/.omp/profiles/<name>/agent`.
    case "omp": {
      const root = join(
        home,
        singleSegment(fromEnv("PI_CONFIG_DIR")) ?? ".omp",
      );
      const profile = [fromEnv("OMP_PROFILE"), fromEnv("PI_PROFILE")].find(
        (value) => value !== undefined && isProfileName(value),
      );
      if (profile !== undefined)
        return join(root, "profiles", profile, "agent");
      return fromEnv("PI_CODING_AGENT_DIR") ?? join(root, "agent");
    }
    default:
      throw new InstallError(
        400,
        "bad_request",
        `${agentId} has no hook installer`,
      );
  }
}

export function configHome(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configHomeWith(agentId, envReader(env), homeDir(env));
}

/* ------------------------- shared JSON manipulation ------------------------ */

/**
 * Reads a JSON settings file. A missing file is an empty object; a corrupt one
 * is an error, because overwriting a file we could not understand would throw
 * away the user's configuration.
 */
export function readJsonObject(path: string): JsonObject {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (contents.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new InstallError(
      409,
      "conflict",
      `${path} is not valid JSON (${describe(error)}); refusing to overwrite it`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InstallError(
      409,
      "conflict",
      `${path} is not a JSON object; refusing to overwrite it`,
    );
  }
  return parsed as JsonObject;
}

/**
 * Pretty-printed (two spaces, trailing newline) and written tmp + rename, so a
 * CLI reading the file concurrently never sees half of it.
 */
export function writeJsonObject(path: string, value: JsonObject): void {
  writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeAtomically(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.armadra-tmp`);
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, path);
}

export function removeFileIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lifts `hooks` out of a document so it can be edited as a map. A `hooks` key
 * that is not an object is replaced rather than merged: the CLI could not read
 * it either.
 */
export function takeEvents(document: JsonObject): JsonObject {
  const events = document.hooks;
  delete document.hooks;
  return isObject(events) ? events : {};
}

/**
 * The `{ "<Event>": [ { "matcher"?, "hooks": [...] } ] }` shape Claude and
 * Codex both use. Removes every handler whose command is ours, drops the
 * groups that are left empty, and returns how many handlers went away.
 */
export function stripManagedHandlers(events: JsonObject): number {
  let removed = 0;
  for (const [event, value] of Object.entries(events)) {
    if (!Array.isArray(value)) continue;
    for (const group of value) {
      if (!isObject(group)) continue;
      const handlers = group.hooks;
      if (!Array.isArray(handlers)) continue;
      const before = handlers.length;
      group.hooks = handlers.filter(
        (handler) =>
          !(
            isObject(handler) &&
            typeof handler.command === "string" &&
            isManagedCommand(handler.command)
          ),
      );
      removed += before - (group.hooks as JsonValue[]).length;
    }
    // A group whose only handler was ours has nothing left to say.
    const kept = value.filter((group) => {
      if (!isObject(group)) return true;
      const handlers = group.hooks;
      return !Array.isArray(handlers) || handlers.length > 0;
    });
    if (kept.length === 0) delete events[event];
    else events[event] = kept;
  }
  return removed;
}

/**
 * Appends one managed group to each listed event, creating the event arrays as
 * needed. Always appended last so foreign indices are stable.
 */
export function appendManagedGroup(
  events: JsonObject,
  names: readonly string[],
  handler: JsonObject,
): void {
  for (const name of names) {
    const existing = events[name];
    const groups = Array.isArray(existing) ? existing : [];
    groups.push({ hooks: [{ ...handler }] });
    events[name] = groups;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
