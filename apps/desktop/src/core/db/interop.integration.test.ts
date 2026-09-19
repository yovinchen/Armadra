import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./open";
import { loadMigrations } from "./migrations";

/**
 * The bidirectional database test.
 *
 * This is the one check that can prove the ledger was reimplemented correctly,
 * because the only authority on "correct" is the Rust binary a user already has
 * installed. A database it created must open here, and a database created here
 * must carry a ledger identical to the one it would have written — same
 * versions, same descriptions, same SHA-384 checksums.
 *
 * It needs `target/debug/armadra-runtime`, so it is skipped when that binary is
 * not built rather than failing a checkout that has never run cargo.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const migrationsDir = join(repoRoot, "apps/desktop/src/core/db/migrations");
const rustBinary =
  process.env.ARMADRA_RUNTIME_BINARY ??
  join(
    process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target"),
    "debug",
    "armadra-runtime",
  );

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

interface LedgerRow {
  version: number;
  description: string;
  success: number;
  checksum: string;
}

function ledgerOf(path: string): LedgerRow[] {
  const database = new DatabaseSync(path);
  try {
    return (
      database
        .prepare(
          "SELECT version, description, success, hex(checksum) AS checksum " +
            "FROM _sqlx_migrations ORDER BY version",
        )
        .all() as {
        version: unknown;
        description: string;
        success: unknown;
        checksum: string;
      }[]
    ).map((row) => ({
      version: Number(row.version),
      description: row.description,
      success: Number(row.success),
      checksum: row.checksum,
    }));
  } finally {
    database.close();
  }
}

/**
 * Runs the Rust Runtime long enough for it to create and migrate a database,
 * then stops it. `--listen tcp:127.0.0.1:0` keeps it off any port a developer
 * might be using, and its own data directory keeps it away from a real install.
 */
function rustCreates(dataDir: string): void {
  execFileSync(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const child = spawn(process.argv[1], ["--listen", "tcp:127.0.0.1:0"], {
         env: { ...process.env, ARMADRA_DATA_DIR: process.argv[2] },
         stdio: "ignore",
       });
       const stop = () => { child.kill("SIGTERM"); };
       const started = Date.now();
       const wait = setInterval(() => {
         if (require("node:fs").existsSync(process.argv[2] + "/canvas.db") || Date.now() - started > 25000) {
           clearInterval(wait);
           setTimeout(stop, 1500);
         }
       }, 200);
       child.on("exit", () => process.exit(0));`,
      rustBinary,
      dataDir,
    ],
    { timeout: 60_000, stdio: "ignore" },
  );
}

describe.skipIf(!existsSync(rustBinary))(
  "a database both implementations open",
  () => {
    it("opens one the Rust Runtime created, without changing its ledger", () => {
      const dataDir = mkdtempSync(join(tmpdir(), "armadra-rust-"));
      rustCreates(dataDir);
      const path = join(dataDir, "canvas.db");
      expect(existsSync(path)).toBe(true);

      const before = ledgerOf(path);
      expect(before).toHaveLength(14);

      const opened = openDatabase({ file: path, migrationsDir });
      closing.push(opened.close);
      expect(ledgerOf(path)).toEqual(before);
    }, 90_000);

    it("writes the ledger the Rust Runtime would have written", () => {
      const rustDir = mkdtempSync(join(tmpdir(), "armadra-rust-"));
      rustCreates(rustDir);
      const rust = ledgerOf(join(rustDir, "canvas.db"));

      const ours = join(
        mkdtempSync(join(tmpdir(), "armadra-ts-")),
        "canvas.db",
      );
      const opened = openDatabase({ file: ours, migrationsDir });
      opened.close();

      // `installed_on` and `execution_time` are per-run facts and are not
      // compared; everything a future build checks is.
      expect(ledgerOf(ours)).toEqual(rust);
      expect(rust.map((row) => row.checksum)).toEqual(
        loadMigrations(migrationsDir).map((migration) =>
          migration.checksum.toString("hex").toUpperCase(),
        ),
      );
    }, 90_000);
  },
);
