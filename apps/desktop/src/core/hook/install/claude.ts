import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readJsonObject,
  stripManagedHandlers,
  takeEvents,
  writeJsonObject,
} from "./shared";

/**
 * Claude Code — what an earlier Armadra left in the user's own
 * `settings.json`, and how it is taken back out.
 *
 * Claude's hooks, skill and canvas instructions all reach it on the launch
 * line of a canvas node now (`inject.ts`: `--settings`, `--plugin-dir`,
 * `--append-system-prompt-file`). `--settings` was checked to be *additional*
 * rather than a replacement: with a `SessionStart` hook in
 * `$CLAUDE_CONFIG_DIR/settings.json` and another in the file passed to the
 * flag, Claude Code 2.1.260 ran **both**. So nothing of ours belongs in
 * `~/.claude/settings.json` — this module only removes what used to be there.
 *
 * ## The status line we no longer write
 *
 * An earlier build put a `statusLine` of ours into `~/.claude/settings.json`
 * to carry context telemetry. That feature is gone, and the removal takes the
 * one we used to write back out, because it would otherwise run a subcommand
 * of a removed feature on every status refresh. A status line we do not
 * plainly recognise as ours is never touched.
 */

/** The user's own file. We only ever *remove* from it now. */
export function settingsPath(configHome: string): string {
  return join(configHome, "settings.json");
}

/**
 * Removes our hook entries and our old status line from the user's own
 * `settings.json`, leaving everything else exactly as it was. Answers whether
 * anything was there.
 *
 * The migration (`migrate.ts`) runs it once, after a backup: an entry of ours
 * in `~/.claude` would fire for every session the user starts outside the
 * canvas, which is exactly what canvas-only integration rules out. The status
 * line is the same story one step further along — it names a subcommand this
 * build no longer implements, so an upgrade has to take it back out.
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
 * Whether a status-line command is one we wrote — `<our binary> context-usage`,
 * from the era that had a context readout. Exported because it is the
 * conservative half of the rule and is worth asserting directly: anything it
 * does not plainly recognise is preserved, and `repair.ts` asks the same
 * question of every CLI's settings file.
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
