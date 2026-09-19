import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CLIENT_NAME,
  COPILOT_HOOK_EVENTS,
  HOOK_CLIENT_REVISION,
} from "./events";
import {
  type InstallReport,
  type JsonObject,
  type JsonValue,
  readJsonObject,
  takeEvents,
  writeJsonObject,
} from "./shared";

/**
 * GitHub Copilot CLI — writes `<config home>/hooks/armadra.json`.
 *
 * Copilot is the one CLI that loads hooks from a *directory* of files rather
 * than from one settings file: everything in `~/.copilot/hooks/*.json` is
 * merged, so we get a file of our own and never edit the user's. That makes
 * "foreign entries survive" mostly free — their files are not ours to open —
 * but not entirely, because a user can also paste entries into `armadra.json`
 * itself. Those are kept, exactly as the other installers keep foreign
 * handlers inside a shared settings file.
 *
 * Two shape differences from Claude / Codex, both verified against Copilot CLI
 * 1.0.83:
 *
 *   * an event maps straight to a **flat list of hook entries**, with no
 *     `{ matcher, hooks: [...] }` wrapper, so the shared strip/append helpers
 *     do not apply and this module has its own pair;
 *   * an entry may name its program as `exec` + `args` instead of a shell
 *     string. We use `exec`, so the path never goes through a shell and needs
 *     no quoting — but recognition still has to look at every spelling a user
 *     might have, which is what {@link isManagedEntry} does.
 *
 * `preToolUse` is not installed and must not be. It is Copilot's only blocking
 * event: a non-zero exit or a crash is read as `deny`, so subscribing it would
 * turn a missing binary into "every tool call is refused" (协作通道 §6). Every
 * other event is fail-open, which is the contract this channel relies on.
 *
 * ## Why not the session-scoped route (agent-integration §3)
 *
 * Copilot does have one: `copilot --plugin-dir <directory>` loads a plugin
 * "for this session only", and `copilot plugin --help` says plugins carry
 * "skills, agents, hooks, MCP servers, and LSP servers" — which would be the
 * whole install unit in one flag. Probed against 1.0.8x on 2026-09-13: a
 * directory with a `plugin.json` carrying `hooks` **is** accepted, but a
 * `skills/<name>/SKILL.md` inside that same directory appeared in neither
 * `copilot skill list` nor `copilot plugins list`, and neither did a
 * `SKILL.md` at the plugin root. A session flag that can carry only half of a
 * unit that has no half is worse than the file install, so this stays a file
 * install until a plugin's skills are demonstrably loaded.
 */

const AGENT_ID = "copilot";
/**
 * Seconds — Copilot's own unit, default 30. The client has its own 1.5s
 * deadline, so this only bounds the damage when the binary or the disk hangs.
 */
const TIMEOUT_SECONDS = 5;
/**
 * Copilot's hook file format version, not ours. It is written on install and
 * preserved on uninstall.
 */
const FILE_FORMAT_VERSION = 1;

/**
 * The keys a hook entry may name its program with. `exec` is what we write;
 * the rest are here so an entry a user converted to a shell command by hand is
 * still recognised as ours and gets replaced instead of duplicated.
 */
const PROGRAM_KEYS = ["exec", "command", "bash", "powershell"] as const;

export function hooksPath(configHome: string): string {
  return join(configHome, "hooks", "armadra.json");
}

export function install(configHome: string, clientBin: string): InstallReport {
  const path = hooksPath(configHome);
  const file = readJsonObject(path);
  const events = takeEvents(file);
  stripManagedEntries(events);
  appendManagedEntry(events, COPILOT_HOOK_EVENTS, {
    type: "command",
    exec: clientBin,
    args: [AGENT_ID],
    timeoutSec: TIMEOUT_SECONDS,
  });
  file.version = FILE_FORMAT_VERSION;
  file.hooks = events;
  writeJsonObject(path, file);
  return {
    agentId: AGENT_ID,
    configPath: path,
    clientBin,
    clientRevision: HOOK_CLIENT_REVISION,
    installed: true,
    launchArgs: [],
  };
}

export function uninstall(configHome: string): InstallReport {
  const path = hooksPath(configHome);
  const file = readJsonObject(path);
  const events = takeEvents(file);
  stripManagedEntries(events);
  if (existsSync(path)) {
    if (Object.keys(events).length === 0 && isOnlyOurs(file)) {
      // Nothing of the user's was ever in here; leaving an empty
      // `{"version":1,"hooks":{}}` behind would be a file they have to wonder
      // about later.
      rmSync(path, { force: true });
    } else {
      file.hooks = events;
      writeJsonObject(path, file);
    }
  }
  return {
    agentId: AGENT_ID,
    configPath: path,
    clientRevision: HOOK_CLIENT_REVISION,
    installed: false,
    launchArgs: [],
  };
}

/** Whether the file has nothing left but the format version we wrote. */
function isOnlyOurs(file: JsonObject): boolean {
  return Object.keys(file).every((key) => key === "version");
}

/**
 * True when this entry runs our client, whichever key it names the program
 * with. The rule is the module-level one: recognise, do not remember.
 */
export function isManagedEntry(entry: JsonValue): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  return PROGRAM_KEYS.some((key) => {
    const program = entry[key];
    return typeof program === "string" && program.includes(CLIENT_NAME);
  });
}

/** Removes our entries from every event and drops the events left empty. */
function stripManagedEntries(events: JsonObject): void {
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !isManagedEntry(entry));
    if (kept.length === 0) delete events[event];
    else events[event] = kept;
  }
}

/**
 * Appends one entry to each listed event. Last, so a foreign entry's position
 * — and therefore the order Copilot runs them in — never moves.
 */
function appendManagedEntry(
  events: JsonObject,
  names: readonly string[],
  entry: JsonObject,
): void {
  for (const name of names) {
    const existing = events[name];
    const entries = Array.isArray(existing) ? existing : [];
    entries.push({ ...entry, args: [...(entry.args as JsonValue[])] });
    events[name] = entries;
  }
}
