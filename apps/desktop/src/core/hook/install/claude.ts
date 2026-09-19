import { existsSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOOK_EVENTS, HOOK_CLIENT_REVISION } from "./events";
import {
  type InstallReport,
  type JsonObject,
  appendManagedGroup,
  hookCommand,
  readJsonObject,
  removedReport,
  stripManagedHandlers,
  takeEvents,
  writeJsonObject,
} from "./shared";

/**
 * Claude Code — injected on the launch line, never written into the user's
 * `settings.json` (docs/design/agent-integration.md §3).
 *
 * ## How, and how it was verified
 *
 * `claude --settings <file-or-json>` is documented by `claude --help` as
 * "Path to a settings JSON file or a JSON string to load additional settings
 * from". *Additional* is the load-bearing word, and it was checked rather than
 * assumed: with a `SessionStart` hook in `$CLAUDE_CONFIG_DIR/settings.json`
 * and a different one in the file passed to `--settings`, Claude Code 2.1.260
 * ran **both**. So pointing the flag at a file of ours adds our hooks to
 * whatever the user configured instead of replacing it, and a session started
 * outside Armadra — where the flag is absent — behaves exactly as if we had
 * never been installed.
 *
 * The file therefore lives in our own data directory, not in `~/.claude`:
 * integrating claude writes nothing the user also edits, and uninstalling
 * deletes a file only we ever wrote. What install *does* touch in
 * `~/.claude/settings.json` is the removal of entries an earlier Armadra (or a
 * predecessor product name) left there — see {@link retireGlobalEntries} and
 * `repair.ts`.
 *
 * ## The status line
 *
 * Context telemetry rides the same file's `statusLine`. Unlike a hook, a
 * status line is singular: `--settings` would win over the user's own. So it
 * is written only when `~/.claude/settings.json` has no `statusLine` of its
 * own (or has one that is recognisably ours), and the report says so
 * otherwise. A foreign status line is never wrapped or chained: its command
 * may have side effects and chaining would alter its lifecycle.
 *
 * Claude's hook timeouts are **seconds**. The client is a fire-and-forget POST
 * with its own 1.5s deadline, so a short timeout here only bounds the damage
 * when the binary is missing or the disk is stuck.
 */

const AGENT_ID = "claude";
/** Seconds. See the module note. */
const TIMEOUT_SECONDS = 5;
/**
 * The flag the launch line carries. Named once so the settings page, the smoke
 * test and this writer cannot drift apart.
 */
export const SETTINGS_FLAG = "--settings";

/** The user's own file. We only ever *remove* from it now. */
export function settingsPath(configHome: string): string {
  return join(configHome, "settings.json");
}

