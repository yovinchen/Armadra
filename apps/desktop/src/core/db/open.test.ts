import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseRefused, openDatabase } from "./open";
import { loadMigrations } from "./migrations";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../../runtime/migrations");
const migrations = loadMigrations(migrationsDir);

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
  return join(mkdtempSync(join(tmpdir(), "armadra-open-")), "canvas.db");
}

function open(path: string) {
  const opened = openDatabase({ file: path, migrationsDir });
  closing.push(opened.close);
  return opened;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("opening the database", () => {
  it("creates the file and applies every migration", () => {
    const path = file();
    const opened = open(path);
    expect(opened.migrations).toHaveLength(14);
    const rows = opened.database
      .prepare(
        "SELECT version, description, success FROM _sqlx_migrations ORDER BY version",
      )
      .all() as { version: unknown; description: string; success: unknown }[];
    expect(rows).toHaveLength(14);
    expect(rows.map((row) => Number(row.version))).toEqual(
      migrations.map((migration) => migration.version),
    );
    expect(rows.map((row) => row.description)).toEqual(
      migrations.map((migration) => migration.description),
    );
    expect(rows.every((row) => Number(row.success) === 1)).toBe(true);
  });

  it("writes the checksums the Rust build would write", () => {
    const opened = open(file());
    const rows = opened.database
      .prepare(
        "SELECT version, checksum FROM _sqlx_migrations ORDER BY version",
      )
      .all() as { version: unknown; checksum: Uint8Array }[];
    for (const [index, row] of rows.entries()) {
      expect(Buffer.from(row.checksum)).toEqual(migrations[index]?.checksum);
    }
  });

  it("creates the tables the canvas needs, and journals in WAL", () => {
    const opened = open(file());
    const tables = (
      opened.database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of ["workspaces", "boards", "nodes", "edges"]) {
      expect(tables, table).toContain(table);
    }
    expect(
      (
        opened.database.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        }
      ).journal_mode,
    ).toBe("wal");
  });

  it("is idempotent: a second open applies nothing", () => {
    const path = file();
    open(path).close();
    const opened = open(path);
    expect(
      Number(
        (
          opened.database
            .prepare("SELECT count(*) AS n FROM _sqlx_migrations")
            .get() as {
            n: number;
          }
        ).n,
      ),
    ).toBe(14);
  });

  it("can be told to check without writing", () => {
    const path = file();
    const opened = openDatabase({ file: path, migrationsDir, migrate: false });
    closing.push(opened.close);
    expect(
      opened.database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = '_sqlx_migrations'",
        )
        .get(),
    ).toBeUndefined();
  });
});

describe("refusing a database", () => {
  it("refuses, and leaves the file byte for byte as it found it", () => {
    const path = file();
    open(path).close();
    // Quiesce the WAL so the comparison is about our behaviour, not SQLite's
    // checkpointing: this is the state a machine has after a clean shutdown.
    const quiesce = new DatabaseSync(path);
    quiesce.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    quiesce.exec(
      "UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 7",
    );
    quiesce.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    quiesce.close();

    const before = digest(path);
    expect(() => openDatabase({ file: path, migrationsDir })).toThrow(
      DatabaseRefused,
    );
    expect(digest(path)).toBe(before);
    // Nothing renamed, nothing rebuilt, nothing left beside it.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("does not rebuild a schema it does not recognise", () => {
    const path = file();
    const stranger = new DatabaseSync(path);
    stranger.exec("CREATE TABLE somebody_elses (id TEXT)");
    stranger.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    stranger.close();
    const before = digest(path);
    expect(() => openDatabase({ file: path, migrationsDir })).toThrow(
      /unrecognized schema without a migration ledger/,
    );
    expect(digest(path)).toBe(before);
  });

  it("names the refusal in a way a person can act on", () => {
    const path = file();
    open(path).close();
    const broken = new DatabaseSync(path);
    broken.exec("UPDATE _sqlx_migrations SET success = 0 WHERE version = 3");
    broken.close();
    try {
      openDatabase({ file: path, migrationsDir });
      expect.unreachable("the database should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseRefused);
      expect((error as Error).message).toBe(
        "Database migration 3 is dirty or invalid; startup refused without changing its data",
      );
    }
  });
});
