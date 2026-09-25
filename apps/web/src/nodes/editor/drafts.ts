/**
 * 未保存草稿的本机副本（编辑器设计 §3「远端断开：草稿可本机持久化」）。
 *
 * 按「工作空间 + 路径」一条，里面记着草稿是从哪个内容版本改起的：恢复时
 * 磁盘还是那一版就原样放回，磁盘变了就拿它当 base 做三方合并。两个节点
 * 打开同一个文件读写的是同一条，这正是 §3 说的「共享本设备草稿」。
 *
 * 用 localStorage 而不是 IndexedDB：页面关闭前的最后一次写必须是同步的，
 * `pagehide` 里等不到一个异步事务提交。编辑器本身只收 1 MiB 以内的文件，
 * 配额不够时写失败就是少一份备份，编辑器里的内容不受影响。
 */

const PREFIX = "armadra.editorDraft.";

export interface StoredDraft {
  /** 草稿改起时磁盘上的内容版本；文件已被删、按新建保存时没有。 */
  baseVersion?: string;
  /** 那一版的正文，三方合并的 base。 */
  base: string;
  draft: string;
  /** 毫秒时间戳，只用于排查。 */
  savedAt: number;
}

function key(workspaceId: string, path: string): string {
  return `${PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(path)}`;
}

export function readDraft(
  workspaceId: string,
  path: string,
): StoredDraft | null {
  try {
    const raw = localStorage.getItem(key(workspaceId, path));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (
      !parsed ||
      typeof parsed.base !== "string" ||
      typeof parsed.draft !== "string"
    )
      return null;
    return {
      base: parsed.base,
      draft: parsed.draft,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      ...(typeof parsed.baseVersion === "string"
        ? { baseVersion: parsed.baseVersion }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeDraft(
  workspaceId: string,
  path: string,
  draft: Omit<StoredDraft, "savedAt">,
): void {
  try {
    localStorage.setItem(
      key(workspaceId, path),
      JSON.stringify({ ...draft, savedAt: Date.now() }),
    );
  } catch {
    // 配额满或存储被禁用：编辑器里的内容还在，只是没有本机备份。
  }
}

export function clearDraft(workspaceId: string, path: string): void {
  try {
    localStorage.removeItem(key(workspaceId, path));
  } catch {
    // 同上。
  }
}
