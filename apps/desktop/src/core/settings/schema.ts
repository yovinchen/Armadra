/**
 * Normalising the settings document: known keys are forced to valid values,
 * unknown keys are passed through, and a patch merges rather than replaces.
 *
 * Ported from `apps/runtime/src/settings/schema.rs` plus the defaults and
 * choice lists `apps/runtime/src/settings/mod.rs` declares, and the `language`
 * section of `apps/runtime/src/language/settings.rs`.
 *
 * The rule the whole file follows: a value outside the offered set **snaps back
 * to the default** rather than being rejected. A settings file is something a
 * person can edit by hand, and one broken key must not make the rest of it
 * unreadable.
 */

import { normalizeCustomAgents } from "./custom-agents";
import { clone, isJsonObject, type JsonObject, type JsonValue } from "./local";
import { normalizeHosts } from "./ssh-hosts";

/* --------------------------------- terminal -------------------------------- */

/** `terminal.backend` — the user's choice, not necessarily what is in effect. */
export const BACKEND_CHOICES = [
  "auto",
  "tmux",
  "direct",
  "sessionHost",
] as const;
const DEFAULT_BACKEND = "auto";
const DEFAULT_DETACHED_GRACE_MINUTES = 1_440;
const MAX_DETACHED_GRACE_MINUTES = 525_600;
/**
 * How long a session with nothing attached keeps its interactive delivery
 * cadence before it goes dormant. `0` turns dormancy off entirely.
 */
const DEFAULT_DORMANT_AFTER_SECONDS = 120;
const MAX_DORMANT_AFTER_SECONDS = 86_400;
const MIN_DORMANT_AFTER_SECONDS = 5;

/* ----------------------------------- usage --------------------------------- */

/** `usage.enabled` — gates the usage pill's provider fetches. */
const DEFAULT_USAGE_ENABLED = true;
/** `usage.refreshMinutes`; `0` means "manual only". */
export const USAGE_REFRESH_CHOICES = [0, 1, 2, 5, 15];
const DEFAULT_USAGE_REFRESH_MINUTES = 5;
/** A provider that is off is never contacted and reports `unavailable`. */
export const USAGE_PROVIDER_IDS = ["claude", "codex", "copilot"] as const;
const DEFAULT_CODEX_CLI_FALLBACK = false;
const DEFAULT_COST_ENABLED = true;

/* ------------------------------ logs / updates ----------------------------- */

/** `logs.retentionDays`; `0` means "keep forever". */
export const LOG_RETENTION_CHOICES = [0, 7, 30, 90];
const DEFAULT_LOG_RETENTION_DAYS = 30;
/**
 * `updates.channel`. `development` is not a choice: it describes a build that
 * never went through CI, and asking for it would not turn a released build into
 * one.
 */
export const UPDATE_CHANNELS = ["stable", "beta"] as const;
const DEFAULT_UPDATE_CHANNEL = "stable";
const DEFAULT_UPDATE_AUTO_CHECK = true;
const DEFAULT_UPDATE_AUTO_DOWNLOAD = false;
const DEFAULT_UPDATE_NOTIFY = true;

/* -------------------------- power / resources / browser -------------------- */

export const POWER_POLICIES = [
  "never",
  "agentSessions",
  "automation",
  "manual",
] as const;
const DEFAULT_POWER_POLICY = "manual";

/**
 * 对话索引扫多大一片。
 *
 * `workspaces` 只索引本应用的工作空间根目录下跑过的那些会话，`all` 是整个
 * `~/.claude/projects`（以及 codex 的那一份）。默认收着：命令面板列出一台开发
 * 机上**所有**项目的会话标题，既慢又把与这块画布无关的工作摊在面前。
 */
export const CONVERSATION_SCOPES = ["workspaces", "all"] as const;
const DEFAULT_CONVERSATION_SCOPE = "workspaces";
const DEFAULT_RESOURCE_INTERVAL_MS = 2_000;
const MIN_RESOURCE_INTERVAL_MS = 500;
const MAX_RESOURCE_INTERVAL_MS = 60_000;
const DEFAULT_BROWSER_KEEP_ALIVE = true;
const DEFAULT_BROWSER_HEADFUL = false;
const MAX_BROWSER_EXECUTABLE_PATH = 4_096;

/* --------------------------------- language -------------------------------- */

