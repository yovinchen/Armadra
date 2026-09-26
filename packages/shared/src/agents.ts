import { z } from "zod";

import {
  PERMISSION_MODES,
  permissionModeSchema,
  type PermissionMode,
} from "./domain/index.js";

/**
 * Agent registry — see docs/contracts/v3-agent-terminal-plan.md §5.1.
 *
 * Pure data plus one pure function. An "agent" is a CLI that we start inside a
 * terminal node; nothing here spawns a process, and the runtime keeps only a
 * mirror of the ids and launch programs .
 */

export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;
export type BuiltinAgentId = (typeof AGENT_IDS)[number];

/**
 * How the first prompt reaches the CLI:
 * - `argv`               positional argument on the launch line
 * - `flag-prompt`        passed through a dedicated flag (`promptFlag`)
 * - `stdin-after-start`  typed into the TUI once it is up (never on the line)
 */
export const PROMPT_MODES = [
  "argv",
  "flag-prompt",
  "stdin-after-start",
] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

/**
 * What an adapter can do, as a composed set rather than a per-CLI branch in
 * every component (docs/design/agent-automation-design.md §1).
 *
 * The three later entries were added with the M2 capability work:
 *
 *   * `nativeRecurrence` — the CLI runs loops/cron of its own that we can
 *     *observe*. No built-in adapter claims it yet: none of the seven exposes a
 *     readable job list, and §1 forbids inferring a capability from a name. The
 *     vocabulary exists so an adapter that gains one can declare it.
 *   * `structuredInputAck` — a delivered prompt can be tied back to the turn it
 *     produced, which is what §5 rule 5 needs before a dispatch may be called
 *     delivered. Only the four hook adapters have that channel.
 *   * `supportsModelSelection` — the CLI takes a model on its launch line, so
 *     the node header may offer one. Every built-in has a `modelFlag`, but the
 *     capability is still narrowed by version probing and the execution host.
 *   * `browser` — the adapter may drive a controlled browser session (B01,
 *     docs/design/editor-browser-design.md §7). The verb travels the same hook client
 *     channel as `contextLink`, so every adapter with a link has it too; the
 *     grant is still checked per action, the capability only says the channel
 *     exists.
 */
