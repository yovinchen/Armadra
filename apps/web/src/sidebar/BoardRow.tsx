/**
 * 侧栏里的一行看板（§26 →§27）。
 *
 * 行本身 = 图标 + 名称 + 行尾信号点 + `⋯`；右键与 `⋯` 给同一组动作
 * （置顶 / 重命名 / 删除）。当前那块板下面多一行「N 个 Agent」，展开才把
 * 会话列表放出来——Agent 列表不再是常驻的第二栏，默认收起。
 */
import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  MoreHorizontal,
  Pin,
} from "lucide-react";

import { useT } from "../app/preferences-store";
import { SessionsSection } from "../sessions/SessionsSection";
import { cn } from "@/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import type { BoardEntry, BoardSignal } from "./board-tree";
import { NameInput } from "./NameInput";
import { SignalDot } from "./SignalDot";

export interface BoardRowProps {
  board: BoardEntry;
  active: boolean;
  pinned: boolean;
  signal?: BoardSignal;
  /** 当前看板上活着的 Agent 数量；只有当前看板会用到。 */
  agentCount: number;
  /** 含已结束的会话总数：只剩历史时折叠行仍要出现，否则历史没有入口。 */
  sessionCount: number;
  /** 工作空间只剩一块板时不让删。 */
  canDelete: boolean;
  renamePending: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  /** 置顶组里的行会带上工作空间名，作为第二行的说明。 */
  caption?: string;
  /**
   * 项目行下面的看板：内容往右缩，但**底色仍然铺满**——高亮块因此与上面的
   * 项目行严丝合缝，不会因为左边空一截、四角又是圆的而看着断开（§27）。
   */
  indent?: boolean;
}

export function BoardRow({
  board,
  active,
  pinned,
  signal,
  agentCount,
  sessionCount,
  canDelete,
  renamePending,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  caption,
  indent,
}: BoardRowProps) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);

  if (renaming) {
    return (
      <li className={indent ? "pl-4" : undefined}>
        <NameInput
          initial={board.name}
          label={t("sidebar.boardName")}
          pending={renamePending}
          onCancel={() => setRenaming(false)}
          onSubmit={(name) => {
            setRenaming(false);
            onRename(name);
          }}
        />
      </li>
    );
  }

  /* 右键与 `⋯` 是同一组动作，所以只描述一次，两种菜单各渲染一遍。 */
  const actions = [
    {
      key: "pin",
      label: pinned ? t("sidebar.boardUnpin") : t("sidebar.boardPin"),
      disabled: false,
      run: onTogglePin,
    },
    {
      key: "rename",
      label: t("sidebar.boardRename"),
      disabled: false,
      run: () => setRenaming(true),
    },
    {
      key: "delete",
      label: t("sidebar.boardDelete"),
      disabled: !canDelete,
      run: () => setConfirming(true),
    },
  ];

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-active={active ? "true" : undefined}
            className={cn(
              "group/board motion-hover flex h-7 items-center gap-1 rounded-[var(--r-control)] pr-1 hover:bg-[var(--hover)] data-[active=true]:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)] data-[active=true]:text-[var(--brand)]",
              indent ? "pl-4" : "pl-1.5",
            )}
          >
            {pinned ? (
              <Pin className="size-3.5 shrink-0 opacity-60" />
            ) : (
              <LayoutGrid className="size-3.5 shrink-0 opacity-60" />
            )}
            <Button
              variant="ghost"
              size="sm"
              title={caption}
              className="min-w-0 flex-1 justify-start px-1 text-[length:var(--text-body)] font-normal hover:bg-transparent"
              onClick={onSelect}
              onDoubleClick={() => setRenaming(true)}
            >
              <span className="truncate">{board.name}</span>
            </Button>
            {board.nodeCount > 0 && (
              <span
                aria-label={t("sidebar.boardNodes", {
                  count: board.nodeCount,
                })}
                className="shrink-0 text-[length:var(--text-caption)] text-muted-foreground tabular-nums"
              >
                {board.nodeCount}
              </span>
            )}
            {signal?.attention ? (
              <SignalDot tone="attention" label={t("sidebar.needsYou")} />
            ) : signal?.unread ? (
              <SignalDot tone="unread" label={t("sidebar.unread")} />
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={t("sidebar.boardMenu")}
                  className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/board:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="z-[var(--z-menu)]">
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.key}
                    disabled={action.disabled}
                    onSelect={action.run}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="z-[var(--z-menu)]">
          {actions.map((action) => (
            <ContextMenuItem
              key={action.key}
              disabled={action.disabled}
              onSelect={action.run}
            >
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>

      {active && sessionCount > 0 && (
        <AgentsFold
          indent={indent}
          open={agentsOpen}
          count={agentCount}
          onToggle={() => setAgentsOpen((value) => !value)}
        >
          <SessionsSection boardId={board.id} />
        </AgentsFold>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sidebar.boardDeleteTitle", { name: board.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sidebar.boardDeleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sidebar.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              {t("sidebar.boardDeleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** 「N 个 Agent」折叠行。默认收起，状态只活在当前这块板的行里。 */
function AgentsFold({
  open,
  count,
  indent,
  onToggle,
  children,
}: {
  open: boolean;
  count: number;
  indent?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={indent ? "pl-7" : "pl-4"}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="motion-hover h-7 w-full justify-start gap-1 px-1.5 text-[length:var(--text-body)] font-normal text-muted-foreground hover:bg-[var(--hover)]"
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{t("sidebar.agentCount", { count })}</span>
      </Button>
      {open && children}
    </div>
  );
}
