import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  eventKey,
  configPath as codexConfigPath,
  hookHash,
  resolvedTimeout,
} from "./codex";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  COPILOT_HOOK_EVENTS,
  INTEGRATION_REVISION,
  OMP_HOOK_EVENTS,
  PI_HOOK_EVENTS,
} from "./events";
import { opencodePluginSource, piExtensionSource } from "./extension-template";
import {
  type ClientEnvironment,
  InstallError,
  type JsonObject,
  appendManagedGroup,
  configHome,
  hookCommand,
  resolveClientBinary,
  writeAtomically,
} from "./shared";
import { SKILLS_ROOT, SKILL_NAME, skillContent } from "./skills";
import {
  type TrustEntry,
  isEditable,
  readDocument,
  removeTrustState,
  stateKeys,
  writeTrustState,
} from "./toml-state";

/**
 * Canvas-only integration: the one place that decides what a CLI started from
 * the board is handed, and the one place that writes it
 * (docs/design/canvas-only-integration.md).
 *
 * The rule is "a CLI started outside the canvas is not touched at all". Every
 * hook, skill and instruction therefore lives under our data directory —
 * `<data>/integration/<cli>/` — and reaches the CLI through its launch line or
 * the environment of the canvas node's terminal. Nothing is written into a
 * CLI's own configuration, with **one** exception: Codex only runs a hook it
 * trusts, trust is only read from the user's `config.toml`, and so the
 * `trusted_hash` records for our session-flag hooks are written there once
 * ({@link trustCodexSessionHooks}). The settings page says so.
 *
 * Three functions, in the order a launch uses them:
 *
 *   * {@link prepareInjection} writes the artifacts (idempotently, byte for
 *     byte) and, for Codex, the trust records;
 *   * {@link canvasInjection} answers the argv and the environment a launch
 *     must carry — pure apart from reading which artifacts are on disk, so a
 *     list of agents can ask it on every request;
 *   * {@link removeInjection} takes all of it back.
 *
 * Every launch path — the page, dependency orchestration, the Eco wake-up, a
 * schedule's cold start, `open-agent` / `team` — gets its argv from
 * {@link canvasInjection}, through `agent/canvas-launch.ts` in the core and
 * through `GET /api/agents`'s `launchArgs` in the page. A structural test
 * (`agent/canvas-launch.test.ts`) keeps it that way.
 */

/** The CLIs that have an injection. */
export const INJECTED_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

export function isInjected(agentId: string): boolean {
  return (INJECTED_AGENTS as readonly string[]).includes(agentId);
}

/** `<data>/integration/<cli>` — everything of one CLI's injection. */
export function integrationDir(dataDir: string, agentId: string): string {
  return join(dataDir, "integration", agentId);
}

/* --------------------------------- layout --------------------------------- */

/**
 * Where each artifact of one CLI lives. Fixed, so a regeneration overwrites
 * its own files and OpenCode — which installs packages into its config
 * directory — keeps reusing the same one.
 */
export interface ArtifactLayout {
  readonly dir: string;
  /** The full `SKILL.md`. */
  readonly skill: string;
  /** The canvas instructions appended to the system prompt; not for Codex. */
  readonly instructions?: string;
  /** Claude's `--settings` file. */
  readonly settings?: string;
  /** Claude's and Copilot's `--plugin-dir`. */
  readonly pluginDir?: string;
  /** The plugin manifest inside {@link pluginDir}. */
  readonly manifest?: string;
  /** Copilot's plugin hooks file. */
  readonly pluginHooks?: string;
  /** OpenCode's `OPENCODE_CONFIG_DIR`. */
  readonly configDir?: string;
  /** The generated status reporter (OpenCode plugin, Pi / OMP extension). */
  readonly module?: string;
  /** OMP's `--config` overlay. */
  readonly overlay?: string;
  /** Pi's `--skill` directory, OMP's `customDirectories` entry. */
  readonly skillDir?: string;
  /** Copilot's `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`. */
  readonly instructionsDir?: string;
  /** The marker naming the revision and client that wrote all of the above. */
  readonly marker: string;
}

