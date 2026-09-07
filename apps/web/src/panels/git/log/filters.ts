import type { GitPreferences } from "../../../app/preferences/git";
import { REF_SEPARATOR } from "./build-tree";
import { GIT_LOG_PAGE_SIZE } from "./log-client";
import type { GitLogRequest } from "./types";

/**
 * 工具栏筛选 → `POST …/git/log` 的请求体（Git 工具窗口设计 §2.2、§3.1）。
 *
 * **筛选全部在服务端执行**，前端一条都不过滤。理由是翻页：客户端筛选会让
 * 「没找到」和「还没翻到」长得一模一样——用户看到空列表，不知道该再滚一页
 * 还是改条件。所以这里只做一件事：把偏好里那一堆开关翻译成一个请求体，翻译
 * 本身是纯函数，测试能逐条钉住。
 *
 * 日期档位在这里落成绝对时刻。「7 天」这种相对说法必须在**发请求的那一刻**
 * 定死，否则同一个游标在跨过午夜之后指向的是另一段历史。
 */

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

export function logRequestFromPreferences(
  git: GitPreferences,
  options: { now: number; cursor?: string | null; limit?: number } = {
    now: Date.now(),
  },
): GitLogRequest {
  const references = [...new Set(git.selectedRefs.map(referenceOf))];
  const custom = git.dateRange === "custom";
  return {
    repositories: [...git.repositories],
    refs: git.showAllBranches
      ? { kind: "all", names: [] }
      : references.length > 0
        ? { kind: "named", names: references }
        : { kind: "head", names: [] },
    authors: [...git.authors],
    since: custom ? git.since || null : rangeSince(git.dateRange, options.now),
    until: custom ? git.until || null : null,
    paths: [...git.paths],
    text:
      git.searchText.trim() === ""
        ? null
        : {
            query: git.searchText,
            regex: git.searchRegex,
            matchCase: git.searchMatchCase,
          },
    cursor: options.cursor ?? null,
    limit: options.limit ?? GIT_LOG_PAGE_SIZE,
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
