import {
  type AgentSettings,
  baseAgent,
  customAgent,
  definition,
  hasCapability,
} from "./registry";

/**
 * What a session of one agent has to be started with, as pure functions.
 *
 * The whole module is deliberately side-effect free. Nothing here spawns
 * anything, reads a file or touches the database: the terminal domain owns the
 * PTY and the environment injection, and this is the set of *answers* it asks
 * for — which flags this CLI takes for a permission mode, how it is told to
 * resume, whether a custom entry has had a capability switched off.
 *
 * Two rules from AGENTS.md live here and nowhere else:
 *
 *   * **Each CLI keeps its own account, model and permission policy.** A mode
 *     the CLI has no flag for produces *no flag*, not the nearest one: `plan`
 *     on Pi is an empty list because Pi has no persistent read-only mode, and
 *     inventing one would silently change what the user's agent is allowed to
 *     do.
 *   * **A custom entry inherits, it does not acquire.** `disabledCapabilities`
 *     can only subtract from the base adapter's list. An entry that disabled
 *     `resume` may not be resumed even though its base can be, and an entry
 *     whose base is unknown can do nothing at all.
 *
 * The environment half of "what a session starts with" is not duplicated here:
 * `core/terminal/environment.ts` already exports `agentEnvironment` (the four
 * address variables) and `contextSessionEnvironment` (the two session ones),
 * and a second copy would be a second answer.
 */

export const PERMISSION_MODES = [
  "default",
  "auto-edit",
  "full-auto",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * How the first prompt reaches a CLI, mirroring `packages/shared`'s
 * `PROMPT_MODES`:
 *
 *   * `argv`               positional argument on the launch line;
 *   * `flag-prompt`        behind a dedicated flag ({@link LaunchProfile.promptFlag});
 *   * `stdin-after-start`  typed into the TUI once it is up, never on the line.
 */
export const PROMPT_MODES = [
  "argv",
  "flag-prompt",
  "stdin-after-start",
] as const;

export type PromptMode = (typeof PROMPT_MODES)[number];

/** How a CLI is told to continue an existing session. */
export type ResumeStyle =
  /** `claude --resume <id>` — a flag anywhere after the program. */
  | { readonly style: "flag"; readonly flag: string }
  /** `codex resume <id> --model …` — a subcommand before every flag. */
  | { readonly style: "positional"; readonly verb: string };

interface LaunchProfile {
  readonly permissionFlag: Readonly<Record<PermissionMode, readonly string[]>>;
  readonly modelFlag?: string;
  readonly sessionIdFlag?: string;
  readonly resume?: ResumeStyle;
  /** `flag-prompt` CLIs take the first prompt behind a flag. */
  readonly promptFlag?: string;
}

/**
 * The per-CLI launch shapes, mirroring `packages/shared/src/agents.ts`.
 *
 * It is a mirror rather than an import because the core has no dependency on
 * `@armadra/shared` — the same reason `registry.ts` re-states the capability
 * lists. The test asserts the two agree on every id.
 */
const PROFILES: Readonly<Record<string, LaunchProfile>> = {
  claude: {
    permissionFlag: {
      default: [],
      "auto-edit": ["--permission-mode", "acceptEdits"],
      "full-auto": ["--dangerously-skip-permissions"],
      plan: ["--permission-mode", "plan"],
    },
    modelFlag: "--model",
    sessionIdFlag: "--session-id",
    resume: { style: "flag", flag: "--resume" },
  },
  codex: {
    permissionFlag: {
      default: [],
      "auto-edit": ["--full-auto"],
      "full-auto": ["--dangerously-bypass-approvals-and-sandbox"],
      plan: ["--sandbox", "read-only"],
    },
    modelFlag: "--model",
    resume: { style: "positional", verb: "resume" },
  },
  opencode: {
    permissionFlag: {
      default: [],
      "auto-edit": [],
      "full-auto": [],
      plan: [],
    },
    modelFlag: "--model",
    resume: { style: "flag", flag: "--session" },
    promptFlag: "--prompt",
  },
  // Pi has no built-in approval or plan flag; its own tool policy is preserved.
  pi: {
    permissionFlag: {
      default: [],
      "auto-edit": [],
      "full-auto": [],
      plan: [],
    },
    modelFlag: "--model",
    resume: { style: "flag", flag: "--session" },
  },
  omp: {
    permissionFlag: {
      default: [],
      "auto-edit": ["--approval-mode", "write"],
      "full-auto": ["--approval-mode", "yolo"],
      // `--plan` selects a model and `--plan-yolo` auto-approves execution.
      // Neither is an equivalent of a persistent read-only permission mode.
      plan: [],
    },
    modelFlag: "--model",
    resume: { style: "flag", flag: "--resume" },
  },
  copilot: {
    permissionFlag: {
      default: [],
      "auto-edit": ["--allow-tool=write"],
      "full-auto": ["--allow-all"],
      plan: ["--plan"],
    },
    modelFlag: "--model",
    resume: { style: "flag", flag: "--resume" },
    promptFlag: "--interactive",
  },
};

export function launchProfile(agentId: string): LaunchProfile | undefined {
  return PROFILES[agentId];
}

/**
 * The permission modes this agent really has a flag for.
 *
 * `default` is always in the list: "run the CLI the way the user configured
 * it" is something every CLI supports by definition. The others are listed
 * only when the profile maps them to at least one flag, which is what stops
 * the UI offering a mode that would quietly do nothing.
 */
export function supportedPermissionModes(
  agentId: string,
): readonly PermissionMode[] {
  const profile = PROFILES[agentId];
  if (profile === undefined) return ["default"];
  return PERMISSION_MODES.filter(
    (mode) => mode === "default" || profile.permissionFlag[mode].length > 0,
  );
}

/** Whether this id may be resumed at all, capabilities included. */
export function canResume(settings: AgentSettings, agentId: string): boolean {
  if (!hasCapability(settings, agentId, "resume")) return false;
  return PROFILES[baseAgent(settings, agentId)]?.resume !== undefined;
}

/** Whether a model may be chosen for this id. */
export function canSelectModel(
  settings: AgentSettings,
  agentId: string,
): boolean {
  if (!hasCapability(settings, agentId, "supportsModelSelection")) return false;
  return PROFILES[baseAgent(settings, agentId)]?.modelFlag !== undefined;
}

export interface LaunchRequest {
  readonly agentId: string;
  readonly permissionMode?: string;
  readonly model?: string;
  /** Continue this provider session; wins over {@link sessionId}. */
  readonly resume?: string;
  /** Pre-mint the provider session id, for a CLI that takes one. */
  readonly sessionId?: string;
  /** The first prompt, for a CLI that takes one on the command line. */
  readonly prompt?: string;
}

export interface LaunchPlan {
  /** The program to run — the custom entry's own, or the built-in's. */
  readonly program: string;
  readonly args: readonly string[];
  /** Why something the caller asked for was not applied. */
  readonly omitted: readonly string[];
}

export class LaunchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRefused";
  }
}

