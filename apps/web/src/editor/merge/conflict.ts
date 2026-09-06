import type { GitConflictFile, GitConflictSide } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { merge3 } from "@/lib/merge3";
import { useMergeStore } from "./merge-store";

/**
 * 打开一个冲突文件的三方合并视图。
 *
 * 三份原文取自 **Git 索引**（`git/repository/integration` 已经给出 base /
 * ours / theirs 三个 blob），而不是去解析工作区文件里的冲突标记：标记里
 * 只有在 `diff3` 风格下才有 base，而三方合并没有 base 就只是二选一。
 *
 * 打不开时说清楚是为什么——二进制、超出预览上限、这条路径不在冲突列表里——
 * 而不是给一个空的合并视图。
 */

/** 工作区文件里有没有冲突标记。编辑器据此决定要不要给出合并入口。 */
const MARKER = /^(<{7}|={7}|>{7}|\|{7})(?: |$)/m;

export function hasConflictMarkers(text: string): boolean {
  return MARKER.test(text);
}

export async function openMergeView(
  workspaceId: string,
  path: string,
): Promise<void> {
  const store = useMergeStore.getState();
  store.begin({ workspaceId, path });
  try {
    const snapshot = await runtimeApi.gitRepositoryIntegration(workspaceId);
    const entry = snapshot.conflicts.find((file) => file.path === path);
    if (!entry) {
      useMergeStore.getState().refuse("notConflicted");
      return;
    }
    const refusal = unusable(entry);
    if (refusal) {
      useMergeStore.getState().refuse(refusal);
      return;
    }
    // 工作区文件只用来取内容版本与 BOM：合并结果要写回它，而写回需要
    // 「读到的是哪一版」。正文本身来自索引里的三个 blob。
    const current = await runtimeApi.readFile(workspaceId, path);
    useMergeStore.getState().ready({
      regions: merge3(
        entry.base?.preview ?? "",
        entry.ours?.preview ?? "",
        entry.theirs?.preview ?? "",
      ),
      expectedSha256: current.sha256 ?? null,
      bom: current.bom === true,
      trailingNewline: current.content.endsWith("\n"),
    });
  } catch (error) {
    useMergeStore
      .getState()
      .refuse(error instanceof Error ? error.message : "unavailable");
  }
}

/** 为什么这个冲突开不了合并视图；能开就是 `null`。 */
function unusable(entry: GitConflictFile): string | null {
  // base 缺席是「两边都新建了这个文件」，那不是三方合并，是二选一；说出来
  // 比拿一个空 base 假装能合更诚实。
  if (!entry.ours || !entry.theirs) return "sideMissing";
  for (const side of [entry.base, entry.ours, entry.theirs]) {
    const refusal = sideUnusable(side);
    if (refusal) return refusal;
  }
  return null;
}

function sideUnusable(side: GitConflictSide | null): string | null {
  if (!side) return null;
  if (side.mode === "160000") return "submodule";
  if (side.truncated) return "truncated";
  if (side.binary) return "binary";
  return null;
}
