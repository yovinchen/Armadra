import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOOK_EVENTS, HOOK_CLIENT_REVISION } from "./events";
import {
  InstallError,
  type InstallReport,
  type JsonObject,
  type JsonValue,
  appendManagedGroup,
  hookCommand,
  readJsonObject,
  stripManagedHandlers,
  takeEvents,
  writeAtomically,
  writeJsonObject,
} from "./shared";
import {
  type TrustEntry,
  isEditable,
  readDocument,
  removeTrustState,
  writeTrustState,
} from "./toml-state";

/**
 * Codex — `<CODEX_HOME>/hooks.json` plus the trust state in `config.toml`.
 *
 * Codex refuses to run a hook it does not trust, and it does so **silently**:
 * without the right `trusted_hash` the entries in `hooks.json` simply never
 * fire, which would look exactly like a broken client. So the installer has to
 * reproduce Codex's own hash, not merely write a plausible one.
 *
 * The algorithm was read off Codex's source (`codex-rs/hooks/src/engine/
 * discovery.rs::hook_hash` → `codex-rs/config/src/fingerprint.rs::
 * version_for_toml`) and verified byte-for-byte against a Codex 0.149.1
 * installation:
 *
 * 1. Build the *normalized identity* of one handler:
 *    `{ event_name: <snake_case>, matcher?: <string>, hooks: [<handler>] }`,
 *    where the handler is the config after normalization — for a command hook
 *    that is `{ type: "command", command, timeout, async }`. The timeout is
 *    the resolved one, not the written one: 600s everywhere except
 *    `SessionEnd` and `Interrupt`, which default to 1s and are capped at 3s.
 * 2. Serialize it to TOML, convert that to JSON, sort every object key
 *    recursively, and emit compact JSON.
 * 3. `sha256:` + lowercase hex of the SHA-256 of those bytes.
 *
 * The state key is `<absolute hooks.json path>:<snake_case event>:<group
 * index>:<handler index>`, which is why our group is always appended last:
 * moving a foreign group would invalidate the user's own trust entries.
 *
 * ## Known broken on Codex 0.153.4 (2026-09-13)
 *
 * The hash above no longer matches. After a clean install the TUI opens
 * "Hooks need review — 8 hooks are new or changed" and runs none of them until
 * a person presses `t`. The keys are right (they appear in that panel); the
 * identity Codex hashes has changed. One lead: in 0.153.4 the bundled
 * `chrome@openai-bundled` and `browser@openai-bundled` `stop` entries carry
 * the *same* `trusted_hash`, so the identity can no longer include the command
 * or the source path.
 *
 * Two things follow for anyone picking this up. There is no session-scoped
 * alternative to fall back on — `codex -c key=value` overrides `config.toml`,
 * and hooks live in `hooks.json` — and **`codex exec` runs no hooks at all**
 * (a trusted `session_start` entry does not fire under it on 0.153.4), so the
 * smoke test drives the interactive TUI the way a canvas node does.
 *
 * Nothing here writes a hash it cannot justify: an entry whose hash is stale
 * is one Codex refuses until a person approves it, which is the safe failure.
 */

const AGENT_ID = "codex";
/** Codex's default command-hook timeout, in seconds. */
const DEFAULT_TIMEOUT_SEC = 600;
/**
 * `SessionEnd` and `Interrupt` default to 1s (capped at 3s) because Codex does
 * not wait for them.
 */
const SESSION_END_TIMEOUT_SEC = 1;

/**
 * Codex's own event vocabulary. The shared list also contains `Notification`,
 * which Codex has no hook event for; it is skipped and reported as a warning
 * rather than written into a file Codex would ignore.
 */
export function eventKey(event: string): string | undefined {
  const keys: Record<string, string> = {
    PreToolUse: "pre_tool_use",
    PermissionRequest: "permission_request",
    PostToolUse: "post_tool_use",
    PreCompact: "pre_compact",
    PostCompact: "post_compact",
    SessionStart: "session_start",
    SessionEnd: "session_end",
    UserPromptSubmit: "user_prompt_submit",
    SubagentStart: "subagent_start",
    SubagentStop: "subagent_stop",
    Stop: "stop",
    Interrupt: "interrupt",
  };
  return keys[event];
}

function resolvedTimeout(event: string): number {
  return event === "SessionEnd" || event === "Interrupt"
    ? SESSION_END_TIMEOUT_SEC
    : DEFAULT_TIMEOUT_SEC;
}

export function hooksPath(configHome: string): string {
  return join(configHome, "hooks.json");
}

export function configPath(configHome: string): string {
  return join(configHome, "config.toml");
}

/**
 * Codex parses `hooks.json` with `deny_unknown_fields`: anything but
 * `description` and `hooks` at the top level — other installers write
 * `"version": 1` — makes it reject the whole file with "unknown field" and
 * silently run no hook at all, theirs included. Such keys are dropped, not
 * preserved.
 */
function dropUnknownTopLevelKeys(document: JsonObject): void {
  for (const key of Object.keys(document)) {
    if (key !== "description" && key !== "hooks") delete document[key];
  }
}

