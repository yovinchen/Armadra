/**
 * 统一库迁移的单向门。
 *
 * 迁移只有一个目录（`db/migrations`，0001–0020 一条序列），这里不再解析第二
 * 个目录，只留下门本身的事实：0015 是那道门。
 *
 * 门一旦过去就回不来：应用 0015 之后的 `canvas.db` 里多了一条旧实现不认识的
 * 迁移，命中「版本本构建不认识」的拒绝规则。回滚不是再跑一条迁移，而是用应用
 * 前那份备份替换整个文件——这就是 {@link backupPath} 存在的理由。已经装了旧
 * 版本的机器上这道门仍然可能第一次经过，所以备份逻辑照旧。
 */

/** 统一库迁移的版本号。账本里出现它就意味着单向门已经过去了。 */
export const UNIFIED_VERSION = 15;

/** 备份文件名的前缀，`canvas.db.before-ts-core-<ts>`。 */
export const BACKUP_PREFIX = "before-ts-core";

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
