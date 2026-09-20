import { statSync } from "node:fs";
import { join } from "node:path";
import type { CoreContext } from "../main";
import { databaseFile } from "../paths";
import { settingsDomain } from "../settings";
import { answered } from "../workspaces/routes";
import { DomainError } from "../workspaces/support";

/**
 * `/api/data/*` — the settings page's "data" section.
 *
 * `info` is what the page prints: where the data lives, how big the database
 * is, how many conversations the index holds, and the log retention it will
 * apply. `backup` copies the database with `VACUUM INTO`, the same way the
 * one-way migration gate takes its backup: one read transaction, committed
 * WAL content included, never a half-written page.
 */

export interface DataInfo {
  readonly dataDir: string;
  readonly dbBytes: number;
  readonly conversations: number;
  readonly boardLogRetentionDays: number;
}

export function dataInfo(context: CoreContext): DataInfo {
  const file = databaseFile(context.dataDir);
  let dbBytes = 0;
  try {
    dbBytes = statSync(file).size;
    // The WAL holds committed rows the main file has not absorbed yet.
    dbBytes += statSync(`${file}-wal`).size;
  } catch {
    // A missing WAL is a database that has just been checkpointed.
  }
  const row = context.db.database
    .prepare("SELECT count(*) AS n FROM conversations")
    .get() as { n: number } | undefined;
  const settings = settingsDomain()?.settings.snapshot() ?? {};
  const logs = (settings as { logs?: { retentionDays?: unknown } }).logs;
  const days =
    typeof logs?.retentionDays === "number" && logs.retentionDays >= 0
      ? logs.retentionDays
      : 0;
  return {
    dataDir: context.dataDir,
    dbBytes,
    conversations: Number(row?.n ?? 0),
    boardLogRetentionDays: days,
  };
}

export interface DataBackup {
  readonly path: string;
  readonly bytes: number;
}

export function backupDatabase(
  context: CoreContext,
  now: () => Date = () => new Date(),
): DataBackup {
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const target = join(context.dataDir, `canvas.db.backup-manual-${stamp}`);
  try {
    context.db.database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (error) {
    throw new DomainError(
      500,
      "internal",
      `Could not write the backup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: target, bytes: statSync(target).size };
}

export function install(context: CoreContext): void {
  const { server } = context;
  server.router.handle(
    "GET",
    "/api/data/info",
    answered(() => ({ status: 200, body: dataInfo(context) })),
  );
  server.router.handle(
    "POST",
    "/api/data/backup",
    answered(() => ({ status: 200, body: backupDatabase(context) })),
  );
}
