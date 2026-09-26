import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_NAME, HOOK_CLIENT_REVISION } from "./events";
import {
  type InstallReport,
  type JsonObject,
  type JsonValue,
  readJsonObject,
  takeEvents,
  writeJsonObject,
} from "./shared";

/**
 * GitHub Copilot CLI — the removal of the global `<config home>/hooks/
 * armadra.json` an earlier Armadra wrote.
 *
 * Copilot's hooks now reach it through `--plugin-dir` on a canvas node's
 * launch line (`inject.ts`): a plugin directory with `"hooks": "hooks.json"`
 * and `"skills": "skills/"` in its `plugin.json` loads both for that session
 * only (re-measured on 1.0.8x, 2026-09-26 — the earlier probe that saw no
 * skill had the manifest without a `skills` key).
 *
 * What stays here is recognising our entries in the old file, whatever key a
 * user rewrote the program under, so the migration removes ours and keeps
 * anything pasted beside them. Copilot's shape is a **flat list of entries**
 * per event, with no `{ matcher, hooks: [...] }` wrapper, so the shared strip
 * helper does not apply.
 */

const AGENT_ID = "copilot";

/**
 * The keys a hook entry may name its program with. `exec` is what we write;
 * the rest are here so an entry a user converted to a shell command by hand is
 * still recognised as ours and gets replaced instead of duplicated.
 */
const PROGRAM_KEYS = ["exec", "command", "bash", "powershell"] as const;

export function hooksPath(configHome: string): string {
  return join(configHome, "hooks", "armadra.json");
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
