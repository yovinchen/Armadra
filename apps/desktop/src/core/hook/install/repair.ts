import {
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { managedContextCommand } from "./claude";
import { SKILLS_ROOT, instructionFile } from "./skills";
import {
  type JsonObject,
  type JsonValue,
  configHome,
  readJsonObject,
  writeJsonObject,
} from "./shared";

/**
 * What earlier versions of this product left in the user's CLI configuration
 * (docs/design/agent-integration.md §4).
 *
 * Two renames and one schema change are on disk out there:
 *
 *   * hook entries invoking an earlier product's binary, and entries pointing
 *     into somebody's `target/debug/` — a developer build that was installed
 *     once and then moved, so the hook silently never fires;
 *   * skill directories from before the merge, including the revision-4 pair
 *     `armadra-canvas` / `armadra-linked-context`;
 *   * Codex's `hooks.json` with a top-level `version`, which that CLI parses
 *     with `deny_unknown_fields` — one stale key and *every* hook in the file
 *     stops running, the user's included;
 *   * instruction blocks in the CLI's global `AGENTS.md` / `CLAUDE.md`, fenced
 *     with a marker comment: two hundred lines telling the model to drive the
 *     canvas through a script that rejects the current session — the model
 *     believes the instructions and never looks for the current skill.
 *
 * Three rules, in order of how much they matter:
 *
 *   1. **Recognise, never guess.** An entry is removed when its command names
 *      one of our own binaries, past or present. Everything else is reported
 *      as `kept` and written back exactly as it was read.
 *   2. **Back up before rewriting.** Any file this module rewrites is copied
 *      to `<file>.armadra-backup-<timestamp>` first. Legacy *skills* are not
 *      backed up: their body is a generated file of ours with nothing of the
 *      user's in it, and a backup beside a `SKILL.md` is a second skill the
 *      CLI would have to be taught to ignore.
 *   3. **Detect on start, change only when asked.** Start-up scans and logs;
 *      the settings page's Repair button is the only thing that writes. A
 *      machine that boots and silently edits the user's CLI configuration is
 *      the problem this module exists to clean up after.
 */

/**
 * Binaries and directories that were ours under an earlier name. A command
 * naming any of them is one we wrote, however long ago.
 */
const LEGACY_MARKERS = ["aicc-hook", "nodeterm", ".nodeterm"];

/**
 * A path into somebody's build directory. It was ours when it was written and
 * it resolves to nothing now, so it is residue either way.
 */
const DEVELOPMENT_BUILD_MARKERS = ["target/debug/", "target\\debug\\"];

/** Comment-marker prefixes earlier versions fenced their instruction blocks with. */
const LEGACY_BLOCK_PREFIXES = ["nodeterm:", "aicc:"];

/**
 * Skill directories earlier versions installed, under the CLI's skills root.
 * `armadra` itself is not here: it is the current one, and a stale revision of
 * it is reinstalled rather than removed.
 */
export const LEGACY_SKILL_DIRS = [
  "aicc-canvas",
  "aicc-linked-context",
  "get-linked-context",
  "manage-nodeterm-canvas",
  "armadra-canvas",
  "armadra-linked-context",
];

/** The providers a scan walks, in registry order. */
export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

/** One thing found, in the words the settings page shows. */
export interface LegacyFinding {
  /**
   * `hook_entry` / `skill_dir` / `codex_unknown_key` / `status_line` /
   * `instruction_block`.
   */
  readonly kind: string;
  /** The file or directory it was found in. */
  readonly path: string;
  /**
   * The command, key or directory name — enough for a person to recognise
   * something they put there themselves.
   */
  readonly detail: string;
}

/** What a repair pass did, per CLI (设计 §4). */
export interface RepairReport {
  agentId: string;
  /** Everything recognised, whether or not it was removed. */
  found: LegacyFinding[];
  /** Entries, keys and directories that are gone. */
  removed: string[];
  /** Foreign entries in the files we rewrote, left exactly as they were. */
  kept: string[];
  /** The newest backup written, for the sentence the settings page shows. */
  backup?: string;
  /** Every backup, in the order they were written. */
  backups: string[];
}

/** True when this hook command was written by a version of us that is gone. */
export function isLegacyCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    LEGACY_MARKERS.some((marker) => normalized.includes(marker)) ||
    DEVELOPMENT_BUILD_MARKERS.some((marker) => normalized.includes(marker))
  );
}

/* ---------------------------------- scan ---------------------------------- */