function skillUnder(root: string): string {
  return join(root, SKILLS_ROOT, SKILL_NAME, "SKILL.md");
}

export function artifactLayout(
  dataDir: string,
  agentId: string,
): ArtifactLayout {
  const dir = integrationDir(dataDir, agentId);
  const marker = join(dir, "injection.json");
  const instructions = join(dir, "instructions.md");
  switch (agentId) {
    case "claude": {
      const pluginDir = join(dir, "plugin");
      return {
        dir,
        marker,
        instructions,
        settings: join(dir, "settings.json"),
        pluginDir,
        manifest: join(pluginDir, ".claude-plugin", "plugin.json"),
        skill: skillUnder(pluginDir),
      };
    }
    case "codex":
      return { dir, marker, skill: skillUnder(dir) };
    case "opencode": {
      const configDir = join(dir, "config");
      return {
        dir,
        marker,
        instructions,
        configDir,
        module: join(configDir, "plugins", "armadra-status.js"),
        skill: skillUnder(configDir),
      };
    }
    case "pi":
    case "omp":
      return {
        dir,
        marker,
        instructions,
        module: join(dir, "armadra-status.ts"),
        skill: skillUnder(dir),
        skillDir: join(dir, SKILLS_ROOT, SKILL_NAME),
        ...(agentId === "omp" ? { overlay: join(dir, "overlay.yml") } : {}),
      };
    case "copilot": {
      const pluginDir = join(dir, "plugin");
      const instructionsDir = join(dir, "instructions");
      return {
        dir,
        marker,
        pluginDir,
        manifest: join(pluginDir, "plugin.json"),
        pluginHooks: join(pluginDir, "hooks.json"),
        skill: skillUnder(pluginDir),
        instructionsDir,
        instructions: join(
          instructionsDir,
          ".github",
          "instructions",
          "armadra.instructions.md",
        ),
      };
    }
    default:
      throw new InstallError(
        400,
        "bad_request",
        `${agentId} has no canvas injection`,
      );
  }
}

/* --------------------------------- marker --------------------------------- */

export interface InjectionMarker {
  readonly revision: number;
  /** The hook client every artifact names. */
  readonly clientBin: string;
  readonly writtenAt: string;
}