/** The file `--settings` points at: ours, in our data directory. */
export function managedSettingsPath(integrationHome: string): string {
  return join(integrationHome, "settings.json");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function install(
  configHome: string,
  integrationHome: string,
  clientBin: string,
): InstallReport {
  const path = managedSettingsPath(integrationHome);
  // Anything an earlier Armadra wrote into the user's own file is no longer
  // read by us and would fire a second time on every event.
  const retired = retireGlobalEntries(configHome);

  const events: JsonObject = {};
  appendManagedGroup(events, CLAUDE_HOOK_EVENTS, {
    type: "command",
    command: hookCommand(clientBin, AGENT_ID),
    timeout: TIMEOUT_SECONDS,
  });
  const settings: JsonObject = { hooks: events };

  // A status line is singular and `--settings` outranks the user's file, so
  // ours is written only when theirs is absent.
  const contextInstalled = !hasForeignStatusLine(configHome);
  if (contextInstalled) {
    settings.statusLine = {
      type: "command",
      command: hookCommand(clientBin, "context-usage"),
    };
  }
  writeJsonObject(path, settings);

  const warning = !contextInstalled
    ? "context_statusline_preserved"
    : retired
      ? "legacy_global_hooks_removed"
      : undefined;
  return {
    agentId: AGENT_ID,
    configPath: path,
    clientBin,
    clientRevision: HOOK_CLIENT_REVISION,
    installed: true,
    launchArgs: launchArgs(path),
    ...(warning === undefined ? {} : { warning }),
  };
}

export function uninstall(
  configHome: string,
  integrationHome: string,
): InstallReport {
  const path = managedSettingsPath(integrationHome);
  if (isFile(path)) {
    rmSync(path, { force: true });
    // Only our own directory, and only when nothing else landed in it.
    try {
      rmdirSync(integrationHome);
    } catch {
      // Something else of ours is still in there; leave it.
    }
  }
  retireGlobalEntries(configHome);
  return removedReport(AGENT_ID, path, HOOK_CLIENT_REVISION);
}

/**
 * The argv a claude session must carry. Empty when the file is not there:
 * pointing the CLI at a settings file that does not exist is an error it
 * prints on every start, which is worse than starting with no hooks.
 */
export function launchArgs(settingsFile: string): string[] {
  return isFile(settingsFile) ? [SETTINGS_FLAG, settingsFile] : [];
}

/** True when `<integration home>/settings.json` is there to be pointed at. */
export function isInstalled(integrationHome: string): boolean {
  return isFile(managedSettingsPath(integrationHome));
}

/**
 * Removes our hook entries and our status line from the user's own
 * `settings.json`, leaving everything else exactly as it was. Answers whether
 * anything was there.
 *
 * This runs on install as well as on uninstall: a machine upgrading from the
 * file-injected era has our entries in two places, and the one in `~/.claude`
 * would fire for every session the user starts outside Armadra.
 */
export function retireGlobalEntries(configHome: string): boolean {
  const path = settingsPath(configHome);
  if (!existsSync(path)) return false;
  const settings = readJsonObject(path);
  let changed = false;
  const statusLine = settings.statusLine;
  if (
    typeof statusLine === "object" &&
    statusLine !== null &&
    !Array.isArray(statusLine) &&
    typeof statusLine.command === "string" &&
    managedContextCommand(statusLine.command)
  ) {
    delete settings.statusLine;
    changed = true;
  }
  const events = takeEvents(settings);
  const stripped = stripManagedHandlers(events) > 0;
  changed ||= stripped;
  if (Object.keys(events).length === 0) {
    // Leaving `"hooks": {}` behind would be a diff the user did not ask for.
    changed ||= stripped;
  } else {
    settings.hooks = events;
  }
  if (changed) writeJsonObject(path, settings);
  return changed;
}

/**
 * Whether the user's own settings claim the status line. A file we cannot
 * parse counts as claimed: replacing a status line we could not read would be
 * taking something over rather than filling a gap.
 */
function hasForeignStatusLine(configHome: string): boolean {
  let settings: JsonObject;
  try {
    settings = readJsonObject(settingsPath(configHome));
  } catch {
    return true;
  }
  const statusLine = settings.statusLine;
  if (statusLine === undefined) return false;
  if (
    typeof statusLine !== "object" ||
    statusLine === null ||
    Array.isArray(statusLine)
  ) {
    return true;
  }
  const command = statusLine.command;
  return !(typeof command === "string" && managedContextCommand(command));
}

/**
 * Whether a status-line command is one we wrote. Exported because it is the
 * conservative half of the rule and is worth asserting directly: anything it
 * does not plainly recognise is preserved.
 */
export function managedContextCommand(command: string): boolean {
  if (!command.endsWith(" context-usage")) return false;
  const raw = command.slice(0, -" context-usage".length);
  // Generated paths are one shell-quoted argument. Be conservative about
  // unfamiliar shell syntax; preserving a foreign command is always safe.
  let program: string;
  if (
    raw.length >= 2 &&
    raw.startsWith('"') &&
    raw.endsWith('"') &&
    !raw.slice(1, -1).includes('"')
  ) {
    program = raw.slice(1, -1);
  } else if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    program = raw.slice(1, -1).split("'\\''").join("'");
  } else if (!/\s/.test(raw)) {
    program = raw;
  } else {
    return false;
  }
  const filename = program.replace(/\\/g, "/").split("/").pop() ?? "";
  return (
    (filename === "armadra-hook" || filename === "armadra-hook.exe") &&
    !/[;|&`$\n\r]/.test(program)
  );
}
