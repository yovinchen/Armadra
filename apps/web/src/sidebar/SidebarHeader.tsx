/**
 * 侧栏顶行（§26）：当前工作空间名 + 下拉，右边搜索与通知。
 *
 * 名字那一格是唯一的工作空间切换入口——下拉里先列已知的工作空间（当前那个
 * 打勾），再是打开 / 新建 / 克隆，最后是「从列表移除」。三个对话框挂在这里，
 * 因为触发它们的菜单在这里，树里不再重复一份。
 *
 * 铃铛打开投递记录；右上角那颗点是「当前工作空间里有 Agent 在等你（红）或
 * 跑完了没看（蓝）」，与看板行尾用的是同一套信号。
 */
import { useState } from "react";
import { Bell, ChevronDown, Search } from "lucide-react";
import type { WorkspaceSummary } from "@ai-coding-canvas/shared";

import { useStatusCounts } from "../agent/status-store";
import { useT } from "../app/preferences-store";
import {
  RemoveWorkspaceDialog,
  useRemoveWorkspace,
} from "../app/remove-workspace";
import { useWorkspacesQuery } from "../app/WorkspaceGrid";
import { useOpenWorkspace } from "../app/workspace-actions";
import { CloneRepoDialog } from "../panels/CloneRepoDialog";
import { openDeliveryLog } from "../panels/DeliveryLog";
import { NewFolderDialog } from "../panels/NewFolderDialog";
import { NewWorkspaceDialog } from "../panels/NewWorkspaceDialog";
import { pickDirectory } from "../platform";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { SignalDot } from "./SignalDot";

export function SidebarHeader() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaces = useWorkspacesQuery();
  const openWorkspace = useOpenWorkspace();
  const removeWorkspace = useRemoveWorkspace();
  const counts = useStatusCounts(workspace?.id ?? null);

  const [openDialog, setOpenDialog] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [cloneDialog, setCloneDialog] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function browse() {
    const picked = await pickDirectory();
    setOpenPath(picked);
    setOpenDialog(true);
  }

  const rows: WorkspaceSummary[] = workspaces.data ?? [];
  const tone = counts.attention > 0 ? "attention" : "unread";
  const hasSignal = counts.attention > 0 || counts.unread > 0;

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="motion-hover h-7 min-w-0 gap-1 px-1.5 text-[length:var(--text-section)] font-semibold hover:bg-[var(--hover)]"
          >
            <span className="truncate">
              {workspace?.name ?? t("app.brand")}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-[var(--z-menu)] w-56">
          {rows.map((row) => (
            <DropdownMenuCheckboxItem
              key={row.id}
              checked={row.id === workspace?.id}
              onSelect={() => openWorkspace(row)}
            >
              <ColorDot color={row.color} size={8} />
              <span className="truncate">{row.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {rows.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => void browse()}>
            {t("launcher.open")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setFolderDialog(true)}>
            {t("launcher.newFolder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCloneDialog(true)}>
            {t("launcher.clone")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!workspace}
            onSelect={() => setConfirmRemove(true)}
          >
            {t("launcher.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <IconButton
        size="cluster"
        label={t("sidebar.search")}
        onClick={() => setPanel("palette", true)}
      >
        <Search />
      </IconButton>
      <IconButton
        size="cluster"
        label={t("sidebar.notifications")}
        className="relative"
        onClick={openDeliveryLog}
      >
        <Bell />
        {hasSignal && (
          <SignalDot corner tone={tone} label={t("sidebar.hasNotifications")} />
        )}
      </IconButton>

      <NewWorkspaceDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        initialPath={openPath}
        onCreated={openWorkspace}
      />
      <NewFolderDialog
        open={folderDialog}
        onOpenChange={setFolderDialog}
        onCreated={openWorkspace}
      />
      <CloneRepoDialog
        open={cloneDialog}
        onOpenChange={setCloneDialog}
        onCloned={openWorkspace}
      />
      <RemoveWorkspaceDialog
        open={confirmRemove}
        pending={removeWorkspace.isPending}
        onOpenChange={setConfirmRemove}
        onConfirm={() => {
          setConfirmRemove(false);
          if (workspace) removeWorkspace.mutate(workspace.id);
        }}
      />
    </div>
  );
}
