import type { AutomationScheduleKind } from "@armadra/shared";

import { validCron, validTimezone } from "./model";
import {
  AgentLaunchSpec,
  AutomationColdStartPolicy,
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
  AutomationPlanConfig,
  AutomationTargetKind,
  CommandLaunchSpec,
  automationPlanConfig,
  commandLaunchSpec,
} from "../../api/automations";

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

/**
 * The wizard state that reproduces a stored plan, for editing it.
 *
 * Everything the Host keeps is read back from the configuration; the payload
 * comes separately (`AutomationApi.planPayload`) because the Host stores
 * it apart from the configuration. Anything the Host does not store — there is
 * nothing today — would have to be left blank rather than invented, because a
 * field the form filled in by guessing would be saved as if it had been read.
 */
export function wizardStateFromConfig(
  config: AutomationPlanConfig,
  payload: string,
  now = Date.now(),
): WizardState {
  const base = defaultWizardState(now);
  const schedule = config.schedule?.kind;
  const state: WizardState = {
    ...base,
    title: config.title,
    payload,
    misfire:
      config.misfirePolicy === AutomationMisfirePolicy.COALESCE_ONE
        ? "coalesce"
        : "skip",
    concurrency:
      config.concurrencyPolicy === AutomationConcurrencyPolicy.QUEUE_ONE
        ? "queue"
        : "forbid",
    // A stored zero is "the Host normalized it away", not a real setting, and
    // showing it would leave a form that cannot be submitted at all.
    busyTtlMs:
      config.busyTtlMs > 0n ? String(config.busyTtlMs) : base.busyTtlMs,
    maxRuns: config.maxRuns > 0n ? String(config.maxRuns) : "",
    expiresAt:
      config.expiresAtUnixMs > 0n
        ? localInput(Number(config.expiresAtUnixMs))
        : "",
  };
  switch (schedule?.case) {
    case "once":
      return {
        ...state,
        scheduleKind: "once",
        at: localInput(Number(schedule.value.atUnixMs)),
      };
    case "interval":
      return {
        ...state,
        scheduleKind: "interval",
        anchor: localInput(Number(schedule.value.anchorUnixMs)),
        intervalMs: String(schedule.value.intervalMs),
      };
    case "cron":
      return {
        ...state,
        scheduleKind: "cron",
        cron: schedule.value.expression,
        timezone: schedule.value.timezone,
      };
    case "loopAfterCompletion":
      return {
        ...state,
        scheduleKind: "loop",
        loopDelayMs: String(schedule.value.delayMs),
      };
    default:
      return state;
  }
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
  return commandLaunchSpec({
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

/**
 * The target a stored plan already carries, so an edit re-sends exactly it.
 *
 * An edit changes the schedule and the content; re-picking the target is a
 * different, larger decision (it re-freezes the agent definition and the
 * generation), and doing it implicitly on every save would quietly repoint a
 * plan at whatever the canvas looks like today. The form shows this read-only.
 */
export function targetFromConfig(
  config: AutomationPlanConfig,
): WizardTarget | null {
  const target = config.target;
  if (!target) return null;
  const base = {
    workspaceId: config.workspaceId,
    executionHostId: target.executionHostId,
    sessionId: target.sessionId,
    generation: target.generation,
  };
  if (target.kind !== AutomationTargetKind.AGENT_SESSION_PROMPT) {
    return { ...base, kind: "command" };
  }
  if (!target.agentLaunch) return null;
  return {
    ...base,
    kind: "agent",
    nodeId: target.nodeId,
    agentLaunch: target.agentLaunch,
    coldStart:
      target.coldStartPolicy === AutomationColdStartPolicy.LAUNCH_FROZEN,
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
        kind: {
          case: "once",
          value: { atUnixMs: at },
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
        kind: {
          case: "interval",
          value: {
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
        kind: {
          case: "cron",
          value: {
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
        kind: {
          case: "loopAfterCompletion",
          value: {
            delayMs: delay,
          },
        },
      };
      break;
    }
  }

  return {
    ok: true,
    config: automationPlanConfig({
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