export function readMarker(
  dataDir: string,
  agentId: string,
): InjectionMarker | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(artifactLayout(dataDir, agentId).marker, "utf8"),
    ) as Partial<InjectionMarker>;
    return typeof parsed.revision === "number" &&
      typeof parsed.clientBin === "string"
      ? (parsed as InjectionMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

function isFile(path: string | undefined): path is string {
  if (path === undefined) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------ what to write ------------------------------ */

/** Seconds; the client has its own 1.5s deadline. */
const HOOK_TIMEOUT_SECONDS = 5;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Every file of one CLI's injection, path → contents. Deterministic: the same
 * revision and client produce the same bytes, so regenerating is a no-op on
 * disk.
 */
export function artifactFiles(
  dataDir: string,
  agentId: string,
  clientBin: string,
): Map<string, string> {
  const layout = artifactLayout(dataDir, agentId);
  const content = skillContent();
  const files = new Map<string, string>();
  if (content !== undefined) {
    files.set(layout.skill, content.skill());
    if (layout.instructions !== undefined) {
      const instructions = content.instructions(layout.skill);
      files.set(
        layout.instructions,
        agentId === "copilot"
          ? `---\napplyTo: "**"\n---\n\n${instructions}`
          : instructions,
      );
    }
  }
  const manifest = {
    name: "armadra",
    description: "Armadra canvas collaboration — loaded only for canvas nodes.",
    version: String(INTEGRATION_REVISION),
  };
  switch (agentId) {
    case "claude": {
      const events: JsonObject = {};
      appendManagedGroup(events, CLAUDE_HOOK_EVENTS, {
        type: "command",
        command: hookCommand(clientBin, agentId),
        timeout: HOOK_TIMEOUT_SECONDS,
      });
      files.set(layout.settings as string, json({ hooks: events }));
      files.set(layout.manifest as string, json(manifest));
      break;
    }
    case "codex":
      // Codex's hooks and instructions are all on the launch line.
      break;
    case "opencode":
      files.set(
        layout.module as string,
        opencodePluginSource(agentId, clientBin),
      );
      break;
    case "pi":
    case "omp":
      files.set(
        layout.module as string,
        piExtensionSource(
          agentId,
          clientBin,
          agentId === "omp" ? OMP_HOOK_EVENTS : PI_HOOK_EVENTS,
        ),
      );
      if (layout.overlay !== undefined) {
        files.set(
          layout.overlay,
          `skills:\n  customDirectories:\n    - ${JSON.stringify(join(layout.dir, SKILLS_ROOT))}\n`,
        );
      }
      break;
    case "copilot": {
      // `preToolUse` stays out: it is Copilot's one blocking event, and a
      // missing client would turn into "every tool call refused".
      const entry: JsonObject = {
        type: "command",
        bash: hookCommand(clientBin, agentId),
        ...(process.platform === "win32"
          ? { powershell: `& ${hookCommand(clientBin, agentId)}` }
          : {}),
        timeoutSec: HOOK_TIMEOUT_SECONDS,
      };
      const hooks: JsonObject = {};
      for (const event of COPILOT_HOOK_EVENTS) hooks[event] = [{ ...entry }];
      files.set(layout.pluginHooks as string, json({ version: 1, hooks }));
      files.set(
        layout.manifest as string,
        json({ ...manifest, hooks: "hooks.json", skills: "skills/" }),
      );
      break;
    }
    default:
      break;
  }
  return files;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Writes what differs; answers the paths written. */
function writeFiles(files: Map<string, string>): string[] {
  const written: string[] = [];
  for (const [path, contents] of files) {
    if (readOrEmpty(path) === contents) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeAtomically(path, contents);
    written.push(path);
  }
  return written;
}

/* ------------------------------ Codex's trust ------------------------------ */

/**
 * The key Codex files a hook passed with `-c hooks.<Event>=…` under: the
 * literal pseudo-path `/<session-flags>/config.toml`, the snake-case event,
 * then group and handler index. Read off `codex app-server`'s `hooks/list` on
 * Codex 0.155.1; ours is always the only group of its event on the line, so
 * both indices are 0.
 */
export const CODEX_SESSION_KEY_PREFIX = "/<session-flags>/config.toml:";

function codexEvents(): string[] {
  return CODEX_HOOK_EVENTS.filter((event) => eventKey(event) !== undefined);
}

/** `(key, trusted_hash)` for every session-flag hook we pass. */
export function codexSessionTrust(command: string): TrustEntry[] {
  return codexEvents().map((event) => {
    const key = eventKey(event) as string;
    return {
      key: `${CODEX_SESSION_KEY_PREFIX}${key}:0:0`,
      hash: hookHash(key, undefined, command, resolvedTimeout(event)),
    };
  });
}

export interface TrustReport {
  readonly path: string;
  readonly changed: boolean;
}

/**
 * Writes the trust records into `<CODEX_HOME>/config.toml` — the one write
 * outside our data directory. Idempotent; a `config.toml` this line editor
 * could mangle is refused rather than rewritten.
 */
export function trustCodexSessionHooks(
  codexHome: string,
  command: string,
): TrustReport {
  const path = codexConfigPath(codexHome);
  const document = readDocument(path);
  if (!isEditable(document)) {
    throw new InstallError(
      409,
      "conflict",
      `${path} is not valid TOML; refusing to rewrite it`,
    );
  }
  const next = writeTrustState(document, codexSessionTrust(command));
  if (next === document) return { path, changed: false };
  writeAtomically(path, next);
  return { path, changed: true };
}

/** Takes our session-flag trust records back out of `config.toml`. */
export function untrustCodexSessionHooks(codexHome: string): TrustReport {
  const path = codexConfigPath(codexHome);
  const document = readDocument(path);
  if (document === "") return { path, changed: false };
  const ours = codexEvents().map(
    (event) => `${CODEX_SESSION_KEY_PREFIX}${eventKey(event) as string}:0:0`,
  );
  const surviving = stateKeys(document).filter((key) => !ours.includes(key));
  const next = removeTrustState(document, CODEX_SESSION_KEY_PREFIX, surviving);
  if (next === document) return { path, changed: false };
  writeAtomically(path, next);
  return { path, changed: true };
}

/** Whether every one of our trust records is present with the current hash. */
export function codexTrusted(codexHome: string, command: string): boolean {
  const document = readDocument(codexConfigPath(codexHome));
  return writeTrustState(document, codexSessionTrust(command)) === document;
}

/* --------------------------------- prepare -------------------------------- */

export interface InjectionOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: ClientEnvironment;
  /** Codex's config home; resolved from the environment when absent. */
  readonly codexHome?: string;
  readonly now?: () => Date;
  /** Rewrite even when the marker says the artifacts are current. */
  readonly force?: boolean;
  /** Leave Codex's `config.toml` alone this time (no Codex here yet). */
  readonly skipTrust?: boolean;
}

export interface PrepareReport {
  readonly agentId: string;
  readonly clientBin: string;
  /** Artifact paths whose bytes changed. */
  readonly written: readonly string[];
  /** Codex only: the trust records in the user's `config.toml`. */
  readonly trust?: TrustReport;
}

/**
 * The switch that keeps a process from touching any CLI's global
 * configuration (the one-time migration and Codex's trust records). The test
 * suite sets it: its cores run with the developer's real `HOME`.
 */
export function globalWritesDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.ARMADRA_NO_GLOBAL_WRITES === "1";
}

function current(
  dataDir: string,
  agentId: string,
): InjectionMarker | undefined {
  const marker = readMarker(dataDir, agentId);
  if (marker === undefined || marker.revision !== INTEGRATION_REVISION) {
    return undefined;
  }
  if (!isFile(marker.clientBin)) return undefined;
  const layout = artifactLayout(dataDir, agentId);
  const expected = [
    layout.settings,
    layout.module,
    layout.pluginHooks,
    layout.manifest,
    layout.overlay,
    ...(skillContent() === undefined
      ? []
      : [layout.skill, layout.instructions]),
  ].filter((path): path is string => path !== undefined);
  return expected.every(isFile) ? marker : undefined;
}

/**
 * Makes one CLI's injection current: artifacts written for this revision and
 * this client, and — for Codex — the trust records in place. Cheap when
 * nothing moved: a marker read, a few `stat`s, one `config.toml` read.
 */
export function prepareInjection(
  agentId: string,
  options: InjectionOptions,
): PrepareReport {
  const env = options.env ?? process.env;
  const fresh =
    options.force === true ? undefined : current(options.dataDir, agentId);
  let clientBin: string;
  let written: string[] = [];
  if (fresh !== undefined) {
    clientBin = fresh.clientBin;
  } else {
    clientBin = resolveClientBinary({
      env,
      launcher: { dataDir: options.dataDir },
      ...options.client,
    });
    written = writeFiles(artifactFiles(options.dataDir, agentId, clientBin));
    const marker: InjectionMarker = {
      revision: INTEGRATION_REVISION,
      clientBin,
      writtenAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    writeAtomically(
      artifactLayout(options.dataDir, agentId).marker,
      json(marker),
    );
  }
  if (
    agentId !== "codex" ||
    options.skipTrust === true ||
    globalWritesDisabled(env)
  ) {
    return { agentId, clientBin, written };
  }
  const home = options.codexHome ?? configHome("codex", env);
  const trust = trustCodexSessionHooks(home, hookCommand(clientBin, agentId));
  return { agentId, clientBin, written, trust };
}

/**
 * Removes one CLI's artifacts, and Codex's trust records. What the settings
 * page's removal and the tests use; a normal launch never needs it.
 */
export function removeInjection(
  agentId: string,
  options: InjectionOptions,
): void {
  rmSync(artifactLayout(options.dataDir, agentId).dir, {
    recursive: true,
    force: true,
  });
  const env = options.env ?? process.env;
  if (agentId === "codex" && !globalWritesDisabled(env)) {
    untrustCodexSessionHooks(options.codexHome ?? configHome("codex", env));
  }
}

/* --------------------------------- inject --------------------------------- */

export interface InjectionRequest {
  readonly dataDir: string;
  /** The built-in id — a `custom:` entry resolves to its base first. */
  readonly agentId: string;
  /** The canvas node; carried in the environment, never in the argv. */
  readonly nodeId?: string;
  /**
   * A resumed session. Every CLI measured needs the same argv again on
   * resume, so this changes nothing today; it is part of the request so a
   * CLI that ever differs is answered here and nowhere else.
   */
  readonly resume?: boolean;
}

export interface Injection {
  /**
   * Appended after the CLI's own flags, each value exactly as the CLI should
   * receive it — for a caller that execs the CLI itself.
   */
  readonly args: readonly string[];
  /**
   * The same, as words for a line typed into the node's shell: quoted where
   * needed, and for Codex referring to {@link env} rather than spelling the
   * values out (see {@link codexWords}). Every canvas launch line uses these.
   */
  readonly words: readonly string[];
  /** Merged into the canvas node's terminal environment. */
  readonly env: readonly (readonly [string, string])[];
}

const NOTHING: Injection = { args: [], words: [], env: [] };

/** POSIX single quotes, only when the word needs them. */
export function shellWord(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The environment variables Codex's typed line expands. */
export const CODEX_HOOK_VAR = "ARMADRA_CODEX_HOOK";
export const CODEX_INSTRUCTIONS_VAR = "ARMADRA_CODEX_INSTRUCTIONS";

/**
 * Codex's `-c` pairs as typed words, with the long values left in the
 * environment.
 *
 * Spelled out, eight hook tables naming the client plus the instructions come
 * to several kilobytes, and a line that long typed into a fresh shell is cut
 * off: the PTY's input queue holds about a kilobyte while the line editor is
 * still echoing (measured in the canvas, 2026-09-26 — the Codex nodes sat on a
 * half-typed line). So the node's terminal carries the values
 * ({@link CODEX_HOOK_VAR}: one hook table, the same for every event;
 * {@link CODEX_INSTRUCTIONS_VAR}: the instructions as a TOML string) and the
 * line only names them, double-quoted so the shell expands them into single
 * words. A shell whose environment predates this build expands them to
 * nothing, and Codex refuses the empty value with an error on screen rather
 * than starting without hooks.
 */
export function codexWords(withInstructions: boolean): string[] {
  const words = ["-c", "check_for_update_on_startup=false"];
  for (const event of codexEvents()) {
    words.push("-c", `"hooks.${event}=$${CODEX_HOOK_VAR}"`);
  }
  if (withInstructions) {
    words.push("-c", `"developer_instructions=$${CODEX_INSTRUCTIONS_VAR}"`);
  }
  return words;
}

/** One hook table for Codex: `[{hooks=[{type="command",command=…}]}]`. */
function codexHookTable(command: string): string {
  return `[{hooks=[{type="command",command=${tomlString(command)}}]}]`;
}

/** A TOML basic string; JSON's escapes are a subset TOML accepts. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The `-c` pairs Codex gets: the hooks, the instructions, no update prompt. */
export function codexArgs(command: string, instructions?: string): string[] {
  const args = [
    // The start-up "Update now?" prompt takes the first task as its answer
    // (Enter = upgrade). Key read off Codex 0.155.1 and checked in its TUI.
    "-c",
    "check_for_update_on_startup=false",
  ];
  for (const event of codexEvents()) {
    args.push("-c", `hooks.${event}=${codexHookTable(command)}`);
  }
  if (instructions !== undefined) {
    // Appended as a developer message; `model_instructions_file` would
    // replace the base prompt instead.
    args.push("-c", `developer_instructions=${tomlString(instructions)}`);
  }
  return args;
}

/**
 * What a canvas launch of `agentId` carries. Empty until
 * {@link prepareInjection} has run for it — a flag pointing at a file that is
 * not there is an error the CLI prints on every start, which is worse than
 * starting with nothing.
 */
export function canvasInjection(request: InjectionRequest): Injection {
  const literal = literalInjection(request);
  if (literal === undefined) return NOTHING;
  if (request.agentId !== "codex") {
    return { ...literal, words: literal.args.map(shellWord) };
  }
  const marker = readMarker(request.dataDir, "codex") as InjectionMarker;
  const layout = artifactLayout(request.dataDir, "codex");
  const content = skillContent();
  const instructions =
    isFile(layout.skill) && content !== undefined
      ? content.developerInstructions(layout.skill)
      : undefined;
  return {
    args: literal.args,
    words: codexWords(instructions !== undefined),
    env: [
      [CODEX_HOOK_VAR, codexHookTable(hookCommand(marker.clientBin, "codex"))],
      ...(instructions === undefined
        ? []
        : ([[CODEX_INSTRUCTIONS_VAR, tomlString(instructions)]] as const)),
    ],
  };
}

/** The argv and environment, before they are turned into typed words. */
function literalInjection(
  request: InjectionRequest,
): Omit<Injection, "words"> | undefined {
  if (!isInjected(request.agentId)) return undefined;
  const marker = readMarker(request.dataDir, request.agentId);
  if (marker === undefined) return undefined;
  const layout = artifactLayout(request.dataDir, request.agentId);
  const skill = isFile(layout.skill);
  const instructions = isFile(layout.instructions)
    ? layout.instructions
    : undefined;
  switch (request.agentId) {
    case "claude":
      return {
        args: [
          ...(isFile(layout.settings) ? ["--settings", layout.settings] : []),
          ...(isFile(layout.manifest)
            ? ["--plugin-dir", layout.pluginDir as string]
            : []),
          ...(instructions === undefined
            ? []
            : ["--append-system-prompt-file", instructions]),
        ],
        env: [],
      };
    case "codex": {
      const content = skillContent();
      return {
        args: codexArgs(
          hookCommand(marker.clientBin, "codex"),
          skill && content !== undefined
            ? content.developerInstructions(layout.skill)
            : undefined,
        ),
        env: [],
      };
    }
    case "opencode":
      return {
        args: [],
        env: [
          ["OPENCODE_CONFIG_DIR", layout.configDir as string],
          ...(instructions === undefined
            ? []
            : ([
                [
                  "OPENCODE_CONFIG_CONTENT",
                  JSON.stringify({ instructions: [instructions] }),
                ],
              ] as const)),
        ],
      };
    case "pi":
      return {
        args: [
          ...(isFile(layout.module) ? ["--extension", layout.module] : []),
          ...(skill ? ["--skill", layout.skillDir as string] : []),
          ...(instructions === undefined
            ? []
            : ["--append-system-prompt", instructions]),
        ],
        env: [],
      };
    case "omp":
      return {
        args: [
          ...(isFile(layout.module) ? [`--extension=${layout.module}`] : []),
          ...(skill && isFile(layout.overlay)
            ? [`--config=${layout.overlay}`]
            : []),
          ...(instructions === undefined
            ? []
            : [`--append-system-prompt=${instructions}`]),
        ],
        env: [],
      };
    case "copilot":
      return {
        args: isFile(layout.manifest)
          ? ["--plugin-dir", layout.pluginDir as string]
          : [],
        env:
          instructions === undefined
            ? []
            : [
                [
                  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
                  layout.instructionsDir as string,
                ],
              ],
      };
    default:
      return undefined;
  }
}