export function install(configHome: string, clientBin: string): InstallReport {
  const hooksFile = hooksPath(configHome);
  // Before anything is written: a `config.toml` this editor would mangle is
  // refused outright rather than half-rewritten.
  const existingConfig = readDocument(configPath(configHome));
  if (!isEditable(existingConfig)) {
    throw new InstallError(
      409,
      "conflict",
      `${configPath(configHome)} is not valid TOML; refusing to rewrite it`,
    );
  }
  const supported = CODEX_HOOK_EVENTS.filter(
    (event) => eventKey(event) !== undefined,
  );
  const skipped = CODEX_HOOK_EVENTS.filter(
    (event) => eventKey(event) === undefined,
  );

  const document = readJsonObject(hooksFile);
  dropUnknownTopLevelKeys(document);
  const events = takeEvents(document);
  stripManagedHandlers(events);
  const command = hookCommand(clientBin, AGENT_ID);
  appendManagedGroup(events, supported, { type: "command", command });
  document.hooks = events;
  writeJsonObject(hooksFile, document);

  // The trust key names the file Codex will discover, which is the resolved
  // one: Codex canonicalizes CODEX_HOME before building the key.
  const keySource = canonicalKeySource(hooksFile);
  const entries = trustEntries(events, keySource, command);
  if (entries.length > 0) {
    writeAtomically(
      configPath(configHome),
      writeTrustState(existingConfig, entries),
    );
  }

  const warning =
    skipped.length > 0
      ? `Codex 没有 ${skipped.join(" / ")} 事件，已跳过；其余 ${entries.length} 个事件已安装并写入 trusted_hash`
      : undefined;
  return {
    agentId: AGENT_ID,
    configPath: hooksFile,
    clientBin,
    clientRevision: HOOK_CLIENT_REVISION,
    installed: true,
    launchArgs: [],
    ...(warning === undefined ? {} : { warning }),
  };
}

export function uninstall(configHome: string): InstallReport {
  const hooksFile = hooksPath(configHome);
  const document = readJsonObject(hooksFile);
  dropUnknownTopLevelKeys(document);
  const events = takeEvents(document);
  stripManagedHandlers(events);
  if (Object.keys(events).length > 0) document.hooks = events;
  if (existsSync(hooksFile)) writeJsonObject(hooksFile, document);

  // Every trust entry that pointed at one of our handlers is now stale. They
  // are keyed by index, so the only safe rule is: drop the keys for this file
  // that no longer name a handler, and leave everything else alone.
  const keySource = canonicalKeySource(hooksFile);
  const config = configPath(configHome);
  if (existsSync(config)) {
    const document = readDocument(config);
    const pruned = removeTrustState(
      document,
      `${keySource}:`,
      survivingKeys(events, keySource),
    );
    if (pruned !== document) writeAtomically(config, pruned);
  }

  return {
    agentId: AGENT_ID,
    configPath: hooksFile,
    clientRevision: HOOK_CLIENT_REVISION,
    installed: false,
    launchArgs: [],
  };
}

/**
 * Codex resolves `CODEX_HOME` before it builds a state key, so a path that
 * goes through a symlink (`/tmp` → `/private/tmp` on macOS) must be resolved
 * here too or the key will never match.
 */
function canonicalKeySource(hooksFile: string): string {
  try {
    return realpathSync(hooksFile);
  } catch {
    // The file may not exist yet; resolve the directory instead so at least
    // the symlinked prefix matches what Codex will see.
    try {
      const directory = join(hooksFile, "..");
      return join(realpathSync(directory), "hooks.json");
    } catch {
      return hooksFile;
    }
  }
}

function groupsOf(events: JsonObject, event: string): JsonValue[] {
  const groups = events[event];
  return Array.isArray(groups) ? groups : [];
}

function asObject(value: JsonValue): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

/** `(state key, trusted hash)` for every managed handler in the merged file. */
export function trustEntries(
  events: JsonObject,
  keySource: string,
  command: string,
): TrustEntry[] {
  const entries: TrustEntry[] = [];
  for (const event of Object.keys(events).sort()) {
    const key = eventKey(event);
    if (key === undefined) continue;
    groupsOf(events, event).forEach((rawGroup, groupIndex) => {
      const group = asObject(rawGroup);
      if (group === undefined) return;
      const matcher =
        typeof group.matcher === "string" ? group.matcher : undefined;
      const handlers = group.hooks;
      if (!Array.isArray(handlers)) return;
      handlers.forEach((rawHandler, handlerIndex) => {
        const handler = asObject(rawHandler);
        if (handler?.command !== command) {
          // Only our own handlers get a hash from us; trusting a stranger's
          // command on the user's behalf is not our call.
          return;
        }
        entries.push({
          key: `${keySource}:${key}:${groupIndex}:${handlerIndex}`,
          hash: hookHash(key, matcher, command, resolvedTimeout(event)),
        });
      });
    });
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}

/** Keys that still name a handler after our entries were removed. */
function survivingKeys(events: JsonObject, keySource: string): string[] {
  const keys: string[] = [];
  for (const event of Object.keys(events)) {
    const key = eventKey(event);
    if (key === undefined) continue;
    groupsOf(events, event).forEach((rawGroup, groupIndex) => {
      const group = asObject(rawGroup);
      const handlers = group?.hooks;
      const count = Array.isArray(handlers) ? handlers.length : 0;
      for (let handlerIndex = 0; handlerIndex < count; handlerIndex += 1) {
        keys.push(`${keySource}:${key}:${groupIndex}:${handlerIndex}`);
      }
    });
  }
  return keys;
}

/**
 * Reproduces `codex_config::fingerprint::version_for_toml` over Codex's
 * `NormalizedHookIdentity`. See the module note for the derivation.
 *
 * The canonicalization is "every object's keys sorted" — which `serde_json`'s
 * BTreeMap gives the Rust side for free and is written out here.
 */
export function hookHash(
  event: string,
  matcher: string | undefined,
  command: string,
  timeoutSec: number,
): string {
  const identity: Record<string, unknown> = {
    event_name: event,
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ async: false, command, timeout: timeoutSec, type: "command" }],
  };
  const digest = createHash("sha256")
    .update(canonicalJson(identity), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** Compact JSON with every object's keys in sorted order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
