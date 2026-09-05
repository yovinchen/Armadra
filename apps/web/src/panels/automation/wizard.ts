import { create } from "@armadra/protocol";
import {
  AutomationColdStartPolicy,
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
  AutomationPlanConfigSchema,
  AutomationTargetKind,
  CommandLaunchSpecSchema,
  type AgentLaunchSpec,
  type AutomationPlanConfig,
  type CommandLaunchSpec,
} from "@armadra/protocol";
import type { AutomationScheduleKind } from "@armadra/shared";

import { validCron, validTimezone } from "./model";

/**
 * Turns the create form into exactly the configuration the Host will store.
 *
 * Everything is validated here, before anything is sent: a plan that is saved
 * and only then refused would leave a draft that looks configured but can never
 * run. The rules mirror the design's schedule table, including the loop bound
 * that forbids an unbounded self-loop.
 */

export type MisfireChoice = "skip" | "coalesce";
export type ConcurrencyChoice = "forbid" | "queue";

export interface WizardState {
  title: string;
  scheduleKind: AutomationScheduleKind;
  /** `datetime-local` values; parsed as an absolute instant, never a pattern. */
  at: string;
  anchor: string;
  intervalMs: string;
  cron: string;
  timezone: string;
  loopDelayMs: string;
  maxRuns: string;
  expiresAt: string;
  misfire: MisfireChoice;
  concurrency: ConcurrencyChoice;
  busyTtlMs: string;
  payload: string;
}

/**
 * Where a plan writes. The two shapes stay separate on purpose: a command
 * target creates a new non-interactive process, an agent target writes one
 * framed prompt into a terminal that already exists, and nothing converts one
 * into the other. An agent target additionally freezes the launch definition,
 * so an authorized cold start relaunches exactly what was reviewed here.
 */
export type WizardTarget = {
  workspaceId: string;
  executionHostId: string;
  sessionId: string;
  generation: bigint;
} & (
  | { kind: "command" }
  | {
      kind: "agent";
      nodeId: string;
      agentLaunch: AgentLaunchSpec;
      coldStart: boolean;
    }
);

export type WizardResult =
  | { ok: true; config: AutomationPlanConfig }
  | { ok: false; field: keyof WizardState | "session"; messageKey: string };

/** Mirrors the Host's normalizer so nothing is saved that it would refuse. */
const MIN_PERIOD_MS = 1000n;
const MAX_PERIOD_MS = 31_536_000_000n;
const MAX_BUSY_TTL_MS = 86_400_000n;
const MAX_TIMEOUT_MS = 86_400_000n;

export function defaultWizardState(now = Date.now()): WizardState {
  return {
    title: "",
    scheduleKind: "once",
    at: localInput(now + 5 * 60_000),
    anchor: localInput(now),
    intervalMs: "3600000",
    cron: "0 3 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    loopDelayMs: "60000",
    maxRuns: "",
    expiresAt: "",
    misfire: "skip",
    concurrency: "forbid",
    busyTtlMs: "300000",
    payload: "",
  };
}

/** A `datetime-local` string for the browser's own zone. */
export function localInput(epochMs: number): string {
  const date = new Date(
    epochMs - new Date(epochMs).getTimezoneOffset() * 60_000,
  );
  return date.toISOString().slice(0, 16);
}

