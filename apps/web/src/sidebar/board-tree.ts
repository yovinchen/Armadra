/**
 * 侧栏树的纯逻辑（§26）。
 *
 * 组件只负责画，「哪些板可见」「哪块板要亮点」「置顶组里有什么」这三件事
 * 都在这里算，好让它们能被单测按数据覆盖，而不是靠渲染出来再找 DOM。
 */
import type { SessionRow } from "../agent/sessions";

/** 树里的一块板：名称 + 节点数，两个数据源统一成这个形状。 */
export interface BoardEntry {
  id: string;
  name: string;
  nodeCount: number;
}

/** 一块板上的 Agent 汇总信号：行尾那个点画成红的还是蓝的。 */
export interface BoardSignal {
  /** 板上有 Agent 在等你（waiting / blocked / 待授权）。 */
  attention: boolean;
  /** 板上有 Agent 完成了但没看过。 */
  unread: boolean;
}

/** 超过这个数就折起来，末尾给一行「展开显示」（Codex 侧栏的做法）。 */
export const BOARD_PAGE_SIZE = 8;

/**
 * 会话行 → 按看板汇总的信号。
 *
 * `attention` 的判定与 `agent/status-store` 的 `isAttention` 同源，这里不
 * 重新定义状态语义，只做「板内任一 Agent 命中即算命中」的合并。
 */
export function boardSignals(
  rows: readonly SessionRow[],
  attention: (row: SessionRow) => boolean,
): Record<string, BoardSignal> {
  const signals: Record<string, BoardSignal> = {};
  for (const row of rows) {
    if (!row.alive) continue;
    const current = signals[row.boardId] ?? { attention: false, unread: false };
    signals[row.boardId] = {
      attention: current.attention || attention(row),
      unread: current.unread || row.unread,
    };
  }
  return signals;
}

/**
 * 折叠长列表：收起时只留前 `BOARD_PAGE_SIZE` 条，但当前那块板一定在里面
 * ——否则点开一块排在第 20 位的板，侧栏上看不到高亮，像是没切过去。
 */
export function visibleBoards(
  boards: readonly BoardEntry[],
  expanded: boolean,
  activeBoardId: string | null,
): BoardEntry[] {
  if (expanded || boards.length <= BOARD_PAGE_SIZE) return [...boards];
  const head = boards.slice(0, BOARD_PAGE_SIZE);
  if (!activeBoardId || head.some((board) => board.id === activeBoardId)) {
    return head;
  }
  const active = boards.find((board) => board.id === activeBoardId);
  return active ? [...head.slice(0, BOARD_PAGE_SIZE - 1), active] : head;
}

/** 置顶组的一行：板本身 + 它属于哪个工作空间。 */
export interface PinnedEntry {
  workspaceId: string;
  workspaceName: string;
  board: BoardEntry;
}

/**
 * 置顶 id → 置顶行。顺序跟着偏好里的 id 顺序走；指向已经不存在（或工作空间
 * 已关闭）的板的 id 直接跳过，不在这里清理偏好——用户重新打开那个工作空间时
 * 置顶还该回来。
 */
export function pinnedEntries(
  pinnedIds: readonly string[],
  boardsByWorkspace: readonly {
    id: string;
    name: string;
    boards: readonly BoardEntry[];
  }[],
): PinnedEntry[] {
  const index = new Map<string, PinnedEntry>();
  for (const workspace of boardsByWorkspace) {
    for (const board of workspace.boards) {
      index.set(board.id, {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        board,
      });
    }
  }
  return pinnedIds
    .map((id) => index.get(id))
    .filter((entry): entry is PinnedEntry => Boolean(entry));
}

/** 新建看板的默认名：`看板 3`。已有的名字里避开同名。 */
export function nextBoardName(
  boards: readonly { name: string }[],
  template: (index: number) => string,
): string {
  const taken = new Set(boards.map((board) => board.name));
  let index = boards.length + 1;
  while (taken.has(template(index))) index += 1;
  return template(index);
}
