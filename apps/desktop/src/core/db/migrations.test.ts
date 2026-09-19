import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checksum, loadMigrations, resolveMigrationsDir } from "./migrations";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const migrationsDir = join(repoRoot, "apps/runtime/migrations");

describe("the migration set", () => {
  it("is the fourteen files the Rust Runtime compiles in", () => {
    const migrations = loadMigrations(migrationsDir);
    expect(migrations).toHaveLength(14);
    expect(migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
  });

  it("derives the description the way sqlx does", () => {
    const migrations = loadMigrations(migrationsDir);
    expect(migrations[0]?.description).toBe("initial");
    expect(migrations[1]?.description).toBe("agent mailbox");
    expect(migrations[8]?.description).toBe("workspace execution host");
  });

  it("checksums with SHA-384, which is what the ledger holds", () => {
    // The trap: `migrations.lock` uses SHA-256 for a different purpose, and a
    // ledger written with that digest is a database nothing can open again.
    for (const migration of loadMigrations(migrationsDir)) {
      expect(migration.checksum).toHaveLength(48);
      expect(migration.checksum).toEqual(
        createHash("sha384").update(readFileSync(migration.file)).digest(),
      );
    }
  });

  it("agrees with migrations.lock on every file's SHA-256", () => {
    // Different digest, same bytes: if the lock still matches, the files this
    // module read are the published ones, so the SHA-384 above is the right
    // answer for the right input.
    const lock = JSON.parse(
      readFileSync(join(repoRoot, "migrations.lock"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const expected = lock["apps/runtime/migrations"] as Record<string, string>;
    for (const migration of loadMigrations(migrationsDir)) {
      const name = migration.file.slice(migration.file.lastIndexOf("/") + 1);
      expect(
        createHash("sha256").update(readFileSync(migration.file)).digest("hex"),
        name,
      ).toBe(expected[name]);
    }
    expect(Object.keys(expected)).toHaveLength(14);
  });

  it("checksums a string and a buffer alike", () => {
    expect(checksum("SELECT 1;")).toEqual(checksum(Buffer.from("SELECT 1;")));
  });

  it("reads none of this build's migrations as opting out of a transaction", () => {
    for (const migration of loadMigrations(migrationsDir)) {
      expect(migration.noTransaction, migration.file).toBe(false);
    }
  });

  it("ignores files that are not migrations and honours the no-transaction marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-migrations-"));
    writeFileSync(join(directory, "0001_first.sql"), "SELECT 1;");
    writeFileSync(
      join(directory, "0002_second_thing.sql"),
      "-- no-transaction\nSELECT 2;",
    );
    writeFileSync(join(directory, "0003_down.down.sql"), "DROP TABLE x;");
    writeFileSync(join(directory, "README.md"), "not a migration");
    writeFileSync(join(directory, "notes.sql"), "no version prefix");
    const migrations = loadMigrations(directory);
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);
    expect(migrations[1]?.description).toBe("second thing");
    expect(migrations[1]?.noTransaction).toBe(true);
  });

  it("sorts by version, not by file name", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-migrations-"));
    writeFileSync(join(directory, "10_ten.sql"), "SELECT 10;");
    writeFileSync(join(directory, "9_nine.sql"), "SELECT 9;");
    expect(loadMigrations(directory).map((m) => m.version)).toEqual([9, 10]);
  });

  it("refuses a version prefix that is not an integer", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-migrations-"));
    writeFileSync(join(directory, "first_thing.sql"), "SELECT 1;");
    expect(() => loadMigrations(directory)).toThrow(/integer version prefix/);
  });
});

describe("finding the migration directory", () => {
  it("lets the environment override everything", () => {
    expect(
      resolveMigrationsDir({ env: { ARMADRA_MIGRATIONS_DIR: "/somewhere" } }),
    ).toBe("/somewhere");
  });

  it("takes a packaged shell's staged copy when it is there", () => {
    expect(
      resolveMigrationsDir({ env: {}, resourcesPath: repoRoot, from: here }),
    ).not.toBe(join(repoRoot, "migrations"));
    expect(
      resolveMigrationsDir({
        env: {},
        resourcesPath: join(repoRoot, "apps/runtime"),
        from: here,
      }),
    ).toBe(migrationsDir);
  });

  it("walks up to the checkout in development", () => {
    expect(resolveMigrationsDir({ env: {}, from: here })).toBe(migrationsDir);
  });

  it("says what to set when there is nothing to find", () => {
    expect(() => resolveMigrationsDir({ env: {}, from: tmpdir() })).toThrow(
      /ARMADRA_MIGRATIONS_DIR/,
    );
  });
});
