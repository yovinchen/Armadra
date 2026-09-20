/**
 * `settings.agents.custom[]` — sanitising user-defined CLI entries.
 *
 * Ported from the pre-merge implementation. The rules enforced here
 * are the ones `customAgentSchema` states in `packages/shared/src/agents.ts`;
 * entries that break them are **dropped** rather than rejected, so one bad
 * hand-edit cannot make the whole settings file unreadable.
 *
 * The `${env:…}` expansion the Rust module also carries belongs to whoever
 * starts a PTY, and arrives with the terminal domain. Only the part the
 * settings document itself needs — what survives a load — is here.
 */

import { clone, isJsonObject, type JsonObject, type JsonValue } from "./local";

/**
 * The built-in agents a `custom:` entry may borrow its hook adapter, prompt
 * mode and permission flags from. The registry itself (launch lines, flags)
 * belongs to the agent domain; a custom entry only needs to know that the base
 * exists.
 */
export const BUILTIN_AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

/** What a base adapter may declare, and therefore what a custom entry may narrow. */
export const AGENT_CAPABILITIES = [
  "hooks",
  "browser",
  "resume",
  "subagent",
  "contextLink",
  "usage",
  "nativeRecurrence",
  "structuredInputAck",
  "supportsModelSelection",
] as const;

/**
 * How the first prompt reaches a custom entry's CLI, mirroring
 * `customAgentSchema.promptMode` in `packages/shared`. An entry that declares
 * `stdin-after-start` must never see its prompt on the launch line.
 */
export const PROMPT_MODES = [
  "argv",
  "flag-prompt",
  "stdin-after-start",
] as const;

export type PromptMode = (typeof PROMPT_MODES)[number];

/** How many custom agents a settings file may hold. */
export const MAX_CUSTOM_AGENTS = 64;
const MAX_CUSTOM_LABEL = 80;
const MAX_CUSTOM_COMMAND = 1_024;
const MAX_CUSTOM_ARGS = 64;
const MAX_CUSTOM_ENV_VARS = 64;
/**
 * Cap on one environment value. A PTY child's whole environment has an OS
 * limit; one variable must not eat it.
 */
export const MAX_CUSTOM_ENV_VALUE = 4_096;
const DEFAULT_CUSTOM_COLOR = "#a78bfa";
const DEFAULT_BASE_AGENT = "claude";

export interface CustomAgent {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly launchCmd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly baseAgent: string;
  readonly disabledCapabilities: readonly string[];
  /** Overrides the base adapter's prompt shape; absent means "inherit". */
  readonly promptMode?: PromptMode;
}

/**
 * `^[A-Z_][A-Z0-9_]*$`, minus the names the hook client owns: a custom agent
 * must not be able to redirect hook reports by shadowing `ARMADRA_*`.
 */
export function validEnvKey(key: string): boolean {
  if (key.length === 0 || key.length > 128 || key.startsWith("ARMADRA_")) {
    return false;
  }
  return /^[A-Z_][A-Z0-9_]*$/.test(key);
}

/** The id rule `db::valid_agent_id` applies to a `custom:` entry. */
export function validAgentId(value: string): boolean {
  if ((BUILTIN_AGENT_IDS as readonly string[]).includes(value)) return true;
  if (!value.startsWith("custom:")) return false;
  const suffix = value.slice("custom:".length);
  return (
    suffix.length > 0 &&
    suffix.length <= 64 &&
    /^[A-Za-z0-9.:_-]+$/.test(suffix)
  );
}

function trimmed(entry: JsonObject, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value.trim() : undefined;
}

