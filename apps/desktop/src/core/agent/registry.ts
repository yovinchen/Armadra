import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { agentPath } from "../terminal/environment";

/**
 * The six agent CLIs this build knows, and what each of them can do.
 *
 * Ported from the pre-merge implementation. Only what the core needs lives here
 * — ids, labels, launch programs and capabilities. The canonical registry
 * (flags, prompt assembly, hook events) stays in `packages/shared`; the launch
 * line is assembled in the web app and typed into the PTY.
 *
 * Gemini is not in this list and is not coming back: migration 0014 retired it.
 */

export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_CAPABILITIES = [
  "hooks",
  // May drive a linked browser node's session. A custom Agent can switch it
  // off; nothing can switch it on for a base adapter that does not declare it.
  "browser",
  "resume",
  "subagent",
  "contextLink",
  "usage",
  "nativeRecurrence",
  "structuredInputAck",
  "supportsModelSelection",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/* ------------------------------ state sources ----------------------------- */

/** A command Hook the CLI forked: `armadra-hook <provider>` over `hook.sock`. */
export const STATE_SOURCE_HOOK = "hook";
/**
 * An extension inside the CLI's own process, speaking the same HTTP on the
 * same socket. Same bearer, same node token, same terminal binding — it is the
 * in-process form of the command Hook, not a more trusted one.
 */
export const STATE_SOURCE_EXTENSION = "extension";
/**
 * The PTY-side guess for a terminal with no adapter at all. A display-level
 * hint and nothing more; see {@link stateSourceIsReported}.
 */
export const OBSERVED = "observed";

export const AGENT_STATE_SOURCES = [
  STATE_SOURCE_HOOK,
  STATE_SOURCE_EXTENSION,
  OBSERVED,
] as const;

/**
 * Which channel a provider's status reports arrive on.
 *
 * A property of how that adapter is installed, not of the request: an
 * extension and a command Hook post the same body with the same headers, so
 * trusting a client's own claim would let any of them name the strongest
 * source. `undefined` is a provider with no adapter.
 */
export function stateSourceFor(provider: string): string | undefined {
  switch (provider) {
    case "claude":
    case "codex":
    case "copilot":
      return STATE_SOURCE_HOOK;
    // Pi, Oh My Pi and opencode report from a module inside the CLI's own
    // process. Same socket, same bearer, same node token: a different
    // transport, not a different authority.
    case "pi":
    case "omp":
    case "opencode":
      return STATE_SOURCE_EXTENSION;
    default:
      return undefined;
  }
}

/**
 * Whether a source is a *report* rather than a guess.
 *
 * The one question every gate has to ask. `hook` and `extension` are two
 * transports for the same authenticated report and both count; `observed` and
 * "nothing has reported" do not — an observation may never satisfy the
 * scheduler's idle gate. Written here, once, so a later caller cannot
 * accidentally spell it as "the source is set".
 */
export function stateSourceIsReported(source: string | null | undefined) {
  return source === STATE_SOURCE_HOOK || source === STATE_SOURCE_EXTENSION;
}

/* -------------------------------- definitions ------------------------------ */

export interface AgentDefinition {
  readonly id: AgentId;
  readonly label: string;
  readonly color: string;
  readonly launchCmd: string;
  readonly promptMode: string;
  readonly capabilities: readonly AgentCapability[];
}

export const AGENT_REGISTRY: readonly AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    color: "#d97757",
    launchCmd: "claude",
    promptMode: "argv",
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
  },
  {
    id: "codex",
    label: "Codex",
    color: "#10a37f",
    launchCmd: "codex",
    promptMode: "argv",
    capabilities: [
      "hooks",
      "resume",
      "subagent",
      "contextLink",
      "browser",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    color: "#a78bfa",
    launchCmd: "opencode",
    promptMode: "flag-prompt",
    capabilities: [
      "hooks",
      "resume",
      "contextLink",
      "browser",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "pi",
    label: "Pi",
    color: "#e8b86d",
    launchCmd: "pi",
    promptMode: "argv",
    // `hooks` means "there is a status source", not "there is a hooks key in a
    // settings file": Pi's is an in-process extension on the same socket.
    capabilities: [
      "hooks",
      "resume",
      "browser",
      "contextLink",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "omp",
    label: "Oh My Pi",
    color: "#d4a373",
    launchCmd: "omp",
    promptMode: "argv",
    // Same extension API as Pi, under its own config home.
    capabilities: [
      "hooks",
      "resume",
      "browser",
      "contextLink",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    color: "#a371f7",
    launchCmd: "copilot",
    promptMode: "flag-prompt",
    // A command hook like Claude's.
    capabilities: [
      "hooks",
      "resume",
      "browser",
      "contextLink",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
];

export function definition(agentId: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((agent) => agent.id === agentId);
}

/** Whether an id names a built-in agent or a `custom:` entry. */
export function validAgentId(agentId: string): boolean {
  if (definition(agentId) !== undefined) return true;
  const suffix = agentId.startsWith("custom:")
    ? agentId.slice("custom:".length)
    : undefined;
  return suffix !== undefined && suffix.length > 0 && suffix.length <= 64;
}

/* ------------------------------ custom agents ------------------------------ */

/**
 * A `settings.agents.custom[]` entry, as the settings domain stores it.
 *
 * Structural rather than imported so the agent domain does not have to know
 * which module the settings document is parsed in; the fields are the ones
 * the pre-merge implementation defines.
 */
export interface CustomAgent {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
  readonly launchCmd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly baseAgent: string;
  readonly disabledCapabilities?: readonly string[];
  /**
   * How this entry's first prompt reaches it, overriding its base's shape.
   *
   * `packages/shared` has carried this field since custom agents existed
   * (`customAgentSchema`); the core did not, so an entry that declared
   * `stdin-after-start` — "never put it on the launch line" — got its prompt
   * put on the launch line (设计 `agent-delivery.md` §8.2 E2).
   */
  readonly promptMode?: "argv" | "flag-prompt" | "stdin-after-start";
}

/** The settings this domain reads. Injected, so a test can pass a literal. */
export interface AgentSettings {
  customAgents(): readonly CustomAgent[];
}

export const NO_CUSTOM_AGENTS: AgentSettings = { customAgents: () => [] };

export function customAgent(
  settings: AgentSettings,
  agentId: string,
): CustomAgent | undefined {
  return settings.customAgents().find((custom) => custom.id === agentId);
}

/** The built-in whose adapter an id borrows. A built-in is its own base. */
export function baseAgent(settings: AgentSettings, agentId: string): string {
  return customAgent(settings, agentId)?.baseAgent ?? agentId;
}

/**
 * Capability narrowing concerns application features, not manual CLI commands
 * and not workspace authorization (which remains a separate check).
 *
 * A custom entry may disable its base's capabilities; it cannot grant another
 * adapter's abilities merely by changing its label or launch program, and an
 * entry whose base is not a known agent has no capabilities at all.
 */
export function hasCapability(
  settings: AgentSettings,
  agentId: string,
  capability: string,
): boolean {
  if (!agentId.startsWith("custom:")) {
    return (
      definition(agentId)?.capabilities.includes(
        capability as AgentCapability,
      ) === true
    );
  }
  const custom = customAgent(settings, agentId);
  if (custom === undefined) return false;
  const base = definition(custom.baseAgent);
  if (base === undefined) return false;
  if (!base.capabilities.includes(capability as AgentCapability)) return false;
  return !(custom.disabledCapabilities ?? []).includes(capability);
}

/* -------------------------------- detection -------------------------------- */

/** One `GET /api/agents` row, as far as this domain fills it in. */
export interface AgentInfo {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly launchCmd: string;
  readonly promptMode: string;
  readonly capabilities: readonly string[];
  /** Extra argv the launch line appends after the flags. Built-ins: empty. */
  readonly args: readonly string[];
  /** The built-in a `custom:` entry borrows from; absent on the built-ins. */
  readonly baseAgent?: string;
  readonly resolvedPath: string | null;
  readonly installed: boolean;
}

function infoOf(agent: AgentDefinition): AgentInfo {
  const resolved = resolveCommand(agent.launchCmd);
  return {
    id: agent.id,
    label: agent.label,
    color: agent.color,
    launchCmd: agent.launchCmd,
    promptMode: agent.promptMode,
    capabilities: [...agent.capabilities],
    args: [],
    resolvedPath: resolved ?? null,
    installed: resolved !== undefined,
  };
}

/**
 * A `settings.agents.custom[]` entry as a row.
 *
 * The base supplies prompt behaviour, colour and available capabilities. The
 * colour in particular is the base's, so a custom Claude reads as Claude on
 * the canvas; `settings.color` is only the settings-page dot.
 */
export function customInfo(custom: CustomAgent): AgentInfo {
  const base = definition(custom.baseAgent);
  const resolved = resolveCommand(custom.launchCmd);
  const disabled = custom.disabledCapabilities ?? [];
  const info: AgentInfo = {
    id: custom.id,
    label: custom.label,
    color: base?.color ?? (AGENT_REGISTRY[0] as AgentDefinition).color,
    launchCmd: custom.launchCmd,
    promptMode: base?.promptMode ?? "argv",
    capabilities:
      base === undefined
        ? []
        : base.capabilities.filter(
            (capability) => !disabled.includes(capability),
          ),
    args: [...(custom.args ?? [])],
    resolvedPath: resolved ?? null,
    installed: resolved !== undefined,
  };
  return base === undefined ? info : { ...info, baseAgent: base.id };
}

/** Probe every built-in agent against the augmented PATH. */
export function detect(): AgentInfo[] {
  return AGENT_REGISTRY.map(infoOf);
}

/**
 * Resolve `command` against the same PATH used to launch agent CLIs.
 *
 * A command that already carries a path separator (`/opt/bin/claude`,
 * `./wrapper.sh`) is never searched for on PATH — that is what a custom agent
 * pointing at a script outside PATH looks like, and joining it onto every PATH
 * entry would only produce nonsense.
 */
export function resolveCommand(
  command: string,
  ambient: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command === "") return undefined;
  const looksLikePath =
    isAbsolute(command) || command.includes("/") || command.includes(sep);
  if (looksLikePath) {
    return isExecutable(command) ? command : withPlatformSuffix(command);
  }
  for (const directory of agentPath(ambient).split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
    const suffixed = withPlatformSuffix(candidate);
    if (suffixed !== undefined) return suffixed;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function withPlatformSuffix(candidate: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  for (const extension of [".exe", ".cmd", ".bat"]) {
    const path = `${candidate}${extension}`;
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not there: try the next one.
    }
  }
  return undefined;
}
