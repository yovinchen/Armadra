/**
 * 侧栏主体（§26 →§28）：新建看板 → 置顶 → 项目。
 *
 * 「项目」= 已打开的工作空间，一行一个，展开后缩进列出它的看板；点看板 =
 * 需要时先切工作空间，再切板。「置顶」是跨工作空间的一组看板，偏好里存 id。
 * 当前工作空间的看板取 store（`setBoards` 已按 `sortOrder` 排好），其余
 * 工作空间取列表接口里的 `boards[]`。
 *
 * 名字在树里只读：项目名与看板名都是纯文本，改名不在这条路上。Agent 也不在
 * 树里——状态只在铃铛展开的 `AgentStatusPanel` 里看，树只负责「去哪块板」。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Folder, MoreHorizontal, Plus, SquarePen } from "lucide-react";
import type { WorkspaceSummary } from "@armadra/shared";

import { isAttention } from "../agent/status-store";
import { useSessions } from "../agent/sessions";
import { useT, usePreferencesStore } from "../app/preferences-store";
import {
  useCloseWorkspace,
  useOpenFolder,
  useOpenWorkspace,
} from "../app/workspace-actions";
import { useWorkspacesQuery } from "../app/workspaces-query";
import {
  RemoveWorkspaceDialog,
  useRemoveWorkspace,
} from "../app/remove-workspace";
import { NewFolderDialog } from "../panels/NewFolderDialog";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { BoardRow } from "./BoardRow";
import {
  BOARD_PAGE_SIZE,
  boardSignals,
  nextBoardName,
  pinnedEntries,
  visibleBoards,
  type BoardEntry,
  type BoardSignal,
} from "./board-tree";
import { useBoardMutations } from "./use-board-mutations";

export function WorkspaceTree() {
  const t = useT();
  const workspaces = useWorkspacesQuery();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const openWorkspaceIds = usePreferencesStore(
    (state) => state.openWorkspaceIds,
  );
  const collapsedIds = usePreferencesStore(
    (state) => state.collapsedWorkspaceIds,
  );
  const setCollapsed = usePreferencesStore(
    (state) => state.setWorkspaceCollapsed,
  );
  const pinnedBoardIds = usePreferencesStore((state) => state.pinnedBoardIds);
  const setBoardPinned = usePreferencesStore((state) => state.setBoardPinned);
  const openWorkspace = useOpenWorkspace();

  /** 跨工作空间切板：先换工作空间，等它的看板列表到位再选中目标。 */
  const [pending, setPending] = useState<{
    workspaceId: string;
    boardId: string;
  } | null>(null);

  // 行顺序 = 偏好里的 openWorkspaceIds；当前工作空间永远在树里
  const rows = useMemo(() => {
    const byId = new Map(
      (workspaces.data ?? []).map((item) => [item.id, item]),
    );
    const list = openWorkspaceIds
      .map((id) => byId.get(id))
      .filter((item): item is WorkspaceSummary => Boolean(item));
    if (workspace && !list.some((item) => item.id === workspace.id)) {
      list.unshift(
        byId.get(workspace.id) ??
          ({ ...workspace, boards: [] } as WorkspaceSummary),
      );
    }
    return list;
  }, [openWorkspaceIds, workspace, workspaces.data]);

  useEffect(() => {
    if (!pending) return;
    if (workspace?.id !== pending.workspaceId) return;
    if (!boards.some((board) => board.id === pending.boardId)) return;
    selectBoard(pending.boardId);
    setPending(null);
  }, [boards, pending, selectBoard, workspace?.id]);

  const boardsOf = useCallback(
    (summary: WorkspaceSummary): BoardEntry[] => {
      const source = summary.id === workspace?.id ? boards : summary.boards;
      return source.map((board) => ({ id: board.id, name: board.name }));
    },
    [boards, workspace?.id],
  );

  const openBoard = useCallback(
    (workspaceId: string, id: string) => {
      if (workspace?.id === workspaceId) {
        selectBoard(id);
        return;
      }
      const summary = rows.find((item) => item.id === workspaceId);
      if (!summary) return;
      openWorkspace(summary);
      setPending({ workspaceId, boardId: id });
    },
    [openWorkspace, rows, selectBoard, workspace?.id],
  );

  /* 行尾信号点：只有当前工作空间有会话列表，别的工作空间不发这一次请求。 */
  const { sessions } = useSessions(workspace?.id ?? null);
  const signals = useMemo(
    () => boardSignals(sessions, isAttention),
    [sessions],
  );

  const pinned = useMemo(
    () =>
      pinnedEntries(
        pinnedBoardIds,
        rows.map((summary) => ({
          id: summary.id,
          name: summary.name,
          boards: boardsOf(summary),
        })),
      ),
    [boardsOf, pinnedBoardIds, rows],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <NewBoardRow />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2">
          {pinned.length > 0 && (
            <section aria-label={t("sidebar.pinned")}>
              <GroupTitle>{t("sidebar.pinned")}</GroupTitle>
              <ul>
                {pinned.map((entry) => (
                  <PinnedRow
                    key={entry.board.id}
                    workspaceId={entry.workspaceId}
                    caption={entry.workspaceName}
                    board={entry.board}
                    active={
                      entry.workspaceId === workspace?.id &&
                      entry.board.id === boardId
                    }
                    signal={signals[entry.board.id]}
                    onSelect={() => openBoard(entry.workspaceId, entry.board.id)}
                    onTogglePin={() => setBoardPinned(entry.board.id, false)}
                  />
                ))}
              </ul>
            </section>
          )}

          <section aria-label={t("sidebar.projects")}>
            <GroupTitle action={<AddProjectButton />}>
              {t("sidebar.projects")}
            </GroupTitle>
            <ul>
              {rows.map((summary) => (
                <WorkspaceRow
                  key={summary.id}
                  summary={summary}
                  active={summary.id === workspace?.id}
                  boards={boardsOf(summary)}
                  activeBoardId={summary.id === workspace?.id ? boardId : null}
                  signals={signals}
                  pinnedBoardIds={pinnedBoardIds}
                  collapsed={collapsedIds.includes(summary.id)}
                  onToggle={(next) => setCollapsed(summary.id, next)}
                  onSelectBoard={(id) => openBoard(summary.id, id)}
                  onTogglePin={(id, next) => setBoardPinned(id, next)}
                />
              ))}
            </ul>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function GroupTitle({
  children,
  action,
}: {
  children: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-1 px-1.5">
      <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-caption)] font-medium tracking-[.04em] text-muted-foreground uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

/**
 * 「项目」组标题右边的 `+`：走系统目录选择器，选完即建即开；浏览器里没有
 * 选择器，退回手填路径的新建文件夹对话框（对已存在的目录就是「打开」）。
 */
function AddProjectButton() {
  const t = useT();
  const openWorkspace = useOpenWorkspace();
  const [dialog, setDialog] = useState(false);
  const openFolder = useOpenFolder(useCallback(() => setDialog(true), []));

  return (
    <>
      <IconButton
        label={t("sidebar.addProject")}
        className="shrink-0"
        onClick={() => void openFolder()}
      >
        <Plus />
      </IconButton>
      <NewFolderDialog
        open={dialog}
        onOpenChange={setDialog}
        onCreated={openWorkspace}
      />
    </>
  );
}

/* ------------------------------- 新建看板 -------------------------------- */

/**
 * 「新建看板」（Codex 的「新对话」那一行）：在当前工作空间建一块板并切过去。
 * 行尾的 `+` 是同一个动作，只是位置不同。
 */
function NewBoardRow() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const { create } = useBoardMutations(workspace?.id ?? "");

  const run = () => {
    if (!workspace || create.isPending) return;
    const name = nextBoardName(boards, (index) =>
      t("sidebar.boardDefaultName", { index }),
    );
    create.mutate(name, {
      onSuccess: (board) => selectBoard(board.id),
    });
  };

  return (
    <div className="px-2 pb-1">
      <div className="group/new motion-hover flex h-8 items-center rounded-[var(--r-control)] pr-1 hover:bg-[var(--hover)]">
        <Button
          variant="ghost"
          size="sm"
          disabled={!workspace || create.isPending}
          className="min-w-0 flex-1 justify-start gap-2 px-1.5 text-[length:var(--text-body)] font-normal hover:bg-transparent"
          onClick={run}
        >
          <SquarePen className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{t("sidebar.newBoard")}</span>
        </Button>
        <IconButton
          label={t("sidebar.newBoard")}
          disabled={!workspace || create.isPending}
          className="shrink-0"
          onClick={run}
        >
          <Plus />
        </IconButton>
      </div>
    </div>
  );
}

