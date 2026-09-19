import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseRefused, openDatabase } from "./open";
import { loadMigrations } from "./migrations";
import { BACKUP_PREFIX, UNIFIED_VERSION, backupPath } from "./unified";

const here = dirname(fileURLToPath(import.meta.url));
/** 唯一的迁移目录：0001–0020 一条序列。 */
const migrationsDir = join(here, "migrations");

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // Already closed.
    }
  }
});

function file(): string {
  return join(mkdtempSync(join(tmpdir(), "armadra-unified-")), "canvas.db");
}

/**
 * 门之前的那批迁移，复制成一个夹具目录。
 *
 * 已经装了旧版本的机器上，库的账本停在 14；这个目录就是那种库的来源，也是
 * 「门后的库被一个不认识 15 的构建打开会怎样」的来源。
 */
function beforeGate(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-before-gate-"));
  for (const name of readdirSync(migrationsDir)) {
    if (Number.parseInt(name.slice(0, 4), 10) >= UNIFIED_VERSION) continue;
    copyFileSync(join(migrationsDir, name), join(directory, name));
  }
  return directory;
}

function open(path: string, gate: boolean) {
  const opened = openDatabase({
    file: path,
    migrationsDir: gate ? migrationsDir : beforeGate(),
  });
  closing.push(opened.close);
  return opened;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function backups(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) =>
    name.includes(BACKUP_PREFIX),
  );
}

describe("the one-way gate", () => {
  it("sits at 15, in one continuous sequence from 1", () => {
    const all = loadMigrations(migrationsDir);
    expect(all.map((migration) => migration.version)).toEqual(
      all.map((_, index) => index + 1),
    );
    expect(all.some((migration) => migration.version === UNIFIED_VERSION)).toBe(
      true,
    );
  });

  it("names the backup without characters a Windows path refuses", () => {
    const path = backupPath(
      "/data/canvas.db",
      new Date("2026-09-19T08:07:06.005Z"),
    );
    expect(path).toBe("/data/canvas.db.before-ts-core-20260919T080706Z");
    expect(path.includes(":")).toBe(false);
  });
});

describe("applying the unified migration", () => {
  it("adds the identity tables and records version 15", () => {
    const path = file();
    const opened = open(path, true);
    expect(opened.migrations).toHaveLength(
      loadMigrations(migrationsDir).length,
    );
    expect(opened.unified).toBe(true);
    const tables = (
      opened.database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of [
      "store_meta",
      "identity_principals",
      "identity_devices",
      "identity_sessions",
      "identity_bootstrap_tickets",
    ]) {
      expect(tables).toContain(table);
    }
    // 0019 之后单行的 `identity_owner` 不再存在：它的那一行搬进了
    // `identity_principals`，而两张表同时在会让「owner 是谁」有两个答案。
    expect(tables).not.toContain("identity_owner");
  });

  it("stops at 14 for a build whose set ends before the gate", () => {
    const path = file();
    const opened = open(path, false);
    expect(opened.migrations).toHaveLength(14);
    expect(opened.unified).toBe(false);
    expect(opened.backup).toBeNull();
    expect(backups(path)).toEqual([]);
  });

  it("writes no backup for a database that did not exist before", () => {
    const path = file();
    const opened = open(path, true);
    expect(opened.backup).toBeNull();
    expect(backups(path)).toEqual([]);
  });

  it("backs the database up before the gate, and the copy opens", () => {
    const path = file();
    open(path, false).close();
    const before = digest(path);

    const opened = open(path, true);
    expect(opened.backup).not.toBeNull();
    const backup = opened.backup as string;
    expect(existsSync(backup)).toBe(true);
    // 备份是应用 0015 之前的那个库：14 条账本，没有身份表。
    const copy = openDatabase({
      file: backup,
      migrationsDir: beforeGate(),
      migrate: false,
    });
    closing.push(copy.close);
    expect(
      copy.database
        .prepare("SELECT count(*) AS total FROM _sqlx_migrations")
        .get(),
    ).toEqual({ total: 14 });
    expect(
      copy.database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'identity_devices'",
        )
        .get(),
    ).toBeUndefined();
    // 原库已经过门：备份留在门前，原库的账本是完整的一条序列。
    expect(typeof before).toBe("string");
    expect(
      opened.database
        .prepare("SELECT count(*) AS total FROM _sqlx_migrations")
        .get(),
    ).toEqual({ total: loadMigrations(migrationsDir).length });
  });

  it("does not back up a second time once the gate is behind it", () => {
    const path = file();
    open(path, false).close();
    const first = open(path, true);
    expect(first.backup).not.toBeNull();
    first.close();
    const second = open(path, true);
    expect(second.backup).toBeNull();
    expect(second.unified).toBe(true);
    expect(backups(path)).toHaveLength(1);
  });

  it("refuses a database that already went through, to a build without 15", () => {
    // 这是门前那个构建会看到的东西：账本里有一条它不认识的 15。
    const path = file();
    open(path, true).close();
    expect(() => open(path, false)).toThrow(DatabaseRefused);
    try {
      open(path, false);
    } catch (error) {
      expect((error as Error).message).toContain(
        "Database migration 15 is unknown to this build",
      );
    }
  });

  it("leaves the database byte for byte unchanged when it refuses", () => {
    const path = file();
    open(path, true).close();
    const before = digest(path);
    expect(() => open(path, false)).toThrow(DatabaseRefused);
    expect(digest(path)).toBe(before);
  });
});
