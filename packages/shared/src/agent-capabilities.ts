import { z } from "zod";

import {
  AGENT_CAPABILITIES,
  AGENT_IDS,
  agentDefinition,
  type AgentCapability,
  type BuiltinAgentId,
} from "./agents.js";

/**
 * Effective capabilities — docs/agent-automation-design.md §1.
 *
 * "能力按内置基础适配器 → 自定义 Agent 配置 → CLI 版本探测 → 执行主机能力 →
 * 项目授权求交集。未知能力不由名称推断为支持" — so this module intersects, it
 * never unions. Four consequences the UI depends on:
 *
 *   * a capability the base adapter does not declare can never appear, however
 *     new the CLI is or however a custom entry is configured;
 *   * a custom entry may switch one off, never on;
 *   * a probe that did not run, timed out or produced an unreadable version
 *     yields `unknown`, and `unknown` renders as *absent* — no button, no menu
 *     item, no promise we cannot keep;
 *   * an execution host that cannot carry a capability removes it regardless of
 *     everything above.
 *
 * `source` is what the settings page shows next to each row, so a user can see
 * *why* a capability is off rather than only that it is.
 */
export const CAPABILITY_STATES = [
  "supported",
  "unsupported",
  "unknown",
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_SOURCES = [
  "base",
  "custom",
  "version",
  "host",
] as const;
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export interface ResolvedCapability {
  readonly capability: AgentCapability;
  readonly state: CapabilityState;
  /** The stage that decided the state — the *narrowest* one that applied. */
  readonly source: CapabilitySource;
}

/* ------------------------------ version probe ----------------------------- */

/**
 * One `<launchCmd> --version` result, cached in settings under
 * `agents.probes[<agentId>]` (design §9: `agent_capability_cache`).
 *
 * `status` is deliberately three-valued. `"unsupported"` means the program ran
 * and told us it is too old; `"failed"` means we could not find out — the CLI
 * is missing, hung, or printed something we do not understand — and that is
 * *not* the same statement.
 */
export const agentProbeSchema = z.object({
  agentId: z.string().min(1).max(128),
  /** Program the probe actually ran, so a changed launch command re-probes. */
  launchCmd: z.string().max(1024).default(""),
  /** Parsed `major.minor.patch`, or null when the output had no version in it. */
  version: z.string().max(64).nullable().default(null),
  status: z.enum(["ok", "failed"]).default("failed"),
  /** ISO-8601. A probe older than `PROBE_TTL_MS` is re-run. */
  probedAt: z.string().max(64).default(""),
});
export type AgentProbe = z.infer<typeof agentProbeSchema>;

export const agentProbesSchema = z.record(z.string(), agentProbeSchema);

/** Probes are re-run after a day; a CLI upgrade in between is picked up then. */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum CLI version a capability needs, per agent.
 *
 * Empty on purpose. We have no vendor statement pinning any of these
 * capabilities to a release, and §1 forbids inventing one — a fabricated
 * minimum would silently hide a working feature or advertise a missing one.
 * What the probe *does* buy today is the negative: a CLI we cannot run at all
 * leaves every capability `unknown`, so no control is drawn for it. Add an
 * entry here only with a citable release note.
 */
export const CAPABILITY_MIN_VERSION: Readonly<
  Partial<Record<BuiltinAgentId, Partial<Record<AgentCapability, string>>>>
> = {};

/** `1.2.10` > `1.2.9`: numeric per segment, missing segments read as zero. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * First `x.y` / `x.y.z` in a `--version` line. Mirrors `parse_version` in
 * `apps/runtime/src/agent_probe.rs`, which is what actually runs the probe.
 *
 * CLIs print anything from `1.2.3` to `codex-cli 0.104.0 (rust)` to `v18.1.8`,
 * so the rule is "the first dotted number" with no word boundary in front —
 * `\b` would refuse to start inside `v18` and come back with `1.8`. Requiring
 * two segments is what keeps an identifier that merely ends in digits
 * (`sha256`, `utf8mb4`) from reading as a version, and no number at all means
 * no version — never a default that would let a gate pass.
 */
export function parseCliVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3] ?? "0"}` : null;
}

/* ----------------------------- execution hosts ---------------------------- */

export const EXECUTION_HOST_KINDS = ["local", "ssh"] as const;
export type ExecutionHostKind = (typeof EXECUTION_HOST_KINDS)[number];

/**
 * Capabilities an execution host kind cannot carry, whatever the CLI supports.
 *
 * An SSH terminal runs the CLI on another machine: its transcripts and its
 * account state live over there, and the runtime only ever reads local paths.
 * Claiming a context reading for it would produce a number belonging to a
 * different session, so both usage capabilities are dropped rather than
 * approximated.
 */
const HOST_EXCLUSIONS: Readonly<
  Record<ExecutionHostKind, readonly AgentCapability[]>
> = {
  local: [],
  ssh: ["contextUsage", "usage"],
};

export function hostSupports(
  kind: ExecutionHostKind,
  capability: AgentCapability,
): boolean {
  return !HOST_EXCLUSIONS[kind].includes(capability);
}

/* ------------------------------- resolution ------------------------------- */

export interface ResolveCapabilitiesInput {
  /** Adapter whose capabilities are being narrowed. */
  readonly baseAgent: BuiltinAgentId;
  /** Capabilities the base adapter declares; defaults to the registry's list. */
  readonly declared?: readonly AgentCapability[];
  /** `settings.agents.custom[].disabledCapabilities` for a `custom:` entry. */
  readonly disabledCapabilities?: readonly AgentCapability[];
  /** Cached `--version` probe; absent means "never probed". */
  readonly probe?: AgentProbe | null;
  readonly host?: ExecutionHostKind;
}

export function resolveAgentCapabilities(
  input: ResolveCapabilitiesInput,
): readonly ResolvedCapability[] {
  const declared =
    input.declared ?? agentDefinition(input.baseAgent)?.capabilities ?? [];
  const minimums = CAPABILITY_MIN_VERSION[input.baseAgent] ?? {};
  const host = input.host ?? "local";
  return AGENT_CAPABILITIES.map((capability): ResolvedCapability => {
    if (!declared.includes(capability)) {
      return { capability, state: "unsupported", source: "base" };
    }
    if (input.disabledCapabilities?.includes(capability)) {
      return { capability, state: "unsupported", source: "custom" };
    }
    if (!hostSupports(host, capability)) {
      return { capability, state: "unsupported", source: "host" };
    }
    const minimum = minimums[capability];
    const probe = input.probe;
    if (!probe || probe.status !== "ok") {
      // Not probed, or the probe could not answer. Only gated capabilities go
      // `unknown`: an ungated one is as certain as the adapter's declaration.
      return minimum
        ? { capability, state: "unknown", source: "version" }
        : { capability, state: "supported", source: "base" };
    }
    if (minimum) {
      if (!probe.version) {
        return { capability, state: "unknown", source: "version" };
      }
      if (compareVersions(probe.version, minimum) < 0) {
        return { capability, state: "unsupported", source: "version" };
      }
      return { capability, state: "supported", source: "version" };
    }
    return { capability, state: "supported", source: "base" };
  });
}

/** Only `supported`; `unknown` never draws a control (§1, §10). */
export function effectiveCapabilities(
  input: ResolveCapabilitiesInput,
): readonly AgentCapability[] {
  return resolveAgentCapabilities(input)
    .filter((entry) => entry.state === "supported")
    .map((entry) => entry.capability);
}

/* ------------------------------ model catalogue --------------------------- */

/**
 * Model ids the header menu may offer, per CLI.
 *
 * Suggestions, not an inventory: each CLI keeps its own account, entitlements
 * and default (docs/agent-collaboration.md), and we do not query any provider
 * for a list. Only aliases the CLI itself documents are listed, and picking
 * none leaves the CLI's own default untouched — which is why `""` is a valid
 * selection everywhere rather than a fourth pseudo-model.
 */
export const AGENT_MODEL_SUGGESTIONS: Readonly<
  Record<BuiltinAgentId, readonly string[]>
> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5-codex", "gpt-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  opencode: [],
  pi: [],
  omp: [],
  copilot: [],
};

export function modelSuggestions(agentId: string): readonly string[] {
  return (AGENT_IDS as readonly string[]).includes(agentId)
    ? AGENT_MODEL_SUGGESTIONS[agentId as BuiltinAgentId]
    : [];
}
