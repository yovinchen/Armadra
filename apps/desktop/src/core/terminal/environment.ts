import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hookEndpointFile } from "../paths";

/**
 * The environment a terminal child starts from, and the addresses an agent
 * session is told about.
 *
 * Two rules, both contractual, both easy to break by accident:
 *
 *   1. The child environment is **built, not inherited** (contract §25). The
 *      core's own environment is whatever started it: a Finder launch has
 *      almost nothing, a run from an editor's terminal carries that editor's —
 *      or another agent's — session variables, and a tmux server keeps the
 *      environment of whoever started it for as long as it lives. Every shell
 *      under such a server would then see another program's `CLAUDECODE=1`,
 *      messaging sockets and the like. So: an allow-list of user-identity and
 *      locale variables, proxies, the augmented agent PATH, and the terminal
 *      type — nothing else. Interactive shells rebuild the rest from their rc
 *      files, which is where user configuration belongs.
 *   2. Only **six** variables are injected for an agent (contract §5, item 5),
 *      and the per-node token is not one of them. Any process of the same user
 *      can read another process' environment, so the token lives in a 0600
 *      file under `<data>/node-tokens/` and the environment carries only the
 *      address of the endpoint file.
 *
 * node-pty's `env` option replaces the block wholesale, which is what this
 * module wants: there is no inheritance to opt out of.
 */

/** Variables a terminal child may inherit from the core, by exact name. */
export const INHERITED_ENV: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

export type EnvPairs = readonly (readonly [string, string])[];

/**
 * Whether a variable of the ambient environment survives into a child.
 *
 * `TMUX` and `TMUX_PANE` are the ones this repository trips over: the core is
 * developed from inside its own tmux-backed terminals, and a child that
 * inherited them would believe it is already nested inside the very session it
 * is about to drive. They are not on the allow-list, so they are dropped — the
 * test asserts that directly rather than trusting the list to be read.
 */
export function inherited(name: string): boolean {
  return (
    INHERITED_ENV.includes(name) ||
    name.toUpperCase().endsWith("_PROXY") ||
    name.toUpperCase() === "NO_PROXY"
  );
}

/**
 * Guarantees the child sees a UTF-8 locale. GUI-launched processes frequently
 * start with no `LANG` at all; shells and tmux then fall back to the C locale
 * and mangle every multi-byte character.
 */
export function withUtf8Locale(
  env: EnvPairs,
  ambient: NodeJS.ProcessEnv = process.env,
): EnvPairs {
  const isUtf8 = (value: string): boolean => {
    const lower = value.toLowerCase();
    return lower.includes("utf-8") || lower.includes("utf8");
  };
  const inheritedOk = ["LC_ALL", "LC_CTYPE", "LANG"].some((key) => {
    const value = ambient[key];
    return value !== undefined && isUtf8(value);
  });
  const overridden = env.some(
    ([key]) => key === "LANG" || key === "LC_ALL" || key === "LC_CTYPE",
  );
  if (inheritedOk || overridden) return env;
  return [
    ...env,
    ["LANG", "en_US.UTF-8"] as const,
    ["LC_CTYPE", "en_US.UTF-8"] as const,
  ];
}

function pushUnique(directories: string[], candidate: string): void {
  if (directories.includes(candidate)) return;
  try {
    if (statSync(candidate).isDirectory()) directories.push(candidate);
  } catch {
    // Not there: nothing to add.
  }
}

/**
 * `PATH` as an agent CLI needs to see it (contract §25).
 *
 * A GUI-launched process gets the launchd PATH, which has neither Homebrew nor
 * a version manager's shims on it, and the CLI the user installed with `brew`
 * or `mise` is then simply not found. The additions are appended, never
 * prepended, so a user's own tool of the same name still wins.
 */
export function agentPath(
  ambient: NodeJS.ProcessEnv = process.env,
  hookBinDirectory?: string,
): string {
  const directories = (ambient.PATH ?? "").split(delimiter).filter(Boolean);
  const home = ambient.HOME;
  if (home !== undefined) {
    pushUnique(directories, join(home, ".local/bin"));
    pushUnique(directories, join(home, ".local/share/mise/shims"));
    const installs = join(home, ".local/share/mise/installs/node");
    try {
      for (const entry of readdirSync(installs)) {
        pushUnique(directories, join(installs, entry, "bin"));
      }
    } catch {
      // No version manager on this machine.
    }
  }
  pushUnique(directories, "/opt/homebrew/bin");
  pushUnique(directories, "/usr/local/bin");
  if (hookBinDirectory !== undefined) {
    pushUnique(directories, hookBinDirectory);
  }
  return directories.join(delimiter);
}

export interface ChildEnvironmentOptions {
  readonly ambient?: NodeJS.ProcessEnv;
  /** Where `armadra-hook` lives, when R3 has told us. */
  readonly hookBin?: string | undefined;
}

