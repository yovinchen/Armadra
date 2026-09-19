/**
 * `settings.language.*` — the user's overrides and ceilings (design §1.2, §3.3).
 *
 * Two things this module deliberately does not offer:
 *
 *  * **No install button.** There is no key that would download, install or
 *    update a server. A path override names something the user already has.
 *  * **No argv string.** `args` is an array of arguments, never a command line
 *    to be split by a shell, so nothing a user types can become a second
 *    program.
 *
 * Unknown keys survive untouched — `SettingsStore.patch` merges per section —
 * so a settings file written by a newer build is not flattened by this one.
 */

import type { JsonObject, JsonValue } from "./jsonrpc";

/**
 * Idle stop, in seconds. `0` turns idle stopping off, which is a real choice
 * for somebody who wants a warm server all day.
 */
export const DEFAULT_IDLE_STOP_SECONDS = 600;
const MAX_IDLE_STOP_SECONDS = 86_400;
/** Per execution host. Each server is a compiler-sized process. */
export const DEFAULT_MAX_SERVERS = 6;
const MAX_MAX_SERVERS = 24;
/** `0` means "no ceiling"; anything else is bytes of RSS per server. */
export const DEFAULT_MAX_RSS_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * Formatting on save is off by default: it rewrites the user's buffer, and a
 * save that silently reflows a file is a surprise, not a service.
 */
export const DEFAULT_FORMAT_ON_SAVE = false;

/** One `language.servers.<serverId>` entry. */
export interface ServerOverride {
  /** Absolute path, or a program name to resolve on PATH. Empty means the
   * registry's program. */
  readonly path: string;
  /** Replaces the registry's arguments when non-empty. */
  readonly args: readonly string[];
  /** `false` answers `disabled` without probing or starting anything. */
  readonly enabled: boolean;
}

const DEFAULT_OVERRIDE: ServerOverride = { path: "", args: [], enabled: true };

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : undefined;
}

function parseOverride(value: JsonValue | undefined): ServerOverride {
  const object = asObject(value);
  if (object === undefined) return DEFAULT_OVERRIDE;
  const rawPath = object["path"];
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  const rawArgs = object["args"];
  const args = Array.isArray(rawArgs)
    ? rawArgs
        .filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            entry.length > 0 &&
            entry.length <= 4096,
        )
        .slice(0, 32)
    : [];
  const enabled = object["enabled"];
  return {
    path: trimmed.length > 0 && trimmed.length <= 4096 ? trimmed : "",
    args,
    enabled: typeof enabled === "boolean" ? enabled : true,
  };
}

/** The `language` section as the core reads it. */
export class LanguageSettings {
  readonly idleStopSeconds: number;
  readonly maxServers: number;
  readonly maxRssBytes: number;
  readonly formatOnSave: boolean;
  private readonly servers: JsonObject;

  private constructor(section: JsonObject | undefined) {
    const source = section ?? {};
    const idle = source["idleStopSeconds"];
    this.idleStopSeconds =
      typeof idle === "number" &&
      Number.isInteger(idle) &&
      idle >= 0 &&
      idle <= MAX_IDLE_STOP_SECONDS
        ? idle
        : DEFAULT_IDLE_STOP_SECONDS;
    const max = source["maxServers"];
    this.maxServers =
      typeof max === "number" && Number.isInteger(max) && max >= 0
        ? Math.min(Math.max(max, 1), MAX_MAX_SERVERS)
        : DEFAULT_MAX_SERVERS;
    const rss = source["maxRssBytes"];
    // `0` is "no ceiling"; a value too small to hold any real server is
    // clamped up rather than turning into an instant kill loop.
    this.maxRssBytes =
      typeof rss === "number" && Number.isInteger(rss) && rss >= 0
        ? rss === 0
          ? 0
          : Math.max(rss, 128 * 1024 * 1024)
        : DEFAULT_MAX_RSS_BYTES;
    const format = source["formatOnSave"];
    this.formatOnSave =
      typeof format === "boolean" ? format : DEFAULT_FORMAT_ON_SAVE;
    this.servers = asObject(source["servers"]) ?? {};
  }

  static fromDocument(document: JsonValue | undefined): LanguageSettings {
    return new LanguageSettings(asObject(asObject(document)?.["language"]));
  }

  server(serverId: string): ServerOverride {
    return parseOverride(this.servers[serverId]);
  }

  /**
   * `initializationOptions` and `settings` are handed to the server as
   * written. They are the user's own JSON: the core never interprets them, and
   * never logs them.
   */
  initializationOptions(serverId: string): JsonValue | undefined {
    return asObject(this.servers[serverId])?.["initializationOptions"];
  }

  workspaceConfiguration(serverId: string): JsonValue | undefined {
    return asObject(this.servers[serverId])?.["settings"];
  }
}

/**
 * Fills in the `language` section's defaults, the way every other section is
 * normalised. Only the scalars are written back: `servers` is the user's map
 * and is left exactly as found, including entries for ids this build has never
 * heard of.
 */
export function normalizeLanguageSection(document: JsonObject): void {
  const language = { ...(asObject(document["language"]) ?? {}) };
  const parsed = LanguageSettings.fromDocument({ language });
  language["idleStopSeconds"] = parsed.idleStopSeconds;
  language["maxServers"] = parsed.maxServers;
  language["maxRssBytes"] = parsed.maxRssBytes;
  language["formatOnSave"] = parsed.formatOnSave;
  document["language"] = language;
}