/** What this machine still carries for one provider, without changing anything. */
export function scan(agentId: string): LegacyFinding[] {
  return scanIn(agentId, configHome(agentId));
}

/**
 * Every provider's findings, in registry order. Used by startup detection,
 * where one provider's unreadable file must not hide the rest.
 */
export function scanAll(): LegacyFinding[] {
  return AGENT_IDS.flatMap((agentId) => {
    try {
      return scan(agentId);
    } catch {
      return [];
    }
  });
}

/**
 * The scan, with the config home passed in so the fixtures can be real file
 * shapes rather than the machine's own directories.
 */
export function scanIn(agentId: string, home: string): LegacyFinding[] {
  const found: LegacyFinding[] = [];
  for (const path of hookFiles(agentId, home)) {
    found.push(...scanHookFile(agentId, path));
  }
  for (const path of generatedModuleFiles(agentId, home)) {
    if (readText(path).some(isLegacyCommand)) {
      found.push(finding("hook_entry", path, basename(path)));
    }
  }
  found.push(...scanSkills(home));
  for (const path of instructionFiles(agentId, home)) {
    for (const [name] of legacyBlocks(readText(path)[0] ?? "")) {
      found.push(finding("instruction_block", path, name));
    }
  }
  return found;
}

function finding(kind: string, path: string, detail: string): LegacyFinding {
  return { kind, path, detail };
}

function readText(path: string): [string] | [] {
  try {
    return [readFileSync(path, "utf8")];
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The global instruction files a provider reads and earlier versions wrote into. */
function instructionFiles(agentId: string, home: string): string[] {
  const files = [instructionFile(home)];
  if (agentId === "claude") files.push(join(home, "CLAUDE.md"));
  return files.filter(isFile);
}

/**
 * Every legacy block in an instruction file: its name and its character range,
 * start marker through end marker inclusive. A start without its end is not a
 * block we recognise, and is left alone.
 */
export function legacyBlocks(text: string): [string, [number, number]][] {
  const blocks: [string, [number, number]][] = [];
  let cursor = 0;
  for (;;) {
    const offset = text.indexOf("<!-- ", cursor);
    if (offset < 0) break;
    const nameStart = offset + "<!-- ".length;
    const close = text.indexOf(" -->", nameStart);
    if (close < 0) break;
    const marker = text.slice(nameStart, close);
    cursor = close + " -->".length;
    if (!marker.endsWith(":start")) continue;
    const name = marker.slice(0, -":start".length);
    if (!LEGACY_BLOCK_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    const endMarker = `<!-- ${name}:end -->`;
    const endOffset = text.indexOf(endMarker, cursor);
    if (endOffset < 0) continue;
    const end = endOffset + endMarker.length;
    blocks.push([name, [offset, end]]);
    cursor = end;
  }
  return blocks;
}

/**
 * The file without its legacy blocks, and the names of what went. The text
 * around them is kept character for character; only the blank lines a removed
 * block leaves behind are collapsed to one.
 */
export function stripLegacyBlocks(text: string): [string, string[]] {
  const blocks = legacyBlocks(text);
  if (blocks.length === 0) return [text, []];
  let out = "";
  let cursor = 0;
  const names: string[] = [];
  for (const [name, [start, end]] of blocks) {
    out += text.slice(cursor, start);
    cursor = end;
    names.push(name);
  }
  out += text.slice(cursor);

  let collapsed = "";
  let blank = 0;
  for (const line of out.split("\n").slice(0, -1).concat(lastLine(out))) {
    if (line.trim() === "") {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    collapsed += `${line}\n`;
  }
  return [collapsed, names];
}

/** `lines()` in Rust drops a trailing newline's empty tail; this matches it. */
function lastLine(text: string): string[] {
  const parts = text.split("\n");
  const tail = parts[parts.length - 1] ?? "";
  return tail === "" ? [] : [tail];
}

/**
 * The JSON files a provider keeps hook entries in. Copilot merges a whole
 * directory, so every file in it is ours to look at — and none of them is ours
 * to rewrite unless it holds one of our commands.
 */
function hookFiles(agentId: string, home: string): string[] {
  switch (agentId) {
    case "claude":
      return [join(home, "settings.json")];
    case "codex":
      return [join(home, "hooks.json")];
    case "copilot":
      return jsonFiles(join(home, "hooks"));
    default:
      return [];
  }
}

/** The generated modules a provider auto-discovers, ours or a predecessor's. */
function generatedModuleFiles(agentId: string, home: string): string[] {
  const directory =
    agentId === "opencode"
      ? join(home, "plugins")
      : agentId === "pi" || agentId === "omp"
        ? join(home, "extensions")
        : undefined;
  if (directory === undefined) return [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(directory, name))
    .filter((path) => isFile(path) && [".js", ".ts"].includes(extname(path)));
}

function jsonFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(directory, name))
    .filter((path) => isFile(path) && extname(path) === ".json")
    .sort();
}

function scanHookFile(agentId: string, path: string): LegacyFinding[] {
  let document: JsonObject;
  try {
    document = readJsonObject(path);
  } catch {
    // A file we cannot parse is not residue we recognise. Codex reports it
    // itself, and guessing at its contents is how a repair turns into a
    // deletion.
    return [];
  }
  const found: LegacyFinding[] = [];
  if (agentId === "codex") {
    for (const key of Object.keys(document)) {
      if (key !== "description" && key !== "hooks") {
        found.push(finding("codex_unknown_key", path, key));
      }
    }
  }
  const command = statusLineCommand(document);
  if (command !== undefined && isRetiredStatusLine(command)) {
    found.push(finding("status_line", path, command));
  }
  for (const entry of hookCommands(document)) {
    if (isLegacyCommand(entry)) found.push(finding("hook_entry", path, entry));
  }
  return found;
}

/**
 * A status line this product wrote, under any of its names. The current name
 * is in here too: the `context-usage` subcommand it calls was removed with the
 * context readout, and a settings file still pointing at it would run a
 * no-op on every status refresh.
 */
function isRetiredStatusLine(command: string): boolean {
  return isLegacyCommand(command) || managedContextCommand(command);
}

function statusLineCommand(document: JsonObject): string | undefined {
  const statusLine = document.statusLine;
  if (
    typeof statusLine !== "object" ||
    statusLine === null ||
    Array.isArray(statusLine)
  ) {
    return undefined;
  }
  return typeof statusLine.command === "string"
    ? statusLine.command
    : undefined;
}

/**
 * Every command string under `hooks`, in both shapes: the grouped one Claude
 * and Codex use, and Copilot's flat list of entries with `exec`/`args`.
 */
function hookCommands(document: JsonObject): string[] {
  const commands: string[] = [];
  const events = document.hooks;
  if (typeof events !== "object" || events === null || Array.isArray(events)) {
    return commands;
  }
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers =
        typeof group === "object" && group !== null && !Array.isArray(group)
          ? group.hooks
          : undefined;
      if (Array.isArray(handlers)) {
        for (const handler of handlers) {
          const command = entryCommand(handler);
          if (command !== undefined) commands.push(command);
        }
      } else {
        const command = entryCommand(group);
        if (command !== undefined) commands.push(command);
      }
    }
  }
  return commands;
}