/**
 * Where `armadra-hook` is on this machine, as the hook domain resolved it.
 *
 * A module-level value rather than a parameter because the callers that need
 * it are the two backends' environment builders, and one of them builds the
 * environment of a **tmux server** — a process with no session, no node and no
 * data directory to ask. Frozen into a row it would be worse: the path belongs
 * to this install, and a session recycled after an update must get the new one.
 *
 * Unset means "no bundle on this box" (a source checkout with no build), and
 * then neither the PATH entry nor `ARMADRA_HOOK_BIN` appears — an empty
 * variable would send the skill's fallback at a path that resolves to nothing.
 */
let hookClientPath: string | undefined;

export function setHookClient(path: string | undefined): void {
  hookClientPath = path;
}

export function hookClient(): string | undefined {
  return hookClientPath;
}

/**
 * The environment every terminal child starts from — the tmux server, its
 * sessions, and a direct PTY alike.
 */
export function childEnvironment(
  options: ChildEnvironmentOptions = {},
): EnvPairs {
  const ambient = options.ambient ?? process.env;
  const env: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined && inherited(key)) env.push([key, value]);
  }
  const hookBin = options.hookBin ?? hookClient();
  const hookDirectory =
    hookBin !== undefined && existsSync(hookBin)
      ? join(hookBin, "..")
      : undefined;
  env.push(["PATH", agentPath(ambient, hookDirectory)]);
  if (hookBin !== undefined) {
    // The sidecar's directory is on that PATH, but an rc file may replace PATH
    // wholesale; the skill then says to use this instead.
    env.push(["ARMADRA_HOOK_BIN", hookBin]);
  }
  // What the CLI on the other end thinks it is talking to (contract §18.3,
  // TERM row). xterm.js implements xterm-256color and renders 24-bit SGR
  // natively.
  env.push(["TERM", "xterm-256color"]);
  env.push(["COLORTERM", "truecolor"]);
  return withUtf8Locale(env, ambient);
}

/** `childEnvironment` as the record shape `node-pty` and `spawn` want. */
export function asRecord(env: EnvPairs): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of env) record[key] = value;
  return record;
}

/* ------------------------------ agent injection ---------------------------- */

/**
 * The four variables an agent terminal is told about at creation (contract §5,
 * item 5, first four). `ARMADRA_SESSION_ID` and `ARMADRA_SESSION_GENERATION`
 * are the other two and are added by {@link contextSessionEnvironment}, which
 * is where the revision sequence they index is initialised.
 *
 * `ARMADRA_NODE_NAME` joins them when this node has a name on its board
 * (`docs/design/agent-delivery.md` §2.4): the model has to be able to answer
 * "who am I, to the others?" without asking, and an unset variable is the
 * honest answer for a node nobody has named. It is not re-injected on a
 * rename — the variable is the name this session started under, and the live
 * answer is always `context list`.
 *
 * `ARMADRA_NODE_ROLE` is the same shape of answer for the other question a
 * model asks itself once links have a direction (迁移 0024): `sub` when this
 * node has a main above it, `main` when it has subs and no main, and **unset**
 * when every link is a peer. A node that is both answers `sub`, because the
 * fact that constrains what it may do is the one above it. Like the name, it
 * is the answer this session started with; the live one is `context list`.
 *
 * Addresses only. The per-node token is deliberately absent.
 */
export function agentEnvironment(
  nodeId: string,
  agentId: string,
  dataDir: string,
  nodeName?: string | undefined,
  nodeRole?: string | undefined,
): EnvPairs {
  return [
    ["ARMADRA_NODE_ID", nodeId],
    ["ARMADRA_AGENT_ID", agentId],
    ...(nodeName === undefined || nodeName === ""
      ? []
      : ([["ARMADRA_NODE_NAME", nodeName]] as EnvPairs)),
    ...(nodeRole === undefined || nodeRole === ""
      ? []
      : ([["ARMADRA_NODE_ROLE", nodeRole]] as EnvPairs)),
    ["ARMADRA_ENDPOINT_FILE", hookEndpointFile(dataDir)],
    ["ARMADRA_CANVAS_CONTROL", "1"],
  ];
}

/**
 * Adds the session identity a hook report's `terminalBinding` is keyed by, and
 * that `canvas handoff-read` / `ack` prove themselves with.
 *
 * Only for a session that has a node: without one there is nothing to
 * attribute a report to. The pair is replaced rather than appended on a
 * recycle, so a session can never carry two generations at once.
 *
 * `initializeSequence` is a parameter because a failure to initialise the
 * revision counter must never prevent a user's terminal from starting.
 */
export function contextSessionEnvironment(
  env: EnvPairs,
  sessionId: string,
  generation: number,
  initializeSequence: () => boolean = () => true,
): EnvPairs {
  const kept = env.filter(
    ([key]) =>
      key !== "ARMADRA_SESSION_ID" && key !== "ARMADRA_SESSION_GENERATION",
  );
  if (!kept.some(([key]) => key === "ARMADRA_NODE_ID")) return kept;
  if (!initializeSequence()) return kept;
  return [
    ...kept,
    ["ARMADRA_SESSION_ID", sessionId] as const,
    ["ARMADRA_SESSION_GENERATION", String(generation)] as const,
  ];
}

/** The shell a session runs when the caller named none. */
export function defaultShell(
  ambient: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  if (platform === "win32") return ambient.COMSPEC ?? "powershell.exe";
  return ambient.SHELL ?? "/bin/sh";
}
