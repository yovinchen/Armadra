import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 迁移集，读自 `apps/desktop/src/core/db/migrations` —— 唯一的迁移目录。
 *
 * 0001–0020 是一条连续序列：1–14 是这个库从一开始就有的那些，15 起是统一库
 * 之后加的。`migrations.lock` 守住它们的字节。文件名到迁移的读法沿用最初那套
 * 目录约定，一个字节都不能变（已发布的账本里记着按它算出的校验和）：
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
 * 那一个 `.sql` 目录在哪，按运行中的 core 该找的顺序。
 *
 * 打好包的壳把它放在资源目录下的 `migrations/`（`after-pack.mjs` 放进去的）；
 * 开发时从 `from`（产物自己所在的目录）往上走到检出。
 * `ARMADRA_CORE_MIGRATIONS_DIR` 覆盖两者，测试用它把一个 core 指到夹具目录，
 * 不用移动任何东西。
 */
export function resolveMigrationsDir(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly resourcesPath?: string | undefined;
  readonly from?: string;
}): string {
  const env = options.env ?? process.env;
  if (env.ARMADRA_CORE_MIGRATIONS_DIR) return env.ARMADRA_CORE_MIGRATIONS_DIR;
  if (options.resourcesPath) {
    const staged = join(options.resourcesPath, "migrations");
    if (existsSync(staged)) return staged;
  }
  const found = findUpwards(
    options.from ?? process.cwd(),
    "apps/desktop/src/core/db/migrations",
  );
  if (found !== undefined) return found;
  throw new Error(
    "could not find the migration directory; set ARMADRA_CORE_MIGRATIONS_DIR",
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
