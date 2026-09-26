import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { retireGlobalEntries, settingsPath } from "./claude";
import {
  configPath as codexConfigPath,
  hooksPath as codexHooksPath,
  uninstall as uninstallCodex,
} from "./codex";
import {
  hooksPath as copilotHooksPath,
  uninstall as uninstallCopilot,
} from "./copilot";
import { modulePath } from "./extensions";
import { INJECTED_AGENTS, integrationDir } from "./inject";
import { LEGACY_SKILL_DIRS } from "./repair";
import {
  configHome,
  describe,
  isManagedCommand,
  writeAtomically,
} from "./shared";
import { SKILLS_ROOT, SKILL_NAME, revisionOf } from "./skills";

/**
 * The one-time move from global installs to canvas-only injection
 * (docs/design/canvas-only-integration.md §4).
 *
 * Until this revision Armadra installed into each CLI's own configuration:
 * Codex's `hooks.json`, Copilot's `hooks/armadra.json`, a status module in
 * OpenCode's / Pi's / OMP's scanned directories, and `skills/armadra` for all
 * six. All of it fires — or is read by the model — in sessions the user
 * starts outside the canvas. The first start of this build takes it back out:
 *
 *   * **back up first.** A file the user also edits is copied to
 *     `<file>.armadra-backup-<timestamp>` beside it, the convention the repair
 *     button uses. A file only we ever wrote (the module, `SKILL.md`) is
 *     copied under `<data>/integration/global-backup-<timestamp>/` instead: a
 *     backup beside a `SKILL.md` or in a plugin directory is one more file the
 *     CLI would scan.
 *   * **remove only ours.** Hook entries are recognised by the client's name,
 *     modules and skills by their content; anything else in the same files
 *     is written back as it was read.
 *   * **once.** The result is recorded in `<data>/integration/
 *     global-migration.json`, and a record present means "done", failures
 *     included — a start that edits the user's files again and again is the
 *     behaviour this whole change exists to end. The settings page reads the
 *     record.
 */

export interface AgentMigration {
  /** Files, entries and directories that are gone. */
  readonly removed: string[];
  /** Every backup written, in order. */
  readonly backups: string[];
  /** Why this CLI's part stopped half-way, when it did. */
  error?: string;
}

export interface MigrationRecord {
  readonly version: 1;
  readonly migratedAt: string;
  readonly agents: Record<string, AgentMigration>;
}

export interface MigrationOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Config homes by CLI; resolved from the environment when absent. */
  readonly homes?: Readonly<Record<string, string>>;
}

export function migrationPath(dataDir: string): string {
  return join(dataDir, "integration", "global-migration.json");
}

export function readMigration(dataDir: string): MigrationRecord | undefined {
  try {
    return JSON.parse(
      readFileSync(migrationPath(dataDir), "utf8"),
    ) as MigrationRecord;
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Runs the migration unless it already ran on this data directory. Answers
 * the record either way.
 */
export function migrateGlobalInstalls(
  options: MigrationOptions,
): MigrationRecord {
  const existing = readMigration(options.dataDir);
  if (existing !== undefined) return existing;
  const now = (options.now ?? (() => new Date()))();
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const vault = join(options.dataDir, "integration", `global-backup-${stamp}`);
  const agents: Record<string, AgentMigration> = {};
  for (const agentId of INJECTED_AGENTS) {
    const report: AgentMigration = { removed: [], backups: [] };
    agents[agentId] = report;
    try {
      const home = options.homes?.[agentId] ?? configHome(agentId, options.env);
      migrateOne(agentId, home, { stamp, vault, report });
      // The marker the old installer kept beside our own files.
      const marker = join(
        integrationDir(options.dataDir, agentId),
        "installed.json",
      );
      if (isFile(marker)) {
        rmSync(marker, { force: true });
        report.removed.push(marker);
      }
    } catch (error) {
      report.error = describe(error);
    }
  }
  const record: MigrationRecord = {
    version: 1,
    migratedAt: now.toISOString(),
    agents,
  };
  writeAtomically(
    migrationPath(options.dataDir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

interface Pass {
  readonly stamp: string;
  readonly vault: string;
  readonly report: AgentMigration;
}

function migrateOne(agentId: string, home: string, pass: Pass): void {
  switch (agentId) {
    case "claude":
      rewriteWithBackup(settingsPath(home), pass, () =>
        retireGlobalEntries(home),
      );
      break;
    case "codex":
      // Both files move together: the trust records in `config.toml` name the
      // handlers in `hooks.json` by index.
      if (mentionsClient(codexHooksPath(home))) {
        rewriteWithBackup(
          [codexHooksPath(home), codexConfigPath(home)],
          pass,
          () => {
            uninstallCodex(home);
            return true;
          },
        );
      }
      break;
    case "copilot":
      if (mentionsClient(copilotHooksPath(home))) {
        rewriteWithBackup(copilotHooksPath(home), pass, () => {
          uninstallCopilot(home);
          return true;
        });
      }
      break;
    default: {
      const path = modulePath(agentId, home);
      if (mentionsClient(path)) removeOwnFile(path, home, agentId, pass);
      break;
    }
  }
  for (const name of [SKILL_NAME, ...LEGACY_SKILL_DIRS]) {
    const path = join(home, SKILLS_ROOT, name, "SKILL.md");
    // Ours by content: the current skill carries a revision trailer, and the
    // legacy directory names were never anyone else's.
    if (name === SKILL_NAME && revisionOf(path) === undefined) continue;
    if (!isFile(path)) continue;
    removeOwnFile(path, home, agentId, pass);
    try {
      rmdirSync(dirname(path));
    } catch {
      // Something the user put beside it keeps the directory.
    }
  }
}

function mentionsClient(path: string): boolean {
  const text = readOrUndefined(path);
  return text !== undefined && isManagedCommand(text);
}

/**
 * Backs every existing file in `paths` up beside itself, runs `edit`, and
 * keeps only the backups of files whose bytes actually changed.
 */
function rewriteWithBackup(
  paths: string | readonly string[],
  pass: Pass,
  edit: () => boolean,
): void {
  const list = typeof paths === "string" ? [paths] : paths;
  const before = new Map<string, string>();
  for (const path of list) {
    const text = readOrUndefined(path);
    if (text === undefined) continue;
    before.set(path, text);
    copyFileSync(path, `${path}.armadra-backup-${pass.stamp}`);
  }
  if (before.size === 0) return;
  edit();
  for (const [path, text] of before) {
    const backup = `${path}.armadra-backup-${pass.stamp}`;
    const after = readOrUndefined(path);
    if (after === text) {
      rmSync(backup, { force: true });
      continue;
    }
    pass.report.backups.push(backup);
    pass.report.removed.push(
      after === undefined ? path : `${path}: armadra-hook`,
    );
  }
}

/** Copies a file only we wrote into the vault, then removes it. */
function removeOwnFile(
  path: string,
  home: string,
  agentId: string,
  pass: Pass,
): void {
  const backup = join(pass.vault, agentId, relative(home, path));
  mkdirSync(dirname(backup), { recursive: true });
  copyFileSync(path, backup);
  rmSync(path, { force: true });
  pass.report.backups.push(backup);
  pass.report.removed.push(path);
}