export const DEFAULT_IDLE_STOP_SECONDS = 600;
const MAX_IDLE_STOP_SECONDS = 86_400;
export const DEFAULT_MAX_SERVERS = 6;
const MAX_MAX_SERVERS = 24;
export const DEFAULT_MAX_RSS_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_NONZERO_MAX_RSS_BYTES = 128 * 1024 * 1024;
export const DEFAULT_FORMAT_ON_SAVE = false;

/* -------------------------------- primitives ------------------------------- */

function section(document: JsonObject, key: string): JsonObject {
  const existing = document[key];
  return isJsonObject(existing) ? clone(existing) : {};
}

/**
 * `serde_json::Value::as_u64` — a non-negative integer, and nothing else. A
 * float, a negative number or a numeric string is not a `u64` on the Rust side
 * either, and falls through to the default the same way.
 */
function asUnsigned(value: JsonValue | undefined): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function asBool(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function choice<T extends string>(
  value: JsonValue | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  const text = asString(value);
  return text !== undefined && (choices as readonly string[]).includes(text)
    ? (text as T)
    : fallback;
}

function numberChoice(
  value: JsonValue | undefined,
  choices: readonly number[],
  fallback: number,
): number {
  const parsed = asUnsigned(value);
  return parsed !== undefined && choices.includes(parsed) ? parsed : fallback;
}

/* --------------------------------- normalize ------------------------------- */

/**
 * The whole settings document, normalized: known keys always present with valid
 * values, unknown keys passed through untouched.
 */
export function normalize(raw: JsonValue): JsonObject {
  const document: JsonObject = isJsonObject(raw) ? clone(raw) : {};

  normalizeTerminal(document);
  normalizeUsage(document);
  normalizeLogs(document);
  normalizeUpdates(document);
  normalizePower(document);
  normalizeConversations(document);
  normalizeResources(document);
  normalizeBrowser(document);
  // Only the scalars are normalised; `servers` and `probes` are the user's map
  // and the probe cache, and both may hold ids this build has never heard of.
  normalizeLanguage(document);
  // Entries that would not survive validation are dropped here, so the document
  // the API hands out is exactly the set of hosts a terminal may be created for.
  normalizeHosts(document);
  // Same contract as the hosts above: what the API hands back is exactly the set
  // of agents that can actually be started.
  normalizeCustomAgents(document);

  return document;
}

function normalizeTerminal(document: JsonObject): void {
  const terminal = section(document, "terminal");
  terminal.backend = choice(terminal.backend, BACKEND_CHOICES, DEFAULT_BACKEND);
  const grace = asUnsigned(terminal.detachedGraceMinutes);
  terminal.detachedGraceMinutes =
    grace !== undefined && grace >= 1 && grace <= MAX_DETACHED_GRACE_MINUTES
      ? grace
      : DEFAULT_DETACHED_GRACE_MINUTES;
  // `0` is a real choice (dormancy off), so it is kept rather than clamped up
  // into the valid range.
  const dormant = asUnsigned(terminal.dormantAfterSeconds);
  terminal.dormantAfterSeconds =
    dormant !== undefined &&
    (dormant === 0 ||
      (dormant >= MIN_DORMANT_AFTER_SECONDS &&
        dormant <= MAX_DORMANT_AFTER_SECONDS))
      ? dormant
      : DEFAULT_DORMANT_AFTER_SECONDS;
  document.terminal = terminal;
}

function normalizeUsage(document: JsonObject): void {
  const usage = section(document, "usage");
  usage.enabled = asBool(usage.enabled) ?? DEFAULT_USAGE_ENABLED;
  // A cadence outside the offered set snaps back to the default rather than
  // being rejected, same rule as `logs.retentionDays`.
  usage.refreshMinutes = numberChoice(
    usage.refreshMinutes,
    USAGE_REFRESH_CHOICES,
    DEFAULT_USAGE_REFRESH_MINUTES,
  );
  const providers = section(usage, "providers");
  for (const id of USAGE_PROVIDER_IDS) {
    providers[id] = asBool(providers[id]) ?? true;
  }
  // An id nobody knows about would make the settings page render a switch for a
  // provider the core cannot query, so drop it.
  for (const key of Object.keys(providers)) {
    if (!(USAGE_PROVIDER_IDS as readonly string[]).includes(key)) {
      delete providers[key];
    }
  }
  usage.providers = providers;
  usage.codexCliFallback =
    asBool(usage.codexCliFallback) ?? DEFAULT_CODEX_CLI_FALLBACK;
  const cost = section(usage, "cost");
  cost.enabled = asBool(cost.enabled) ?? DEFAULT_COST_ENABLED;
  usage.cost = cost;
  document.usage = usage;
}

function normalizeLogs(document: JsonObject): void {
  const logs = section(document, "logs");
  logs.retentionDays = numberChoice(
    logs.retentionDays,
    LOG_RETENTION_CHOICES,
    DEFAULT_LOG_RETENTION_DAYS,
  );
  document.logs = logs;
}

function normalizeUpdates(document: JsonObject): void {
  const updates = section(document, "updates");
  // An unknown channel snaps back to stable rather than being rejected: the
  // conservative reading of a broken value is the conservative channel.
  updates.channel = choice(
    updates.channel,
    UPDATE_CHANNELS,
    DEFAULT_UPDATE_CHANNEL,
  );
  updates.autoCheck = asBool(updates.autoCheck) ?? DEFAULT_UPDATE_AUTO_CHECK;
  updates.autoDownload =
    asBool(updates.autoDownload) ?? DEFAULT_UPDATE_AUTO_DOWNLOAD;
  updates.notify = asBool(updates.notify) ?? DEFAULT_UPDATE_NOTIFY;
  document.updates = updates;
}

function normalizePower(document: JsonObject): void {
  const power = section(document, "power");
  // The safest reading of a broken value is the conservative default, not a
  // machine that refuses to sleep.
  power.policy = choice(power.policy, POWER_POLICIES, DEFAULT_POWER_POLICY);
  document.power = power;
}

function normalizeConversations(document: JsonObject): void {
  const conversations = section(document, "conversations");
  conversations.scope = choice(
    conversations.scope,
    CONVERSATION_SCOPES,
    DEFAULT_CONVERSATION_SCOPE,
  );
  document.conversations = conversations;
}

function normalizeResources(document: JsonObject): void {
  const resources = section(document, "resources");
  const interval = asUnsigned(resources.intervalMs);
  resources.intervalMs =
    interval === undefined
      ? DEFAULT_RESOURCE_INTERVAL_MS
      : Math.min(
          Math.max(interval, MIN_RESOURCE_INTERVAL_MS),
          MAX_RESOURCE_INTERVAL_MS,
        );
  document.resources = resources;
}

function normalizeBrowser(document: JsonObject): void {
  const browser = section(document, "browser");
  // `executablePath` is stored exactly as written — an empty string means
  // "detect", and a path that does not exist is reported as unavailable rather
  // than silently replaced by a detected browser.
  const executable = asString(browser.executablePath)?.trim();
  browser.executablePath =
    executable !== undefined &&
    executable.length > 0 &&
    executable.length <= MAX_BROWSER_EXECUTABLE_PATH
      ? executable
      : "";
  browser.keepAlive = asBool(browser.keepAlive) ?? DEFAULT_BROWSER_KEEP_ALIVE;
  browser.headful = asBool(browser.headful) ?? DEFAULT_BROWSER_HEADFUL;
  document.browser = browser;
}

function normalizeLanguage(document: JsonObject): void {
  const language = section(document, "language");
  const idle = asUnsigned(language.idleStopSeconds);
  language.idleStopSeconds =
    idle !== undefined && idle <= MAX_IDLE_STOP_SECONDS
      ? idle
      : DEFAULT_IDLE_STOP_SECONDS;
  const servers = asUnsigned(language.maxServers);
  language.maxServers =
    servers === undefined
      ? DEFAULT_MAX_SERVERS
      : Math.min(Math.max(servers, 1), MAX_MAX_SERVERS);
  // `0` is "no ceiling"; a value too small to hold any real server is clamped
  // up rather than turning into an instant kill loop.
  const rss = asUnsigned(language.maxRssBytes);
  language.maxRssBytes =
    rss === undefined
      ? DEFAULT_MAX_RSS_BYTES
      : rss === 0
        ? 0
        : Math.max(rss, MIN_NONZERO_MAX_RSS_BYTES);
  language.formatOnSave =
    asBool(language.formatOnSave) ?? DEFAULT_FORMAT_ON_SAVE;
  document.language = language;
}

/* ----------------------------------- merge --------------------------------- */

/**
 * Recursive object merge: `null` deletes a key, objects merge, everything else
 * replaces. Keys the core does not know about are merged the same way.
 */
export function merge(base: JsonValue, patch: JsonValue): JsonValue {
  if (!isJsonObject(base) || !isJsonObject(patch)) return clone(patch);
  const result: JsonObject = base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const existing = result[key];
    result[key] = merge(existing === undefined ? null : existing, value);
  }
  return result;
}
