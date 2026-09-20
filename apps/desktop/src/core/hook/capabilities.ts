import { parseCustomAgents } from "../settings/custom-agents";
import { settingsDomain } from "../settings";

/**
 * The two capabilities the hook surface gates on, mirroring
 * `AGENT_REGISTRY` in packages/shared/src/agents.ts.
 *
 * The tables are repeated here rather than imported because the core does not
 * depend on `@armadra/shared` — the same decision the pre-merge implementation
 * made, for the same reason: the hook surface must keep answering when the
 * front end's package is not in the build. A test asserts the two agree.
 */

/** Providers whose adapter reports hook events at all. */
export const HOOKS_CAPABLE = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

/** Providers whose adapter reports subagent cards. */
export const SUBAGENT_CAPABLE = ["claude", "codex"] as const;

const TABLE: Readonly<Record<string, readonly string[]>> = {
  hooks: HOOKS_CAPABLE,
  subagent: SUBAGENT_CAPABLE,
};

function customAgent(
  agentId: string,
): { baseAgent: string; disabledCapabilities: readonly string[] } | undefined {
  const document = settingsDomain()?.settings.snapshot();
  if (document === undefined) return undefined;
  return parseCustomAgents(document).find((agent) => agent.id === agentId);
}

/**
 * Whether this agent declares `capability`.
 *
 * A `custom:` entry inherits its base adapter's declarations minus the ones it
 * disabled; an entry that names no known base has nothing to inherit and is
 * therefore capable of nothing.
 */
export function hasCapability(agentId: string, capability: string): boolean {
  const declared = TABLE[capability] ?? [];
  if (!agentId.startsWith("custom:")) return declared.includes(agentId);
  const custom = customAgent(agentId);
  if (custom === undefined) return false;
  return (
    declared.includes(custom.baseAgent) &&
    !custom.disabledCapabilities.includes(capability)
  );
}

/** Which built-in adapter a custom entry borrows its hook shape from. */
export function baseAgent(agentId: string): string {
  if (!agentId.startsWith("custom:")) return agentId;
  return customAgent(agentId)?.baseAgent ?? "claude";
}
