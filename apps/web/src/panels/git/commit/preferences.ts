/**
 * 提交页自己的两项本地偏好：变更树的排列方式，以及每个工作空间最近用过的提交
 * 信息。两者都只存在这台机器上——Runtime 不关心它们，同步过去也没有意义。
 *
 * 历史信息按**工作空间**分开存：不同项目的提交信息互相之间毫无用处，混在一个
 * 列表里只会让下拉框里全是别的仓库的句子。
 */
import { readStored, writeStored } from "../../../app/preferences/storage";
import type { ChangeLayout } from "./build-change-tree";

const LAYOUT_KEY = "armadra.git.commitLayout";
const MESSAGES_KEY = "armadra.git.commitMessages";

/** 下拉框里最多这么多条；再多就不是「最近用过的」而是一份日志了。 */
export const MESSAGE_HISTORY_LIMIT = 20;

export function storedChangeLayout(): ChangeLayout {
  return readStored(LAYOUT_KEY) === "flat" ? "flat" : "tree";
}

export function writeChangeLayout(layout: ChangeLayout): void {
  writeStored(LAYOUT_KEY, layout);
}

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
