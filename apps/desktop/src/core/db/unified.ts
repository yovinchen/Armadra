import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 统一库迁移的单向门。
 *
 * `apps/runtime/migrations` 的 14 份 `.sql` 是两套实现共读的来源；这一份不是。
 * 它只被 TS core 读，因为 Rust Runtime 把那个目录编译进了二进制：把 0015 放
 * 进去，Rust 也会应用它，而「应用后 Rust 拒绝启动」正是设计 §7 要的单向门。
 * 所以这里是第二个目录，只在 `ARMADRA_CORE=ts` 时叠加到迁移集末尾。
 *
 * 门一旦过去就回不来：应用 0015 之后的 `canvas.db` 对 Rust 而言多了一条它不
 * 认识的迁移，命中「版本本构建不认识」的拒绝规则。回滚不是再跑一条迁移，而是
 * 用应用前那份备份替换整个文件——这就是 {@link backupPath} 存在的理由。
 */

/** 统一库迁移的版本号。账本里出现它就意味着单向门已经过去了。 */
export const UNIFIED_VERSION = 15;

/** 备份文件名的前缀，`canvas.db.before-ts-core-<ts>`。 */
export const BACKUP_PREFIX = "before-ts-core";

/**
 * 这次启动该不该叠加统一库迁移。
 *
 * 只认 `ARMADRA_CORE=ts` 这一个拼法，和壳里的开关（`runtime-process.ts`）同一
 * 条规则。没有这个变量时 core 照常起，只是身份域没有表可用，路由继续 501：
 * 「没设开关就跑单向门」是不能默认发生的事。
 */
export function unifiedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARMADRA_CORE === "ts";
}

/**
 * 统一库迁移所在目录。
 *
 * 和 `resolveMigrationsDir` 同一套找法：打好包的壳把它放在资源目录下的
 * `core-migrations/`，开发时从 `from` 往上走到检出。`ARMADRA_CORE_MIGRATIONS_DIR`
 * 覆盖两者，测试用它指向夹具。
 */
export function resolveUnifiedMigrationsDir(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly resourcesPath?: string | undefined;
  readonly from?: string;
}): string {
  const env = options.env ?? process.env;
  if (env.ARMADRA_CORE_MIGRATIONS_DIR) return env.ARMADRA_CORE_MIGRATIONS_DIR;
  if (options.resourcesPath) {
    const staged = join(options.resourcesPath, "core-migrations");
    if (existsSync(staged)) return staged;
  }
  const found = findUpwards(
    options.from ?? process.cwd(),
    "apps/desktop/src/core/db/migrations",
  );
  if (found !== undefined) return found;
  throw new Error(
    "could not find the unified migration directory; set ARMADRA_CORE_MIGRATIONS_DIR",
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

/**
 * 应用前那份备份的路径。
 *
 * 时间戳用 UTC 的 `YYYYMMDDTHHMMSSZ`，文件名里不出现冒号（Windows 不收），也不
 * 出现毫秒——同一秒内跑两次单向门这件事不存在，因为第二次时账本里已经有 15。
 */
export function backupPath(databaseFile: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${databaseFile}.${BACKUP_PREFIX}-${stamp}`;
}
