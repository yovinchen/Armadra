import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The migration set, read from the same `.sql` files the Rust Runtime compiles
 * in.
 *
 * There is no second copy. The 14 files in `apps/runtime/migrations` are the
 * source of truth for both implementations, `migrations.lock` guards their
 * bytes, and this module reproduces — exactly — how `sqlx::migrate!` turns a
 * directory into a set of migrations:
 *
 *   * the file name is `<VERSION>_<DESCRIPTION>.sql`; the version is the
 *     integer before the first `_`, and anything that does not split that way
 *     is silently ignored;
 *   * the description is the rest with `.sql` removed and `_` replaced by a
 *     space — it goes into the ledger verbatim;
 *   * the checksum is **SHA-384 of the file's bytes**. Not SHA-256: the
 *     repository's `migrations.lock` uses SHA-256 for its own purposes and the
 *     two are easy to confuse, but a ledger written with the wrong digest is a
 *     database neither implementation can open again;
 *   * a file that begins with `-- no-transaction` opts out of the wrapping
 *     transaction.
 */

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
  /** SHA-384 over the file's bytes. */
  readonly checksum: Buffer;
  readonly noTransaction: boolean;
  readonly file: string;
}

export function checksum(sql: Buffer | string): Buffer {
  return createHash("sha384").update(sql).digest();
}

/**
 * Reads a migration directory in the order the ledger records them.
 *
 * Down migrations are skipped: `preflight` compares a ledger of applied
 * migrations against what this build can apply, and a `.down.sql` is neither.
 */
export function loadMigrations(directory: string): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (!statSync(path).isFile()) continue;
    const separator = name.indexOf("_");
    if (separator <= 0) continue;
    const rest = name.slice(separator + 1);
    if (!rest.endsWith(".sql")) continue;
    // `.down.sql` reverts; this build only ever rolls forward.
    if (rest.endsWith(".down.sql")) continue;
    const version = Number(name.slice(0, separator));
    if (!Number.isInteger(version)) {
      throw new Error(
        `error parsing migration filename ${JSON.stringify(name)}; expected integer version prefix`,
      );
    }
    const bytes = readFileSync(path);
    const sql = bytes.toString("utf8");
    migrations.push({
      version,
      description: rest
        .slice(
          0,
          rest.length -
            (rest.endsWith(".up.sql") ? ".up.sql".length : ".sql".length),
        )
        .replace(/_/g, " "),
      sql,
      checksum: checksum(bytes),
      noTransaction: sql.startsWith("-- no-transaction"),
      file: path,
    });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * Where the `.sql` files are, in the order a running core should look.
 *
 * A packaged shell stages them beside its resources; a development run walks
 * up from `from` (the built bundle's own directory) until it finds the
 * checkout. `ARMADRA_MIGRATIONS_DIR` overrides both, which is how a test points
 * one core at a fixture directory without moving anything.
 */
export function resolveMigrationsDir(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly resourcesPath?: string | undefined;
  readonly from?: string;
}): string {
  const env = options.env ?? process.env;
  if (env.ARMADRA_MIGRATIONS_DIR) return env.ARMADRA_MIGRATIONS_DIR;
  if (options.resourcesPath) {
    const staged = join(options.resourcesPath, "migrations");
    if (existsSync(staged)) return staged;
  }
  const found = findUpwards(
    options.from ?? process.cwd(),
    "apps/runtime/migrations",
  );
  if (found !== undefined) return found;
  throw new Error(
    "could not find the migration directory; set ARMADRA_MIGRATIONS_DIR",
  );
}

function findUpwards(from: string, relative: string): string | undefined {
  let directory = resolve(from);
  for (;;) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
