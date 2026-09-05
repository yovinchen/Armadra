import type {
  AutomationPlan,
  AutomationPlanConfig,
  AutomationRun,
} from "@armadra/host-client";
import type { AutomationScheduleKind } from "@armadra/shared";

/**
 * Display model for the automation page. Everything here is a pure function of
 * what the Host said, so the panel never has to guess: an unset field renders
 * as unknown rather than as a zero, and a delivered run is never drawn as a
 * finished one.
 */

/* ------------------------------- schedules -------------------------------- */

export function scheduleKind(
  config: AutomationPlanConfig | undefined,
): AutomationScheduleKind | null {
  switch (config?.schedule?.kind?.case) {
    case "once":
      return "once";
    case "interval":
      return "interval";
    case "cron":
      return "cron";
    case "loopAfterCompletion":
      return "loop";
    default:
      return null;
  }
}

/** Five fields only — the Host rejects seconds and year columns. */
export const CRON_FIELDS = 5;
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/** The names the Host's parser understands, per field index. */
const NAMES: Record<number, Record<string, number>> = {
  3: {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  },
  4: { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 },
};

function cronValue(token: string, index: number): number | null {
  const named = NAMES[index]?.[token.toUpperCase()];
  if (named !== undefined) return named;
  return /^\d{1,2}$/.test(token) ? Number(token) : null;
}

function validCronField(
  field: string,
  [low, high]: [number, number],
  index: number,
): boolean {
  if (field === "*") return true;
  return field.split(",").every((part) => {
    if (!part) return false;
    const [range, step, ...rest] = part.split("/");
    if (rest.length > 0 || range === undefined) return false;
    if (step !== undefined) {
      if (!/^\d{1,2}$/.test(step)) return false;
      const size = Number(step);
      if (size < 1 || size > high) return false;
    }
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2) return false;
    let previous = -1;
    return bounds.every((token) => {
      const value = cronValue(token, index);
      if (value === null || value < low || value > high) return false;
      const ordered = previous < 0 || value >= previous;
      previous = value;
      return ordered;
    });
  });
}

/**
 * A conservative subset of what the Host's parser accepts: five fields of
 * numbers, ranges, steps and the usual month/weekday names. The non-standard
 * `?`, `L` and `#` forms are refused here rather than saved and rejected later,
 * which would leave a draft that looks configured but can never run.
 */
export function validCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (expression.trim() === "" || fields.length !== CRON_FIELDS) return false;
  return fields.every((field, index) =>
    validCronField(field, RANGES[index]!, index),
  );
}

/** A real IANA zone on this runtime; the device's own zone is never assumed. */
export function validTimezone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function timezoneOptions(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  const zones =
    typeof supported === "function" ? supported.call(Intl, "timeZone") : [];
  if (zones.length > 0) return zones;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return local ? [local, "UTC"] : ["UTC"];
}

/* --------------------------------- states --------------------------------- */

/** Mirrors AutomationPlanState; index 0 is the unspecified value. */
export const PLAN_STATES = [
  "unspecified",
  "draft",
  "active",
  "paused",
  "expired",
  "deleted",
] as const;

/** Mirrors AutomationRunState. */
export const RUN_STATES = [
  "unspecified",
  "due",
  "claimed",
  "waitingTarget",
  "dispatching",
  "delivered",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "expired",
  "unknown",
] as const;

export function planStateKey(plan: AutomationPlan | undefined): string {
  return `automation.planState.${PLAN_STATES[plan?.state ?? 0] ?? "unspecified"}`;
}

export function runStateKey(run: AutomationRun | undefined): string {
  return `automation.runState.${RUN_STATES[run?.state ?? 0] ?? "unspecified"}`;
}

/**
 * Which receipt phase a run has reached. "Delivered" is deliberately its own
 * phase: the design forbids drawing delivered input as completed work.
 */
export type ReceiptPhase = "none" | "queued" | "delivered" | "settled";

export function receiptPhase(run: AutomationRun | undefined): ReceiptPhase {
  if (!run) return "none";
  if (run.receiptSequence > 0n) {
    return run.state >= 7 && run.state <= 11 ? "settled" : "delivered";
  }
  if (run.deliveryObserved) return "delivered";
  return run.dispatchAttempts > 0 ? "queued" : "none";
}

/** Runs whose outcome nobody has established; never shown as success. */
export function unresolved(run: AutomationRun | undefined): boolean {
  return run?.state === 12;
}

export function needsAttention(plan: AutomationPlan | undefined): boolean {
  return plan?.needsAttention === true;
}

/* ------------------------------- formatting ------------------------------- */

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/** Renders a Host timestamp, or null when the Host has not set one. */
export function instant(
  value: bigint | undefined,
  locale: string,
  timeZone?: string,
): string | null {
  if (value === undefined || value <= 0n || value > BigInt(MAX_TIMESTAMP_MS))
    return null;
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };
  if (timeZone && validTimezone(timeZone)) options.timeZone = timeZone;
  return new Intl.DateTimeFormat(locale, options).format(Number(value));
}

/** Short hex of a digest, for the activation confirmation. */
export function digestLabel(digest: Uint8Array | undefined): string {
  if (!digest || digest.byteLength === 0) return "";
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A reason code is a machine token; it is shown verbatim, never translated. */
export function reasonLabel(code: string | undefined): string {
  return code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "";
}