/**
 * Turns a launch request into argv.
 *
 * Order matters and is not cosmetic: codex's `resume` is a subcommand that has
 * to precede every flag, so resume is emitted first for everyone. A request
 * that names both `resume` and `sessionId` keeps the resume — claude rejects
 * the pair outright, so letting resume win is the only reading in which the
 * session actually continues.
 */
export function planLaunch(
  settings: AgentSettings,
  request: LaunchRequest,
): LaunchPlan {
  const custom = customAgent(settings, request.agentId);
  const base = definition(baseAgent(settings, request.agentId));
  if (base === undefined) {
    throw new LaunchRefused(`不认识的 agent \`${request.agentId}\``);
  }
  const profile = PROFILES[base.id] as LaunchProfile;
  const program = custom?.launchCmd ?? base.launchCmd;
  const args: string[] = [];
  const omitted: string[] = [];

  const resumeId = request.resume?.trim();
  if (resumeId !== undefined && resumeId !== "") {
    if (!canResume(settings, request.agentId)) {
      throw new LaunchRefused("Session resume is disabled for this agent");
    }
    const resume = profile.resume as ResumeStyle;
    args.push(resume.style === "positional" ? resume.verb : resume.flag);
    args.push(resumeId);
  }

  const mode = (request.permissionMode ?? "default") as PermissionMode;
  if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new LaunchRefused(`Unknown permission mode: ${mode}`);
  }
  if (!supportedPermissionModes(base.id).includes(mode)) {
    throw new LaunchRefused(
      `${base.label} does not support permission mode: ${mode}`,
    );
  }
  args.push(...profile.permissionFlag[mode]);

  const model = request.model?.trim();
  if (model !== undefined && model !== "") {
    if (canSelectModel(settings, request.agentId)) {
      args.push(profile.modelFlag as string, model);
    } else {
      omitted.push("modelSelectionUnavailable");
    }
  }

  const sessionId = request.sessionId?.trim();
  if (
    sessionId !== undefined &&
    sessionId !== "" &&
    profile.sessionIdFlag !== undefined &&
    (resumeId === undefined || resumeId === "")
  ) {
    args.push(profile.sessionIdFlag, sessionId);
  }

  // The custom entry's own extra argv sits after the flags this core derived,
  // so a user's `--foo` cannot displace a permission flag it does not know
  // about — it can only follow it.
  args.push(...(custom?.args ?? []));

  const prompt = request.prompt?.trim();
  if (prompt !== undefined && prompt !== "") {
    // The same three shapes `launchCommand` uses, for the same reason: a CLI
    // that declares `stdin-after-start` is saying the launch line is the one
    // place this text must not go (§8.2 E2).
    switch (promptModeFor(settings, request.agentId)) {
      case "flag-prompt":
        args.push(profile.promptFlag ?? "--prompt", prompt);
        break;
      case "argv":
        args.push(prompt);
        break;
      default:
        omitted.push("promptNotOnLaunchLine");
        break;
    }
  }

  return { program, args, omitted };
}