function instantOf(value: string): bigint | null {
  if (!value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return BigInt(parsed);
}

function bounded(value: string, low: bigint, high: bigint): bigint | null {
  if (!/^\d{1,15}$/.test(value.trim())) return null;
  const parsed = BigInt(value.trim());
  return parsed >= low && parsed <= high ? parsed : null;
}

function optionalCount(value: string): bigint | null | "invalid" {
  if (!value.trim()) return null;
  return bounded(value, 1n, 1_000_000_000n) ?? "invalid";
}

export function buildLaunchSpec(input: {
  executable: string;
  args: string;
  timeoutMs: string;
}): CommandLaunchSpec | { messageKey: string } {
  const executable = input.executable.trim();
  if (!/^\/[^\s\u0000]*$/.test(executable))
    return { messageKey: "automation.wizard.invalidPath" };
  const timeout = bounded(input.timeoutMs, MIN_PERIOD_MS, MAX_TIMEOUT_MS);
  if (timeout === null)
    return { messageKey: "automation.wizard.invalidInterval" };
  return create(CommandLaunchSpecSchema, {
    executable,
    args: input.args
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    workingDirectory: ".",
    accountId: "default",
    timeoutMs: timeout,
  });
}

/** The frozen target exactly as the Host will store and re-check it. */
function planTarget(target: WizardTarget): AutomationPlanConfig["target"] {
  const base = {
    $typeName: "armadra.v1.AutomationTarget" as const,
    executionHostId: target.executionHostId,
    sessionId: target.sessionId,
    generation: target.generation,
    nodeId: "",
    coldStartPolicy: AutomationColdStartPolicy.SKIP,
  };
  if (target.kind === "command") {
    return { ...base, kind: AutomationTargetKind.NON_INTERACTIVE_COMMAND };
  }
  return {
    ...base,
    kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
    nodeId: target.nodeId,
    // Launching a process is its own permission, so the plan only carries it
    // when the person creating it said so.
    coldStartPolicy: target.coldStart
      ? AutomationColdStartPolicy.LAUNCH_FROZEN
      : AutomationColdStartPolicy.SKIP,
    agentLaunch: target.agentLaunch,
  };
}

export function buildPlanConfig(
  state: WizardState,
  target: WizardTarget,
): WizardResult {
  const title = state.title.trim();
  if (!title || title.length > 200)
    return { ok: false, field: "title", messageKey: "automation.wizard.title" };
  if (!target.sessionId)
    return {
      ok: false,
      field: "session",
      messageKey: "automation.wizard.session",
    };
  // An agent plan carries the prompt it will type. Saving an empty one would
  // create a plan that can only ever write nothing into somebody's terminal.
  if (target.kind === "agent" && !state.payload.trim())
    return {
      ok: false,
      field: "payload",
      messageKey: "automation.wizard.promptRequired",
    };
  const busyTtl = bounded(state.busyTtlMs, MIN_PERIOD_MS, MAX_BUSY_TTL_MS);
  if (busyTtl === null)
    return {
      ok: false,
      field: "busyTtlMs",
      messageKey: "automation.wizard.invalidInterval",
    };
  const maxRuns = optionalCount(state.maxRuns);
  if (maxRuns === "invalid")
    return {
      ok: false,
      field: "maxRuns",
      messageKey: "automation.wizard.invalidInterval",
    };
  const expires = state.expiresAt.trim() ? instantOf(state.expiresAt) : null;
  if (state.expiresAt.trim() && expires === null)
    return {
      ok: false,
      field: "expiresAt",
      messageKey: "automation.wizard.invalidTime",
    };

  let schedule: AutomationPlanConfig["schedule"];
  switch (state.scheduleKind) {
    case "once": {
      const at = instantOf(state.at);
      if (at === null)
        return {
          ok: false,
          field: "at",
          messageKey: "automation.wizard.invalidTime",
        };
      schedule = {
        $typeName: "armadra.v1.AutomationSchedule",
        kind: {
          case: "once",
          value: { $typeName: "armadra.v1.AutomationOnce", atUnixMs: at },
        },
      };
      break;
    }
    case "interval": {
      const anchor = instantOf(state.anchor);
      const every = bounded(state.intervalMs, MIN_PERIOD_MS, MAX_PERIOD_MS);
      if (anchor === null)
        return {
          ok: false,
          field: "anchor",
          messageKey: "automation.wizard.invalidTime",
        };
      if (every === null)
        return {
          ok: false,
          field: "intervalMs",
          messageKey: "automation.wizard.invalidInterval",
        };
      schedule = {
        $typeName: "armadra.v1.AutomationSchedule",
        kind: {
          case: "interval",
          value: {
            $typeName: "armadra.v1.AutomationInterval",
            anchorUnixMs: anchor,
            intervalMs: every,
          },
        },
      };
      break;
    }
    case "cron": {
      if (!validCron(state.cron))
        return {
          ok: false,
          field: "cron",
          messageKey: "automation.wizard.invalidCron",
        };
      // The zone is stored explicitly; the device's own zone is never assumed.
      if (!validTimezone(state.timezone))
        return {
          ok: false,
          field: "timezone",
          messageKey: "automation.wizard.invalidTimezone",
        };
      schedule = {
        $typeName: "armadra.v1.AutomationSchedule",
        kind: {
          case: "cron",
          value: {
            $typeName: "armadra.v1.AutomationCron",
            expression: state.cron.trim().split(/\s+/).join(" "),
            timezone: state.timezone.trim(),
          },
        },
      };
      break;
    }
    default: {
      const delay = bounded(state.loopDelayMs, MIN_PERIOD_MS, MAX_PERIOD_MS);
      if (delay === null)
        return {
          ok: false,
          field: "loopDelayMs",
          messageKey: "automation.wizard.invalidInterval",
        };
      // A loop with neither a count nor a deadline would never stop.
      if (maxRuns === null && expires === null)
        return {
          ok: false,
          field: "maxRuns",
          messageKey: "automation.wizard.loopBound",
        };
      schedule = {
        $typeName: "armadra.v1.AutomationSchedule",
        kind: {
          case: "loopAfterCompletion",
          value: {
            $typeName: "armadra.v1.AutomationLoopAfterCompletion",
            delayMs: delay,
          },
        },
      };
      break;
    }
  }

  return {
    ok: true,
    config: create(AutomationPlanConfigSchema, {
      workspaceId: target.workspaceId,
      title,
      schedule,
      target: planTarget(target),
      misfirePolicy:
        state.misfire === "skip"
          ? AutomationMisfirePolicy.SKIP
          : AutomationMisfirePolicy.COALESCE_ONE,
      concurrencyPolicy:
        state.concurrency === "forbid"
          ? AutomationConcurrencyPolicy.FORBID
          : AutomationConcurrencyPolicy.QUEUE_ONE,
      busyTtlMs: busyTtl,
      maxRuns: maxRuns ?? 0n,
      expiresAtUnixMs: expires ?? 0n,
    }),
  };
}
