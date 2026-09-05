import { z } from "zod";

import {
  PERMISSION_MODES,
  permissionModeSchema,
  type PermissionMode,
} from "./domain.js";

/**
 * Agent registry — see docs/v3-agent-terminal-plan.md §5.1.
 *
 * Pure data plus one pure function. An "agent" is a CLI that we start inside a
 * terminal node; nothing here spawns a process, and the runtime keeps only a
 * mirror of the ids and launch programs (apps/runtime/src/agent.rs).
 */

export const AGENT_IDS = [
  "claude",
  "codex",
  "gemini",
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
 * every component (docs/agent-automation-design.md §1).
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
 */
export const AGENT_CAPABILITIES = [
  "hooks",
  "resume",
  "subagent",
  "contextLink",
  "usage",
  "contextUsage",
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
        "usage",
        "contextUsage",
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
      // `contextUsage` here is the *estimated* kind: codex writes a structured
      // rollout we can read, but reports no live window of its own.
      capabilities: [
        "hooks",
        "resume",
        "subagent",
        "contextLink",
        "contextUsage",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["codex"],
    },
    gemini: {
      id: "gemini",
      label: "Gemini CLI",
      color: "#4285f4",
      launchCmd: "gemini",
      promptMode: "flag-prompt",
      promptFlag: "--prompt-interactive",
      permissionFlag: {
        default: [],
        "auto-edit": ["--approval-mode", "auto_edit"],
        "full-auto": ["--approval-mode", "yolo"],
        plan: ["--approval-mode", "plan"],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--resume" },
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "contextUsage",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["gemini"],
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
      capabilities: ["resume", "contextLink", "supportsModelSelection"],
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
      capabilities: ["resume", "contextLink", "supportsModelSelection"],
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
      capabilities: ["resume", "contextLink", "supportsModelSelection"],
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
 * anything else (apps/runtime/src/settings.rs), including the `ARMADRA_*` names
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
 * Build the launch line for an agent node. Order: program → permission mode →
 * model → pre-minted session id → extra args → prompt (plan §5.1).
 */
export function assembleLaunchCommand(
  input: AssembleLaunchCommandInput,
): LaunchCommand {
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

  const parts: string[] = [shellQuote(program)];

  // Resume comes before everything else. Codex's `resume` is a subcommand, and
  // a subcommand that follows a flag is a parse error; the flag-style CLIs do
  // not care where it sits, so one position serves all three.
  const resumeId = input.resume?.trim();
  if (resumeId && custom?.disabledCapabilities?.includes("resume")) {
    throw new Error("Session resume is disabled for this custom agent");
  }
  const resume = resumeId ? base.resume : undefined;
  if (resumeId && resume) {
    if (resume.style === "positional") {
      parts.push(resume.verb, shellQuote(resumeId));
    } else {
      parts.push(resume.flag, shellQuote(resumeId));
    }
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
  for (const flag of base.permissionFlag[permissionMode]) {
    parts.push(shellQuote(flag));
  }

  if (input.model && base.modelFlag) {
    parts.push(base.modelFlag, shellQuote(input.model));
  }

  // `--session-id` mints a new session; asking for both is a contradiction and
  // claude rejects the pair outright, so resume silently wins.
  if (input.sessionId && base.sessionIdFlag && !(resumeId && resume)) {
    parts.push(base.sessionIdFlag, shellQuote(input.sessionId));
  }

  // The custom entry's own argv comes first: it is part of how that program is
  // invoked (`npx -y my-cli`), while `extraArgs` is a per-launch addition.
  for (const arg of [...(custom?.args ?? []), ...(input.extraArgs ?? [])]) {
    parts.push(shellQuote(arg));
  }

  const prompt = input.prompt ? collapsePrompt(input.prompt) : "";
  let stdinPrompt: string | undefined;
  if (prompt) {
    switch (custom?.promptMode ?? base.promptMode) {
      case "argv":
        parts.push(shellQuote(prompt));
        break;
      case "flag-prompt":
        parts.push(base.promptFlag ?? "--prompt", shellQuote(prompt));
        break;
      case "stdin-after-start":
        stdinPrompt = prompt;
        break;
    }
  }

  return {
    command: parts.join(" "),
    ...(stdinPrompt ? { stdinPrompt } : {}),
  };
}