/**
 * The launch *line* the `open-agent` control verb writes into a new node.
 *
 * A shell line rather than argv, because the terminal node types it into a
 * shell rather than exec'ing it — which is also why the prompt is single
 * quoted. The core only knows the program and the prompt shape here; the model
 * and the permission mode are the canvas's business and arrive through
 * {@link planLaunch} when the user starts the session.
 *
 * `settings` is not decoration (设计 `agent-delivery.md` §8.2 E1/E2). A
 * `custom:` id has no row in {@link PROFILES}, so resolving the prompt shape
 * from the raw id used to drop every custom entry into the positional branch:
 * an entry whose base is Copilot got a bare positional argument, which on that
 * CLI means `-p` — non-interactive, and gone as soon as it finishes. The base
 * is resolved the same way {@link planLaunch} resolves it, and the entry's own
 * `promptMode` wins over the base's, exactly as `packages/shared` reads it.
 *
 * `stdin-after-start` produces **no prompt on the line at all**: that mode is
 * a declaration that this CLI can only be told things after its TUI is up, so
 * putting the text on the launch line is the one thing it says not to do.
 */
export function launchCommand(
  settings: AgentSettings,
  agentId: string,
  prompt?: string,
): string {
  const custom = customAgent(settings, agentId);
  const base = baseAgent(settings, agentId);
  const program =
    custom?.launchCmd ??
    (agentId.startsWith("custom:")
      ? agentId.slice("custom:".length)
      : (definition(agentId)?.launchCmd ?? agentId));
  const text = prompt?.trim();
  if (text === undefined || text === "") return program;
  const mode = promptModeFor(settings, agentId);
  if (mode === "stdin-after-start") return program;
  const flag = PROFILES[base]?.promptFlag;
  return flag === undefined || mode !== "flag-prompt"
    ? `${program} ${quote(text)}`
    : `${program} ${flag} ${quote(text)}`;
}

/**
 * How the first prompt reaches this id's CLI, custom entries included.
 *
 * Mirrors `packages/shared`'s `custom?.promptMode ?? base.promptMode`; a
 * custom entry whose base is unknown has no shape at all, and an unknown shape
 * is treated as "nothing on the line" rather than guessed into a positional.
 */
export function promptModeFor(
  settings: AgentSettings,
  agentId: string,
): PromptMode {
  const custom = customAgent(settings, agentId);
  if (custom?.promptMode !== undefined) return custom.promptMode;
  const mode = definition(baseAgent(settings, agentId))?.promptMode;
  return (PROMPT_MODES as readonly string[]).includes(mode ?? "")
    ? (mode as PromptMode)
    : "stdin-after-start";
}

/** Single quotes, because the line is typed into a shell rather than exec'd. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * argv[0] basenames that mean "this pane is still running that agent".
 *
 * The pane gate's vocabulary. A `custom:<name>` entry has no registry row, so
 * the suffix is the best guess there is — and a guess is enough here, because
 * the gate only ever refuses, never grants.
 */
export function expectedProcesses(agentId: string): string[] {
  if (definition(agentId) !== undefined) return [agentId];
  const suffix = agentId.startsWith("custom:")
    ? agentId.slice("custom:".length)
    : "";
  return suffix === "" ? [] : [suffix];
}

/**
 * The pane gate: is the foreground of this PTY still the agent we think it is?
 *
 * Nothing writes prose into somebody else's terminal, but two callers still
 * need the answer: the scheduler, before it starts a prompt the user
 * scheduled, and `interrupt`, before it sends an Escape.
 */
export function paneRunsAgent(
  foreground: { readonly command?: string; readonly children?: string[] },
  expected: readonly string[],
): boolean {
  if (expected.length === 0) return false;
  const haystacks: string[] = [];
  if (foreground.command !== undefined) haystacks.push(foreground.command);
  haystacks.push(...(foreground.children ?? []));
  return haystacks.some((line) =>
    expected.some((name) => lineNamesProgram(line, name)),
  );
}

/**
 * `claude` matches `claude`, `/opt/bin/claude --resume` and
 * `node /usr/lib/claude/cli.js`, but not `claude-code-notifier`.
 */
function lineNamesProgram(line: string, name: string): boolean {
  return line.split(/[\s/\\]+/).some((raw) => {
    const token = raw.endsWith(".exe") ? raw.slice(0, -4) : raw;
    return token === name || token === `${name}.js`;
  });
}
