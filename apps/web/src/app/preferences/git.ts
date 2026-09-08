import {
  readStored,
  storedBoolean,
  storedEnum,
  storedIds,
  storedNumber,
} from "./storage";

/**
 * Git 工具窗口的偏好（Git 工具窗口设计 §3.2「日志筛选、分支树展开与收藏、
 * 面板宽高进 `preferences-store` 的 `git` 段」）。
 *
 * 整段只存本地：它描述的是「这台机器上的这个人怎么看这份历史」，不是工作
 * 空间的属性。筛选也在里面——重开窗口时还停在上次的那个作者、那段日期，
 * 是这类工具窗口的常态；每一项都同时是 `POST …/git/log` 的请求字段，所以
 * 服务端筛选与「恢复上次」是同一份状态，不会各说各话。
 */

const KEY = (name: string) => `armadra.git.${name}`;

/** 日期档位。`custom` 时才读 `since` / `until` 两个日期串。 */
export const GIT_LOG_DATE_RANGES = [
  "any",
  "today",
  "week",
  "month",
  "custom",
] as const;
export type GitLogDateRange = (typeof GIT_LOG_DATE_RANGES)[number];

/**
 * 提交页变更树的排列方式。故意不从 `panels/git/commit/build-change-tree` 引
 * `ChangeLayout`：偏好这一层不该反过来依赖某一个面板，两边是结构相同的字面量
 * 联合，赋值本来就通得过。
 */
export const GIT_CHANGE_LAYOUTS = ["tree", "flat"] as const;
export type GitChangeLayout = (typeof GIT_CHANGE_LAYOUTS)[number];

export interface GitPreferences {
  /** 底部窗口高度，px。`0` = 还没拖过，用 `--git-window-h`（40vh）。 */
  windowHeight: number;
  /** 上一次是不是最大化的。 */
  maximized: boolean;
  /** 左栏（分支树）收起。 */
  treeCollapsed: boolean;
  /** 右栏（提交详情）收起。 */
  detailsCollapsed: boolean;
  /** 三栏的百分比宽度，只记两侧；中间那栏永远是剩下的。 */
  treeWidth: number;
  detailsWidth: number;
  /** 收藏的分支，键由 `log/build-tree.ts` 的 `refKey()` 造；置顶用。 */
  favorites: string[];
  /** 展开的树节点 id。 */
  expanded: string[];
  /** 搜索框。 */
  searchText: string;
  searchRegex: boolean;
  searchMatchCase: boolean;
  /** 选中的分支（同样是 `refKey()` 的键）；空 = `HEAD`。 */
  selectedRefs: string[];
  /** 作者筛选（邮箱或名字）。 */
  authors: string[];
  dateRange: GitLogDateRange;
  since: string;
  until: string;
  /** 路径筛选：仓库多选 + 目录路径。空的仓库列表 = 全部仓库。 */
  repositories: string[];
  paths: string[];
  /** 设置菜单四项。 */
  showAllBranches: boolean;
  highlightMine: boolean;
  compactRows: boolean;
  showHashColumn: boolean;
  /** 详情里的变更文件：树形（false）还是平铺（true）。 */
  flatFiles: boolean;
  /** 提交页变更树的排列方式。 */
  changeLayout: GitChangeLayout;
}

export const GIT_KEYS: Record<keyof GitPreferences, string> = {
  windowHeight: KEY("windowHeight"),
  maximized: KEY("maximized"),
  treeCollapsed: KEY("treeCollapsed"),
  detailsCollapsed: KEY("detailsCollapsed"),
  treeWidth: KEY("treeWidth"),
  detailsWidth: KEY("detailsWidth"),
  favorites: KEY("favorites"),
  expanded: KEY("expanded"),
  searchText: KEY("searchText"),
  searchRegex: KEY("searchRegex"),
  searchMatchCase: KEY("searchMatchCase"),
  selectedRefs: KEY("selectedRefs"),
  authors: KEY("authors"),
  dateRange: KEY("dateRange"),
  since: KEY("since"),
  until: KEY("until"),
  repositories: KEY("repositories"),
  paths: KEY("paths"),
  showAllBranches: KEY("showAllBranches"),
  highlightMine: KEY("highlightMine"),
  compactRows: KEY("compactRows"),
  showHashColumn: KEY("showHashColumn"),
  flatFiles: KEY("flatFiles"),
  // 键名与字段名不一致是故意的：这一项原来住在提交页自己的 `preferences.ts`
  // 里，沿用旧键，已经存过的人搬过来之后仍然停在自己选的那个排列上。
  changeLayout: KEY("commitLayout"),
};

/** 数组值走 JSON，其余走 `String()`；读回时按同一张表还原。 */
export function serializeGitPreference(
  value: GitPreferences[keyof GitPreferences],
): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function storedDateRange(): GitLogDateRange {
  const raw = readStored(GIT_KEYS.dateRange) as GitLogDateRange | null;
  return raw && GIT_LOG_DATE_RANGES.includes(raw) ? raw : "any";
}

export function storedGitPreferences(): GitPreferences {
  return {
    // 0 是「没拖过」，不是「拖成 0 高」——下限由 `WorkPanelSheet` 兜着。
    windowHeight: storedNumber(GIT_KEYS.windowHeight, 0, 0, 20_000),
    maximized: storedBoolean(GIT_KEYS.maximized, false),
    treeCollapsed: storedBoolean(GIT_KEYS.treeCollapsed, false),
    detailsCollapsed: storedBoolean(GIT_KEYS.detailsCollapsed, false),
    treeWidth: storedNumber(GIT_KEYS.treeWidth, 20, 8, 45),
    detailsWidth: storedNumber(GIT_KEYS.detailsWidth, 30, 12, 55),
    favorites: storedIds(GIT_KEYS.favorites),
    expanded: storedIds(GIT_KEYS.expanded),
    searchText: readStored(GIT_KEYS.searchText) ?? "",
    searchRegex: storedBoolean(GIT_KEYS.searchRegex, false),
    searchMatchCase: storedBoolean(GIT_KEYS.searchMatchCase, false),
    selectedRefs: storedIds(GIT_KEYS.selectedRefs),
    authors: storedIds(GIT_KEYS.authors),
    dateRange: storedDateRange(),
    since: readStored(GIT_KEYS.since) ?? "",
    until: readStored(GIT_KEYS.until) ?? "",
    repositories: storedIds(GIT_KEYS.repositories),
    paths: storedIds(GIT_KEYS.paths),
    // IDEA 的日志默认就是整张图：只看 HEAD 可达的提交时每个分支都是一条直线，
    // 分支徽标与合并车道全部不可见，用户第一眼看到的就是「分支信息没展示」。
    showAllBranches: storedBoolean(GIT_KEYS.showAllBranches, true),
    highlightMine: storedBoolean(GIT_KEYS.highlightMine, false),
    compactRows: storedBoolean(GIT_KEYS.compactRows, false),
    showHashColumn: storedBoolean(GIT_KEYS.showHashColumn, true),
    flatFiles: storedBoolean(GIT_KEYS.flatFiles, false),
    changeLayout: storedEnum(GIT_KEYS.changeLayout, GIT_CHANGE_LAYOUTS, "tree"),
  };
}
