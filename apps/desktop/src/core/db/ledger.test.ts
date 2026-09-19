import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREATE_LEDGER,
  LEDGER_COLUMNS,
  appliedVersions,
  preflight,
  recordApplied,
} from "./ledger";
import { type Migration, loadMigrations } from "./migrations";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = loadMigrations(
  resolve(here, "migrations"),
);

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const database of open.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test.
    }
  }
});

/** A database on disk, because `typeof()` and BLOB binding are the point. */
function database(): DatabaseSync {
  const created = new DatabaseSync(
    join(mkdtempSync(join(tmpdir(), "armadra-ledger-")), "canvas.db"),
  );
  open.push(created);
  return created;
}

function withLedger(rows: readonly Migration[] = migrations): DatabaseSync {
  const db = database();
  db.exec(CREATE_LEDGER);
  for (const migration of rows) recordApplied(db, migration, 1n);
  return db;
}

describe("a database that opens", () => {
  it("lets a brand new file through", () => {
    expect(preflight(database(), migrations)).toBeNull();
  });

  it("lets a ledger holding exactly this build's history through", () => {
    const db = withLedger();
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    expect(preflight(db, migrations)).toBeNull();
  });

  it("lets a complete prefix through, so a half-upgraded database can catch up", () => {
    const db = withLedger(migrations.slice(0, 9));
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    expect(preflight(db, migrations)).toBeNull();
  });
});

describe("the nine refusals", () => {
  it("refuses a schema with no ledger at all", () => {
    const db = database();
    db.exec("CREATE TABLE something (id TEXT)");
    expect(preflight(db, migrations)).toMatch(
      /unrecognized schema without a migration ledger/,
    );
  });

  it("refuses a ledger that is not a table", () => {
    const db = withLedger();
    db.exec("ALTER TABLE _sqlx_migrations RENAME TO ledger_rows");
    db.exec("CREATE VIEW _sqlx_migrations AS SELECT * FROM ledger_rows");
    expect(preflight(db, migrations)).toMatch(/ledger is not a table/);
  });

  it("refuses a ledger whose structure it does not recognise", () => {
    const db = database();
    db.exec("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY)");
    expect(preflight(db, migrations)).toMatch(/unrecognized structure/);
  });

  it("refuses a ledger whose primary key moved", () => {
    const db = database();
    db.exec(`CREATE TABLE _sqlx_migrations (
      version BIGINT NOT NULL,
      description TEXT NOT NULL PRIMARY KEY,
      installed_on TIMESTAMP NOT NULL,
      success BOOLEAN NOT NULL,
      checksum BLOB NOT NULL,
      execution_time BIGINT NOT NULL
    )`);
    expect(preflight(db, migrations)).toMatch(/unrecognized structure/);
  });

  it("refuses a schema with an empty ledger", () => {
    const db = database();
    db.exec(CREATE_LEDGER);
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    expect(preflight(db, migrations)).toMatch(/no recorded migrations/);
  });

  it("refuses a ledger row whose values are the wrong storage class", () => {
    const db = withLedger(migrations.slice(0, 1));
    // The column says BLOB; SQLite let a string in anyway. `typeof()` is the
    // only thing that notices, and a TEXT checksum would never compare equal.
    db.exec("UPDATE _sqlx_migrations SET checksum = 'not a blob'");
    expect(preflight(db, migrations)).toMatch(/invalid values/);
  });

  it("refuses a dirty migration", () => {
    const db = withLedger(migrations.slice(0, 3));
    db.exec("UPDATE _sqlx_migrations SET success = 0 WHERE version = 2");
    expect(preflight(db, migrations)).toBe(
      "Database migration 2 is dirty or invalid; startup refused without changing its data",
    );
  });

  it("refuses a migration this build has never heard of", () => {
    const db = withLedger(migrations.slice(0, 2));
    db.exec(
      "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) " +
        "VALUES (9001, 'from the future', TRUE, X'00', -1)",
    );
    expect(preflight(db, migrations)).toBe(
      "Database migration 9001 is unknown to this build; startup refused without changing its data",
    );
  });

  it("refuses a checksum that does not match this build", () => {
    const db = withLedger(migrations.slice(0, 5));
    db.exec("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 4");
    expect(preflight(db, migrations)).toBe(
      "Database migration 4 checksum does not match this build; startup refused without changing its data",
    );
  });

  it("refuses a history that is not a complete known prefix", () => {
    // 0001, 0002 then 0004: a schema no build of this product ever produced.
    const db = withLedger([
      migrations[0] as Migration,
      migrations[1] as Migration,
      migrations[3] as Migration,
    ]);
    expect(preflight(db, migrations)).toMatch(/not a complete known prefix/);
  });
});

describe("recording an applied migration", () => {
  it("writes the six columns sqlx writes, with a BLOB checksum", () => {
    const db = withLedger(migrations.slice(0, 1));
    const row = db
      .prepare(
        "SELECT version, description, success, checksum, execution_time, " +
          "typeof(version) AS v, typeof(checksum) AS c, typeof(success) AS s " +
          "FROM _sqlx_migrations",
      )
      .get() as Record<string, unknown>;
    expect(row.v).toBe("integer");
    expect(row.c).toBe("blob");
    expect(row.s).toBe("integer");
    expect(Number(row.version)).toBe(1);
    expect(row.description).toBe("initial");
    expect(Number(row.success)).toBe(1);
    expect(Buffer.from(row.checksum as Uint8Array)).toEqual(
      (migrations[0] as Migration).checksum,
    );
    expect(Number(row.execution_time)).toBe(1);
  });

  it("names the versions already applied, in order", () => {
    expect(appliedVersions(withLedger(migrations.slice(0, 4)))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("declares the six columns in the documented order", () => {
    expect([...LEDGER_COLUMNS]).toEqual([
      "version",
      "description",
      "installed_on",
      "success",
      "checksum",
      "execution_time",
    ]);
  });
});
