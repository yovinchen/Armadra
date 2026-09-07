/**
 * 提交页每个工作空间最近用过的提交信息。只存在这台机器上——Runtime 不关心它，
 * 同步过去也没有意义。
 *
 * 历史信息按**工作空间**分开存：不同项目的提交信息互相之间毫无用处，混在一个
 * 列表里只会让下拉框里全是别的仓库的句子。
 *
 * 变更树的排列方式已经并进 `app/preferences/git.ts` 的 `GitPreferences`，这一项
 * 没有跟着走：`GitPreferences` 的每个字段都是扁平标量或字符串数组，读写共用一张
 * `GIT_KEYS` 表、`serializeGitPreference` 一个函数就够；而这里是
 * `Record<workspaceId, string[]>`，写入时还要按工作空间去重并截断。把它塞进那个
 * 模型，等于让 `setGitPreference` 为一个字段多认识一种形状。
 */
import { readStored, writeStored } from "../../../app/preferences/storage";

const MESSAGES_KEY = "armadra.git.commitMessages";

/** 下拉框里最多这么多条；再多就不是「最近用过的」而是一份日志了。 */
export const MESSAGE_HISTORY_LIMIT = 20;

function allMessages(): Record<string, string[]> {
  const raw = readStored(MESSAGES_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const result: Record<string, string[]> = {};
    for (const [workspaceId, value] of Object.entries(parsed))
      if (Array.isArray(value))
        result[workspaceId] = value
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MESSAGE_HISTORY_LIMIT);
    return result;
  } catch {
    // 坏数据当作没存过：一个解不开的历史列表不该让提交页打不开。
    return {};
  }
}

export function storedMessages(workspaceId: string): string[] {
  return allMessages()[workspaceId] ?? [];
}

/**
 * 记下刚提交出去的那条信息。同一条再提交一次时移到最前，而不是留两份——列表
 * 是「最近用过的」，重复项只会把别的挤出去。
 */
export function rememberMessage(
  workspaceId: string,
  message: string,
): string[] {
  const trimmed = message.trim();
  if (!trimmed) return storedMessages(workspaceId);
  const store = allMessages();
  const next = [
    trimmed,
    ...(store[workspaceId] ?? []).filter((entry) => entry !== trimmed),
  ].slice(0, MESSAGE_HISTORY_LIMIT);
  store[workspaceId] = next;
  writeStored(MESSAGES_KEY, JSON.stringify(store));
  return next;
}
