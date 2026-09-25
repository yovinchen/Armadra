/**
 * 最近打开的文件（编辑器设计 §2「快速打开」）。
 *
 * 按工作空间记在这台设备的 localStorage 里，不进 core：它是「我在这台机器上
 * 刚看过什么」，换一台设备、换一个人看同一个工作空间，本来就该是另一份。
 * 写失败（隐私模式、配额满）只是少一份历史，不影响打开文件本身。
 */

const PREFIX = "armadra.recentFiles.";
/** 列表只是一个跳板，不是历史记录；二十条足够盖住一次工作里来回切的文件。 */
export const MAX_RECENT_FILES = 20;

function key(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

/** 最近的在前。存储里的东西不是字符串数组就当没有。 */
export function recentFiles(workspaceId: string): string[] {
  try {
    const raw = localStorage.getItem(key(workspaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MAX_RECENT_FILES)
      : [];
  } catch {
    return [];
  }
}

/** 把 `path` 提到最前；重复打开同一个文件不会占两格。 */
export function rememberRecentFile(workspaceId: string, path: string): void {
  if (!path) return;
  const next = [
    path,
    ...recentFiles(workspaceId).filter((entry) => entry !== path),
  ].slice(0, MAX_RECENT_FILES);
  try {
    localStorage.setItem(key(workspaceId), JSON.stringify(next));
  } catch {
    // 存不下就算了：少一条最近记录不值得打断打开文件。
  }
}

/**
 * 快速打开输入里的位置后缀：`src/a.ts:12:4`、`src/a.ts:12`、`:12`、`:12:4`。
 *
 * `path` 为空串表示「当前编辑器」。行列都是 1 起；`0` 或负数不是位置，
 * 整串照普通文件名查。
 */
export interface LocationQuery {
  path: string;
  line: number;
  column?: number;
}

const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;

export function parseLocationQuery(query: string): LocationQuery | null {
  const match = LOCATION.exec(query.trim());
  if (!match) return null;
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
    return null;
  return {
    path: match[1] ?? "",
    line,
    ...(column === undefined ? {} : { column }),
  };
}
