import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Search } from "lucide-react";
import type { WorkspaceSummary } from "@armadra/shared";
import { runtimeApi } from "../api/client";
import { formatRelativeTime } from "../lib/format";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupAddon } from "@/ui/input-group";
import { ScrollArea } from "@/ui/scroll-area";
import { useT } from "./preferences-store";
import { RemoveWorkspaceDialog, useRemoveWorkspace } from "./remove-workspace";

/** 超过这个数量才出搜索框（§14：不放非必要控件）。 */
const SEARCH_THRESHOLD = 8;

/**
 * 工作空间列表。
 *
 * `retry: false` 是刻意的：Runtime 连不上时要立刻把启动页上的「无法连接」
 * 条子亮出来，而不是先卡三次重试。但错误状态下会每 3 秒自己探一次——
 * 桌面壳重启 Runtime、或 `pnpm dev` 那边刚起来时，界面自己就回来了，
 * 不用用户去点「重连」（`useBoardSync` 随后会把上次的工作空间接上）。
 */
const RECONNECT_POLL_MS = 3_000;

export function useWorkspacesQuery() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: runtimeApi.listWorkspaces,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.status === "error" ? RECONNECT_POLL_MS : false,
  });
}

export interface WorkspaceGridProps {
  workspaces: WorkspaceSummary[];
  onOpen: (workspace: WorkspaceSummary) => void;
  /** 当前已打开的工作空间，行上打一个高亮底。 */
  activeId?: string | null;
}

/**
 * 最近工作空间列表（§24.3-1：是**列表行**不是网格）。
 *
 * 标题「最近」与搜索框共用一行：搜索框在第 9 个工作空间出现时才长出来，
 * 长在标题行右端而不是列表上方，列表因此不会整体下移。
 *
 * 行高 56，左 8px 色点，名称 13 medium / 路径 11 muted 两行，相对时间常驻在
 * 名称那一行的右端；行右侧固定空出 40px 给 `⋯`，它悬停时淡入。两者各占各
 * 的位置，不再互相顶掉。除此之外一个字都不放（§14）。
 */
export function WorkspaceGrid({
  workspaces,
  onOpen,
  activeId,
}: WorkspaceGridProps) {
  const t = useT();
  const [search, setSearch] = useState("");
  /** 等待确认移除的那张卡；确认框全网格共用一个。 */
  const [pendingRemove, setPendingRemove] = useState<WorkspaceSummary | null>(
    null,
  );
  const removeWorkspace = useRemoveWorkspace();

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.rootPath.toLowerCase().includes(query),
    );
  }, [search, workspaces]);

  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex h-7 shrink-0 items-center gap-3 px-2.5">
        <h2 className="text-[length:var(--text-caption)] font-medium text-muted-foreground">
          {t("launcher.recent")}
        </h2>
        {workspaces.length > SEARCH_THRESHOLD && (
          <InputGroup className="ml-auto h-7 w-[200px] rounded-[var(--r-control)]">
            <Input
              value={search}
              aria-label={t("launcher.search")}
              placeholder={t("launcher.search")}
              onChange={(event) => setSearch(event.target.value)}
            />
            <InputGroupAddon>
              <Search className="size-3.5 opacity-60" />
            </InputGroupAddon>
          </InputGroup>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col pr-2">
          {filtered.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              active={workspace.id === activeId}
              onOpen={() => onOpen(workspace)}
              onRemove={() => setPendingRemove(workspace)}
            />
          ))}
          {filtered.length === 0 && (
            <p className="px-2.5 py-5 text-muted-foreground">
              {t("launcher.empty")}
            </p>
          )}
        </div>
      </ScrollArea>

      <RemoveWorkspaceDialog
        open={Boolean(pendingRemove)}
        pending={removeWorkspace.isPending}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        onConfirm={() => {
          if (!pendingRemove) return;
          removeWorkspace.mutate(pendingRemove.id);
          setPendingRemove(null);
        }}
      />
    </div>
  );
}

/**
 * 一行 = 一个打开按钮 + 一个 `⋯` 菜单。菜单按钮不能嵌在行按钮里
 * （`<button>` 不许套 `<button>`），所以它和相对时间一起绝对定位在
 * 右侧，行按钮用 `pr-11` 把这块地方空出来。
 */
function WorkspaceRow({
  workspace,
  active,
  onOpen,
  onRemove,
}: {
  workspace: WorkspaceSummary;
  active: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const t = useT();

  return (
    <div className="group/card relative">
      <Button
        variant="ghost"
        onClick={onOpen}
        data-active={active ? "true" : undefined}
        className="motion-hover h-[56px] w-full min-w-0 flex-col items-stretch justify-center gap-0.5 rounded-[var(--r-md)] px-2.5 pr-10 text-left font-normal hover:bg-[var(--surface-raised)] data-[active=true]:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ColorDot color={workspace.color} size={8} />
          <span className="truncate text-[length:var(--text-body)] font-medium">
            {workspace.name}
          </span>
          <span className="ml-auto shrink-0 pl-3 text-[length:var(--text-caption)] font-normal text-muted-foreground tabular-nums">
            {formatRelativeTime(workspace.lastOpenedAt)}
          </span>
        </span>
        <span
          className="truncate pl-4 text-[length:var(--text-caption)] font-normal text-muted-foreground"
          title={workspace.rootPath}
        >
          {workspace.rootPath}
        </span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={t("launcher.cardMenu")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[var(--z-menu)]">
          <DropdownMenuItem onSelect={onRemove}>
            {t("launcher.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