/** One entry of the raw array → the normalized entry, or `undefined` to drop it. */
export function sanitizeCustomAgent(raw: JsonValue): CustomAgent | undefined {
  if (!isJsonObject(raw)) return undefined;

  const id = trimmed(raw, "id");
  if (id === undefined) return undefined;
  if (!id.startsWith("custom:") || !validAgentId(id)) return undefined;

  const label = trimmed(raw, "label");
  if (label === undefined || label.length === 0) return undefined;
  if ([...label].length > MAX_CUSTOM_LABEL) return undefined;

  const launchCmd = trimmed(raw, "launchCmd");
  if (launchCmd === undefined || launchCmd.length === 0) return undefined;
  if (launchCmd.length > MAX_CUSTOM_COMMAND) return undefined;
  if (/[\n\r\0]/.test(launchCmd)) return undefined;

  const baseAgent = trimmed(raw, "baseAgent") ?? DEFAULT_BASE_AGENT;
  if (!(BUILTIN_AGENT_IDS as readonly string[]).includes(baseAgent)) {
    return undefined;
  }

  const rawColor = trimmed(raw, "color");
  const color =
    rawColor !== undefined && rawColor.length > 0 && rawColor.length <= 32
      ? rawColor
      : DEFAULT_CUSTOM_COLOR;

  const rawArgs = raw.args;
  const args = Array.isArray(rawArgs)
    ? rawArgs
        .filter(
          (argument): argument is string =>
            typeof argument === "string" &&
            argument.length <= MAX_CUSTOM_COMMAND &&
            !argument.includes("\0"),
        )
        .slice(0, MAX_CUSTOM_ARGS)
    : [];

  // An unusable key or an oversized value drops that variable, not the agent:
  // the CLI still starts, it just starts without that one setting.
  const env: Record<string, string> = {};
  const rawEnv = raw.env;
  if (isJsonObject(rawEnv)) {
    for (const [key, value] of Object.entries(rawEnv)) {
      if (Object.keys(env).length >= MAX_CUSTOM_ENV_VARS) break;
      if (typeof value !== "string") continue;
      if (
        validEnvKey(key) &&
        value.length <= MAX_CUSTOM_ENV_VALUE &&
        !value.includes("\0")
      ) {
        env[key] = value;
      }
    }
  }

  const rawDisabled = raw.disabledCapabilities;
  const disabledCapabilities = Array.isArray(rawDisabled)
    ? rawDisabled
        .filter(
          (value): value is string =>
            typeof value === "string" &&
            (AGENT_CAPABILITIES as readonly string[]).includes(value),
        )
        .slice(0, AGENT_CAPABILITIES.length)
    : [];

  // An unreadable value inherits the base's shape rather than dropping the
  // agent: "I do not understand this field" is not a reason to make the CLI
  // unstartable.
  const rawPromptMode = trimmed(raw, "promptMode");
  const promptMode = (PROMPT_MODES as readonly string[]).includes(
    rawPromptMode ?? "",
  )
    ? (rawPromptMode as PromptMode)
    : undefined;

  return {
    id,
    label,
    color,
    launchCmd,
    args,
    env,
    baseAgent,
    disabledCapabilities,
    ...(promptMode === undefined ? {} : { promptMode }),
  };
}

export function parseCustomAgents(document: JsonValue): CustomAgent[] {
  if (!isJsonObject(document)) return [];
  const agentsSection = document.agents;
  if (!isJsonObject(agentsSection)) return [];
  const list = agentsSection.custom;
  if (!Array.isArray(list)) return [];
  const agents: CustomAgent[] = [];
  for (const raw of list) {
    if (agents.length >= MAX_CUSTOM_AGENTS) break;
    const agent = sanitizeCustomAgent(raw);
    if (agent === undefined) continue;
    // Two entries with the same id would make `GET /api/agents` ambiguous and
    // the launch line non-deterministic; the first one wins.
    if (agents.every((kept) => kept.id !== agent.id)) agents.push(agent);
  }
  return agents;
}

/**
 * The serialised form. Empty collections are omitted exactly as serde's
 * `skip_serializing_if` omits them, and the keys are written in the order the
 * Rust struct declares its fields — two documents that describe the same
 * agents have to be the same bytes, or a round trip through one side would
 * show up as a change on the other.
 */
export function customAgentToJson(agent: CustomAgent): JsonObject {
  const json: JsonObject = {
    id: agent.id,
    label: agent.label,
    color: agent.color,
    launchCmd: agent.launchCmd,
    args: [...agent.args],
  };
  if (Object.keys(agent.env).length > 0) json.env = { ...agent.env };
  json.baseAgent = agent.baseAgent;
  if (agent.disabledCapabilities.length > 0) {
    json.disabledCapabilities = [...agent.disabledCapabilities];
  }
  if (agent.promptMode !== undefined) json.promptMode = agent.promptMode;
  return json;
}

/**
 * The section is only written when it already exists, so a settings file that
 * never had a custom agent does not grow an empty one.
 */
export function normalizeCustomAgents(document: JsonObject): void {
  if (!("agents" in document)) return;
  const agents = parseCustomAgents(document);
  const existing = document.agents;
  const section: JsonObject = isJsonObject(existing) ? clone(existing) : {};
  section.custom = agents.map(customAgentToJson);
  document.agents = section;
}
