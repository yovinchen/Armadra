/**
 * 侧栏顶行（§26 →§27）：系统名 + 工作空间下拉。
 *
 * 这一行写的是**产品名 Armadra**，不是当前工作空间名——工作空间是内容，
 * 产品名是身份，顶行给身份，当前是哪个工作空间由下拉里的勾表示。
 *
 * 下拉仍然是唯一的工作空间切换入口：先列已知的工作空间（当前那个打勾），
 * 再是打开 / 新建 / 克隆，最后是「从列表移除」。「打开」直接走系统选择器，
 * 选完即建即开；另外两个的对话框挂在这里，因为触发它们的菜单在这里，
 * 树里不再重复一份。
 *
 * 搜索与通知搬去了上面那 44px 的标题栏（`shell/LeftSidebar`），与红绿灯
 * 同一条水平中线，这里不再有它们。
 */
import { useCallback, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { WorkspaceSummary } from "@armadra/shared";

import { useT } from "../app/preferences-store";
import {
  RemoveWorkspaceDialog,
  useRemoveWorkspace,
} from "../app/remove-workspace";
import { useWorkspacesQuery } from "../app/workspaces-query";
import { useOpenFolder, useOpenWorkspace } from "../app/workspace-actions";
import { CloneRepoDialog } from "../panels/CloneRepoDialog";
import { NewFolderDialog } from "../panels/NewFolderDialog";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

export function SidebarHeader() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const workspaces = useWorkspacesQuery();
  const openWorkspace = useOpenWorkspace();
  const removeWorkspace = useRemoveWorkspace();

  const [folderDialog, setFolderDialog] = useState(false);
  const [cloneDialog, setCloneDialog] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const openFolder = useOpenFolder(
    useCallback(() => setFolderDialog(true), []),
  );

  const rows: WorkspaceSummary[] = workspaces.data ?? [];

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="motion-hover h-7 min-w-0 gap-1 px-1.5 text-[length:var(--text-section)] font-semibold hover:bg-[var(--hover)]"
          >
            <span className="truncate">{t("app.brand")}</span>
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
              <span className="truncate">{row.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {rows.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => void openFolder()}>
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