export const AGENT_CAPABILITIES = [
  "hooks",
  "resume",
  "subagent",
  "contextLink",
  "browser",
  "usage",
  "nativeRecurrence",
  "structuredInputAck",
  "supportsModelSelection",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export interface AgentDefinition {
  readonly id: BuiltinAgentId;
  readonly label: string;
  /** Brand colour — plan §3.4. */
  readonly color: string;
  /** Program name looked up on the augmented PATH. */
  readonly launchCmd: string;
  readonly promptMode: PromptMode;
  /** Only meaningful when `promptMode === "flag-prompt"`. */
  readonly promptFlag?: string;
  /** Permission mode → extra argv. An empty list means "CLI default". */
  readonly permissionFlag: Readonly<Record<PermissionMode, readonly string[]>>;
  readonly modelFlag?: string;
  /** Set when we may pre-mint the session id instead of learning it from a hook. */
  readonly sessionIdFlag?: string;
  /**
   * How this CLI is told to continue an existing session (plan §17). A flag
   * (`--resume`) is appended after the program; `"positional"` means the id
   * follows a bare subcommand that has to come before every flag, which is
   * codex's shape (`codex resume <id> --model …`). Absent = cannot resume.
   */
  readonly resume?:
    | { readonly style: "flag"; readonly flag: string }
    | { readonly style: "positional"; readonly verb: string };
  readonly capabilities: readonly AgentCapability[];
  /** argv[0] basenames accepted when checking that a PTY still runs this agent. */
  readonly expectedProcess: readonly string[];
}

export const AGENT_REGISTRY: Readonly<Record<BuiltinAgentId, AgentDefinition>> =
  {
    claude: {
      id: "claude",
      label: "Claude Code",
      color: "#d97757",
      launchCmd: "claude",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--permission-mode", "acceptEdits"],
        "full-auto": ["--dangerously-skip-permissions"],
        plan: ["--permission-mode", "plan"],
      },
      modelFlag: "--model",
      sessionIdFlag: "--session-id",
      resume: { style: "flag", flag: "--resume" },
      capabilities: [
        "hooks",
        "resume",
        "subagent",
        "contextLink",
        "browser",
        "usage",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["claude"],
    },
    codex: {
      id: "codex",
      label: "Codex",
      color: "#10a37f",
      launchCmd: "codex",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--full-auto"],
        "full-auto": ["--dangerously-bypass-approvals-and-sandbox"],
        plan: ["--sandbox", "read-only"],
      },
      modelFlag: "--model",
      resume: { style: "positional", verb: "resume" },
      capabilities: [
        "hooks",
        "resume",
        "subagent",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["codex"],
    },
    opencode: {
      id: "opencode",
      label: "OpenCode",
      color: "#a78bfa",
      launchCmd: "opencode",
      promptMode: "flag-prompt",
      promptFlag: "--prompt",
      permissionFlag: {
        default: [],
        "auto-edit": [],
        "full-auto": [],
        plan: [],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--session" },
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["opencode"],
    },
    pi: {
      id: "pi",
      label: "Pi",
      color: "#e8b86d",
      launchCmd: "pi",
      promptMode: "argv",
      // Pi has no built-in approval/plan flag. Preserve its own tool policy.
      permissionFlag: {
        default: [],
        "auto-edit": [],
        "full-auto": [],
        plan: [],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--session" },
      // Pi has no command hooks; its status source is an in-process TS
      // extension on the same `hook.sock`, which is the same three layers of
      // authentication over a different transport
      // (docs/design/agent-collaboration-channels.md §3.1 channel B). So
      // `hooks` here means "there is a status source", not "there is a
      // `hooks` key in a settings file".
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["pi"],
    },
    omp: {
      id: "omp",
      label: "Oh My Pi",
      color: "#d4a373",
      launchCmd: "omp",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--approval-mode", "write"],
        "full-auto": ["--approval-mode", "yolo"],
        // --plan selects a model; --plan-yolo auto-approves execution. Neither
        // is an equivalent of a persistent read-only plan permission mode.
        plan: [],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--resume" },
      // Same extension API as Pi, under `~/.omp/agent/extensions/`.
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["omp"],
    },
    copilot: {
      id: "copilot",
      label: "GitHub Copilot",
      color: "#a371f7",
      launchCmd: "copilot",
      promptMode: "flag-prompt",
      promptFlag: "--interactive",
      permissionFlag: {
        default: [],
        "auto-edit": ["--allow-tool=write"],
        "full-auto": ["--allow-all"],
        plan: ["--plan"],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--resume" },
      // Copilot's status source is a command hook like Claude's, written to
      // `~/.copilot/hooks/armadra.json`.
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["copilot"],
    },
  };

export const AGENT_LIST: readonly AgentDefinition[] = AGENT_IDS.map(
  (id) => AGENT_REGISTRY[id],
);

export function isAgentId(value: unknown): value is BuiltinAgentId {
  return (
    typeof value === "string" &&
    (AGENT_IDS as readonly string[]).includes(value)
  );
}

export function agentDefinition(id: string): AgentDefinition | undefined {
  return isAgentId(id) ? AGENT_REGISTRY[id] : undefined;
}

/** Only expose permission modes backed by a real CLI argument. */
export function supportedPermissionModes(
  agentId: string,
): readonly PermissionMode[] {
  const definition = agentDefinition(agentId);
  return PERMISSION_MODES.filter(
    (mode) =>
      mode === "default" || (definition?.permissionFlag[mode].length ?? 0) > 0,
  );
}

/**
 * Environment variable name. The runtime enforces the same shape and drops
 * anything else , including the `ARMADRA_*` names
 * the hook client owns — a custom agent must not be able to redirect its own
 * hook reports.
 */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const MAX_ENV_VALUE = 4_096;

export const customAgentEnvSchema = z.record(
  z
    .string()
    .regex(ENV_KEY_PATTERN)
    .refine((key) => !key.startsWith("ARMADRA_"), {
      message: "ARMADRA_* is reserved for the hook client",
    }),
  z.string().max(MAX_ENV_VALUE),
);

/** A user-defined CLI that borrows a built-in agent's hook adapter. */
export const customAgentSchema = z.object({
  id: z.string().regex(/^custom:[A-Za-z0-9._:-]{1,64}$/),
  label: z.string().min(1).max(80),
  color: z.string().min(1).max(32).default("#a78bfa"),
  launchCmd: z.string().min(1).max(1_024),
  args: z.array(z.string().max(1_024)).max(64).default([]),
  /**
   * Extra environment for the PTY, merged by the runtime when the terminal is
   * created — never written onto the launch line, where it would end up in the
   * user's shell history. Values may reference the runtime's own environment
   * with `${env:VAR}` / `${env:VAR:fallback}`.
   */
  env: customAgentEnvSchema.optional(),
  /** Which built-in agent's hook/prompt behaviour this custom entry reuses. */
  baseAgent: z.enum(AGENT_IDS).default("claude"),
  disabledCapabilities: z
    .array(z.enum(AGENT_CAPABILITIES))
    .max(AGENT_CAPABILITIES.length)
    .optional(),
  promptMode: z.enum(PROMPT_MODES).optional(),
  permissionMode: permissionModeSchema.optional(),
});

export type CustomAgent = z.infer<typeof customAgentSchema>;

export function inheritedAgentCapabilities(
  custom: Pick<CustomAgent, "baseAgent" | "disabledCapabilities">,
): readonly AgentCapability[] {
  const base = agentDefinition(custom.baseAgent);
  return (
    base?.capabilities.filter(
      (capability) => !custom.disabledCapabilities?.includes(capability),
    ) ?? []
  );
}

/* ------------------------------ launch line ------------------------------ */

export interface AssembleLaunchCommandInput {
  agentId: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  sessionId?: string;
  /**
   * Continue an existing session instead of starting a new one — the id comes
   * from the conversations index (`GET /api/conversations`). Ignored by agents
   * without a `resume` entry, and it wins over `sessionId`: pre-minting an id
   * and reopening one are mutually exclusive requests.
   */
  resume?: string;
  /** Absolute path or alternative program from settings; replaces `launchCmd`. */
  programOverride?: string;
  /** Extra argv appended after the flags (custom agents). */
  extraArgs?: readonly string[];
  /**
   * Words appended to the *typed* line as they are, after everything quoted:
   * the canvas injection the runtime answers as `launchWords`, which may
   * expand environment variables of the node's terminal. Not part of
   * {@link assembleLaunchArgv} — a frozen plan never carries the injection.
   */
  shellWords?: readonly string[];
  /** Prompt/permission behaviour to use when `agentId` is a `custom:` id. */
  baseAgent?: BuiltinAgentId;
  /**
   * The `settings.agents.custom[]` entry `agentId` names. It supplies the
   * program and the leading extra argv, and its `baseAgent` decides how the
   * prompt, the permission mode and resuming are expressed.
   *
   * Its `env` is deliberately *not* used here: the launch line is typed into a
   * shell, so a `VAR=value` prefix would land in the user's shell history. The
   * runtime merges it into the PTY environment instead.
   */
  custom?: CustomAgent;
}

export interface LaunchCommand {
  /** The single line written into the shell followed by Enter. */
  command: string;
  /**
   * Prompt that must be typed into the CLI *after* it is ready
   * (`promptMode: "stdin-after-start"`), never part of `command`.
   */
  stdinPrompt?: string;
}

const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote escaping: `it's` → `'it'\''s'`. */
export function shellQuote(value: string): string {
  if (value.length > 0 && SAFE_ARGUMENT.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The prompt is *typed into a shell*, not exec'd, so it must be a single line;
 * newlines and other control characters collapse to spaces.
 */
export function collapsePrompt(prompt: string): string {
  return prompt
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The launch line before it is turned into shell text: the program and the
 * argv that follows it, each value exactly as the CLI should receive it.
 *
 * This is the shape a background scheduler freezes into a plan. It stores the
 * argv and nothing else, so the executor resolves the program from the agent
 * id against its own registry and a stored plan can never become "run this
 * binary". Quoting is a property of writing into a shell, not of the launch.
 */
export interface LaunchArgv {
  program: string;
  args: string[];
  stdinPrompt?: string;
}

/**
 * Build the launch argv for an agent node. Order: program → permission mode →
 * model → pre-minted session id → extra args → prompt (plan §5.1).
 */
export function assembleLaunchArgv(
  input: AssembleLaunchCommandInput,
): LaunchArgv {
  const custom = input.custom;
  const base = input.agentId.startsWith("custom:")
    ? custom?.baseAgent || input.baseAgent
      ? AGENT_REGISTRY[custom?.baseAgent ?? input.baseAgent!]
      : undefined
    : agentDefinition(input.agentId);
  if (!base) {
    throw new Error(`Unknown agent id: ${input.agentId}`);
  }

  const program = (
    input.programOverride ??
    custom?.launchCmd ??
    base.launchCmd
  ).trim();
  if (!program) {
    throw new Error(`Agent ${input.agentId} has no launch program`);
  }

  const args: string[] = [];

  // Resume comes before everything else. Codex's `resume` is a subcommand, and
  // a subcommand that follows a flag is a parse error; the flag-style CLIs do
  // not care where it sits, so one position serves all three.
  const resumeId = input.resume?.trim();
  if (resumeId && custom?.disabledCapabilities?.includes("resume")) {
    throw new Error("Session resume is disabled for this custom agent");
  }
  const resume = resumeId ? base.resume : undefined;
  if (resumeId && resume) {
    args.push(resume.style === "positional" ? resume.verb : resume.flag);
    args.push(resumeId);
  }

  const permissionMode = input.permissionMode ?? "default";
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`Unknown permission mode: ${permissionMode}`);
  }
  if (!supportedPermissionModes(base.id).includes(permissionMode)) {
    throw new Error(
      `${base.label} does not support permission mode: ${permissionMode}`,
    );
  }
  args.push(...base.permissionFlag[permissionMode]);

  if (input.model && base.modelFlag) {
    args.push(base.modelFlag, input.model);
  }

  // `--session-id` mints a new session; asking for both is a contradiction and
  // claude rejects the pair outright, so resume silently wins.
  if (input.sessionId && base.sessionIdFlag && !(resumeId && resume)) {
    args.push(base.sessionIdFlag, input.sessionId);
  }

  // The custom entry's own argv comes first: it is part of how that program is
  // invoked (`npx -y my-cli`), while `extraArgs` is a per-launch addition.
  args.push(...(custom?.args ?? []), ...(input.extraArgs ?? []));

  const prompt = input.prompt ? collapsePrompt(input.prompt) : "";
  let stdinPrompt: string | undefined;
  if (prompt) {
    switch (custom?.promptMode ?? base.promptMode) {
      case "argv":
        args.push(prompt);
        break;
      case "flag-prompt":
        args.push(base.promptFlag ?? "--prompt", prompt);
        break;
      case "stdin-after-start":
        stdinPrompt = prompt;
        break;
    }
  }

  return { program, args, ...(stdinPrompt ? { stdinPrompt } : {}) };
}

/**
 * The same launch as one line of shell text. Quoting happens here and only
 * here, so the argv above stays the values the CLI actually receives.
 */
export function assembleLaunchCommand(
  input: AssembleLaunchCommandInput,
): LaunchCommand {
  const { program, args, stdinPrompt } = assembleLaunchArgv(input);
  // The prompt, when it is on the line, stays last: the injected words go in
  // front of it. How many words it took is what the same launch without it
  // lacks — one positional, or a flag and its value.
  const withoutPrompt = input.prompt
    ? assembleLaunchArgv({ ...input, prompt: undefined }).args.length
    : args.length;
  const quoted = [program, ...args].map(shellQuote);
  const tail = quoted.splice(1 + withoutPrompt);
  return {
    command: [...quoted, ...(input.shellWords ?? []), ...tail].join(" "),
    ...(stdinPrompt ? { stdinPrompt } : {}),
  };
}