/** The program an entry runs, in whichever key that entry spells it with. */
function entryCommand(entry: JsonValue): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  for (const key of ["command", "exec", "bash", "powershell"]) {
    const value = entry[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function scanSkills(home: string): LegacyFinding[] {
  const root = join(home, SKILLS_ROOT);
  return LEGACY_SKILL_DIRS.map((name) => join(root, name))
    .filter((path) => isFile(join(path, "SKILL.md")))
    .map((path) => finding("skill_dir", path, basename(path)));
}

/* --------------------------------- repair --------------------------------- */

export function repair(agentId: string): RepairReport {
  return repairIn(agentId, configHome(agentId));
}

/**
 * Backs up, removes what it recognises, and rewrites each file in the current
 * shape. Everything it does not recognise is reported and left alone.
 */
export function repairIn(
  agentId: string,
  home: string,
  now: Date = new Date(),
): RepairReport {
  const report: RepairReport = {
    agentId,
    found: scanIn(agentId, home),
    removed: [],
    kept: [],
    backups: [],
  };
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);

  for (const path of hookFiles(agentId, home)) {
    repairHookFile(agentId, path, stamp, report);
  }
  for (const path of generatedModuleFiles(agentId, home)) {
    if (readText(path).some(isLegacyCommand)) {
      rmSync(path, { force: true });
      report.removed.push(path);
    }
  }
  for (const entry of report.found.filter((one) => one.kind === "skill_dir")) {
    // The body is a generated file of ours; what a user may have put beside it
    // is not, so the directory goes only when nothing else is in it.
    rmSync(join(entry.path, "SKILL.md"), { force: true });
    try {
      rmdirSync(entry.path);
      report.removed.push(entry.path);
    } catch {
      report.removed.push(join(entry.path, "SKILL.md"));
      report.kept.push(entry.path);
    }
  }
  for (const path of instructionFiles(agentId, home)) {
    repairInstructionFile(path, stamp, report);
  }
  report.backup = report.backups[report.backups.length - 1];
  return report;
}

/**
 * Backs the instruction file up, drops the marked blocks, and writes the rest
 * back exactly as it was — or removes the file if nothing else was in it.
 */
function repairInstructionFile(
  path: string,
  stamp: string,
  report: RepairReport,
): void {
  const [text] = readText(path);
  if (text === undefined) return;
  const [stripped, names] = stripLegacyBlocks(text);
  if (names.length === 0) return;
  const backup = backupPath(path, stamp);
  copyFileSync(path, backup);
  report.backups.push(backup);
  if (stripped.trim() === "") {
    rmSync(path, { force: true });
    report.removed.push(path);
  } else {
    writeFileSync(path, stripped, "utf8");
    report.kept.push(`${path}: everything outside the marked blocks`);
  }
  for (const name of names) report.removed.push(`${path}: <!-- ${name} -->`);
}

function repairHookFile(
  agentId: string,
  path: string,
  stamp: string,
  report: RepairReport,
): void {
  let document: JsonObject;
  try {
    document = readJsonObject(path);
  } catch {
    return;
  }
  const removed: string[] = [];
  const kept: string[] = [];

  if (agentId === "codex") {
    // Codex reads this file with `deny_unknown_fields`: one stale key and none
    // of its hooks run, the user's included.
    for (const key of Object.keys(document)) {
      if (key !== "description" && key !== "hooks") {
        removed.push(`${path}: ${key}`);
        delete document[key];
      }
    }
  }
  const command = statusLineCommand(document);
  if (command !== undefined && isRetiredStatusLine(command)) {
    delete document.statusLine;
    removed.push(`${path}: statusLine`);
  }
  const events = document.hooks;
  if (typeof events === "object" && events !== null && !Array.isArray(events)) {
    stripLegacyEntries(events, path, removed, kept);
    if (Object.keys(events).length === 0) delete document.hooks;
  }

  if (removed.length === 0) {
    report.kept.push(...kept);
    return;
  }
  const backup = backupPath(path, stamp);
  copyFileSync(path, backup);
  report.backups.push(backup);
  // Copilot's file is ours outright: once our entries are gone there is
  // nothing for it to say, and an empty `{"version":1}` is a file the user has
  // to wonder about later.
  if (document.hooks === undefined && isOursAlone(agentId, path, document)) {
    rmSync(path, { force: true });
    removed.push(path);
  } else {
    writeJsonObject(path, document);
  }
  report.removed.push(...removed);
  report.kept.push(...kept);
}

/** Whether a file with no hooks left in it has nothing of the user's either. */
function isOursAlone(
  agentId: string,
  path: string,
  document: JsonObject,
): boolean {
  return (
    agentId === "copilot" &&
    basename(path) === "armadra.json" &&
    Object.keys(document).every((key) => key === "version")
  );
}

/**
 * Removes every legacy entry from a `hooks` map in either shape, recording
 * what went and what stayed.
 */
function stripLegacyEntries(
  events: JsonObject,
  path: string,
  removed: string[],
  kept: string[],
): void {
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        continue;
      }
      const handlers = group.hooks;
      if (Array.isArray(handlers)) {
        group.hooks = handlers.filter((handler) =>
          retainEntry(handler, path, event, removed, kept, "hooks"),
        );
      }
    }
    // Copilot's flat shape: the group *is* the entry.
    const surviving = groups.filter((group) => {
      const handlers =
        typeof group === "object" && group !== null && !Array.isArray(group)
          ? group.hooks
          : undefined;
      if (handlers !== undefined) {
        return !Array.isArray(handlers) || handlers.length > 0;
      }
      return retainEntry(group, path, event, removed, kept, "entry");
    });
    if (surviving.length === 0) delete events[event];
    else events[event] = surviving;
  }
}

function retainEntry(
  entry: JsonValue,
  path: string,
  event: string,
  removed: string[],
  kept: string[],
  shape: string,
): boolean {
  const command = entryCommand(entry);
  if (command === undefined) return true;
  if (isLegacyCommand(command)) {
    removed.push(`${path}: ${event} ${shape} → ${command}`);
    return false;
  }
  kept.push(`${path}: ${event} → ${command}`);
  return true;
}

function backupPath(path: string, stamp: string): string {
  return `${path}.armadra-backup-${stamp}`;
}