/* ------------------------------- 置顶的一行 ------------------------------ */

/** 置顶组的行；它可能属于任何一个已打开的工作空间，所以自己带一套 mutation。 */
function PinnedRow({
  workspaceId,
  board,
  caption,
  active,
  signal,
  onSelect,
  onTogglePin,
}: {
  workspaceId: string;
  board: BoardEntry;
  caption: string;
  active: boolean;
  signal?: BoardSignal;
  onSelect: () => void;
  onTogglePin: () => void;
}) {
  const { remove } = useBoardMutations(workspaceId);
  return (
    <BoardRow
      board={board}
      caption={caption}
      active={active}
      pinned
      signal={signal}
      canDelete={false}
      onSelect={onSelect}
      onDelete={() => remove.mutate(board.id)}
      onTogglePin={onTogglePin}
    />
  );
}

/* ------------------------------- 工作空间行 ------------------------------- */

function WorkspaceRow({
  summary,
  active,
  boards,
  activeBoardId,
  signals,
  pinnedBoardIds,
  collapsed,
  onToggle,
  onSelectBoard,
  onTogglePin,
}: {
  summary: WorkspaceSummary;
  active: boolean;
  boards: BoardEntry[];
  activeBoardId: string | null;
  signals: Record<string, BoardSignal>;
  pinnedBoardIds: string[];
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
  onSelectBoard: (boardId: string) => void;
  onTogglePin: (boardId: string, pinned: boolean) => void;
}) {
  const t = useT();
  const storeBoards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const closeWorkspace = useCloseWorkspace();
  const removeWorkspace = useRemoveWorkspace();
  const { create, remove } = useBoardMutations(summary.id);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [expandedAll, setExpandedAll] = useState(false);

  const visible = visibleBoards(boards, expandedAll, activeBoardId);
  const canDelete = boards.length > 1;

  const createBoard = () => {
    if (create.isPending) return;
    onToggle(false);
    const name = nextBoardName(boards, (index) =>
      t("sidebar.boardDefaultName", { index }),
    );
    create.mutate(name, {
      onSuccess: (board) => onSelectBoard(board.id),
    });
  };

  const deleteBoard = (id: string) => {
    remove.mutate(id, {
      onSuccess: () => {
        // 删的是当前看板就先切到别的一块，免得画布对着一个不存在的 id
        if (active && id === boardId) {
          const next = storeBoards.find((board) => board.id !== id);
          selectBoard(next?.id ?? null);
        }
      },
    });
  };

  return (
    <li>
      <div className="group/ws motion-hover flex h-7 items-center gap-1 rounded-[var(--r-control)] pr-1 pl-1.5 hover:bg-[var(--hover)]">
        <Folder className="size-3.5 shrink-0 opacity-60" />
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start gap-1.5 px-1 text-[length:var(--text-body)] font-normal hover:bg-transparent"
          onClick={() => onToggle(!collapsed)}
        >
          <ColorDot color={summary.color} size={8} />
          <span className="truncate">{summary.name}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              label={t("tree.menu")}
              className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/ws:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-[var(--z-menu)]">
            <DropdownMenuItem onSelect={createBoard}>
              {t("tree.newBoard")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => closeWorkspace(summary.id)}>
              {t("tree.close")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setConfirmRemove(true)}>
              {t("launcher.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!collapsed && (
        <ul>
          {visible.map((board) => (
            <BoardRow
              key={board.id}
              board={board}
              indent
              active={board.id === activeBoardId}
              pinned={pinnedBoardIds.includes(board.id)}
              signal={signals[board.id]}
              canDelete={canDelete}
              onSelect={() => onSelectBoard(board.id)}
              onDelete={() => deleteBoard(board.id)}
              onTogglePin={() =>
                onTogglePin(board.id, !pinnedBoardIds.includes(board.id))
              }
            />
          ))}
          {boards.length > BOARD_PAGE_SIZE && (
            <li className="pl-4">
              <Button
                variant="ghost"
                size="sm"
                className="motion-hover h-7 w-full justify-start px-1.5 text-[length:var(--text-body)] font-normal text-muted-foreground hover:bg-[var(--hover)]"
                onClick={() => setExpandedAll((value) => !value)}
              >
                {expandedAll ? t("sidebar.showLess") : t("sidebar.showMore")}
              </Button>
            </li>
          )}
        </ul>
      )}

      <RemoveWorkspaceDialog
        open={confirmRemove}
        pending={removeWorkspace.isPending}
        onOpenChange={setConfirmRemove}
        onConfirm={() => {
          setConfirmRemove(false);
          // `useRemoveWorkspace` 里已经带了关闭：这一行如果正开着，
          // 移除之后也一并关掉。
          removeWorkspace.mutate(summary.id);
        }}
      />
    </li>
  );
}
