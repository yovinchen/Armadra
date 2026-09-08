import type { GitLogRequest } from "@armadra/shared";

import type { GitPreferences } from "../../../app/preferences/git";
import { REF_SEPARATOR } from "./build-tree";

/**
 * 工具栏筛选 → `gitGateway.log` 的筛选记录（Git 工具窗口设计 §2.2、§3.1）。
 *
 * **筛选全部在服务端执行**，前端一条都不过滤。理由是翻页：客户端筛选会让
 * 「没找到」和「还没翻到」长得一模一样——用户看到空列表，不知道该再滚一页
 * 还是改条件。所以这里只做一件事：把偏好里那一堆开关翻译成一份请求，翻译
 * 本身是纯函数，测试能逐条钉住。
 *
 * 日期档位在这里落成绝对时刻。「7 天」这种相对说法必须在**发请求的那一刻**
 * 定死，否则同一个游标在跨过午夜之后指向的是另一段历史。
 */

/** 服务端一页的上限是 200（§3.1）；界面按 100 一页要。 */
export const GIT_LOG_PAGE_SIZE = 100;

const DAY = 24 * 60 * 60 * 1000;

/** 档位 → `since`。`until` 只有自定义档才给。 */
export function rangeSince(
  range: GitPreferences["dateRange"],
  now: number,
): string | null {
  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case "week":
      return new Date(now - 7 * DAY).toISOString();
    case "month":
      return new Date(now - 30 * DAY).toISOString();
    default:
      return null;
  }
}

/** 选中集合里的键是 `仓库路径 NUL 引用名`；请求要的是引用名那一半。 */
export function referenceOf(key: string): string {
  const separator = key.indexOf(REF_SEPARATOR);
  return separator < 0 ? key : key.slice(separator + REF_SEPARATOR.length);
}

/**
 * 空的集合、空串与「没选」一律**整项省略**，而不是发一个空值。
 *
 * 「没有筛选」和「筛选成空集」在服务端是两件事——`repositories: []` 不该被
 * 读成「一个仓库都不要」，所以空的一律不发，让服务端用自己的缺省。
 */
export function logRequestFromPreferences(
  git: GitPreferences,
  options: { now: number; cursor?: string | null; limit?: number } = {
    now: Date.now(),
  },
): GitLogRequest {
  const references = [...new Set(git.selectedRefs.map(referenceOf))];
  const custom = git.dateRange === "custom";
  const since = custom ? git.since : rangeSince(git.dateRange, options.now);
  const until = custom ? git.until : null;
  const cursor = options.cursor ?? null;
  return {
    // 树里点了分支就只看那些分支——「显示所有分支」是没选任何东西时的默认
    // 视图（IDEA 同此），不是压过选择的开关。
    refs:
      references.length > 0
        ? { kind: "named", names: references }
        : git.showAllBranches
          ? { kind: "all" }
          : { kind: "head" },
    limit: options.limit ?? GIT_LOG_PAGE_SIZE,
    ...(git.repositories.length > 0
      ? { repositories: [...git.repositories] }
      : {}),
    ...(git.authors.length > 0 ? { authors: [...git.authors] } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(git.paths.length > 0 ? { paths: [...git.paths] } : {}),
    ...(git.searchText.trim() === ""
      ? {}
      : {
          text: {
            query: git.searchText,
            regex: git.searchRegex,
            matchCase: git.searchMatchCase,
          },
        }),
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * 查询键：条件变了就是另一份列表，游标也跟着作废（§3.1「游标绑定筛选条件
 * 的哈希」）。日期的**绝对值**故意不进键——「7 天」这个档位才是用户选的东西，
 * 把算出来的时刻放进去会让列表每毫秒都失效一次。
 */
export function filterKey(git: GitPreferences): string {
  return JSON.stringify([
    git.repositories,
    git.showAllBranches,
    git.selectedRefs,
    git.authors,
    git.dateRange,
    git.dateRange === "custom" ? [git.since, git.until] : null,
    git.paths,
    git.searchText,
    git.searchRegex,
    git.searchMatchCase,
  ]);
}
