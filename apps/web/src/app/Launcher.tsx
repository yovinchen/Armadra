import { useEffect, useState, type ReactNode } from "react";
import {
  FolderOpen,
  FolderPlus,
  GitBranch,
  RefreshCw,
  Settings,
} from "lucide-react";
import { onFileDrop, pickDirectory } from "../platform";
import { useCanvasStore } from "../store/canvas-store";
import { CloneRepoDialog } from "../panels/CloneRepoDialog";
import { NewFolderDialog } from "../panels/NewFolderDialog";
import { NewWorkspaceDialog } from "../panels/NewWorkspaceDialog";
import { BrandMark } from "@/ui/brand-mark";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  DRAG_REGION,
  NO_DRAG_REGION,
  trafficLightInset,
} from "../shell/window-region";
import { useT } from "./preferences-store";
import { useOpenWorkspace } from "./workspace-actions";
import { useWorkspacesQuery, WorkspaceGrid } from "./WorkspaceGrid";

/**
 * 首页（§20，视觉按 §24.3-1 重做，2026-09-04 再调）。
 *
 * 一条左对齐的 720px 内容列，三段式：品牌 lockup → 操作条 → 最近列表。
 * 三张浮在半空的等大卡片换成**一整块分组条**（`--card` 底、1px 描边、
 * 内部 1px 分隔），跟设置页与对话框里的分组卡片是同一种材质，视觉上是
 * 一个物件而不是三块碎片；页面的重量因此落到「最近」列表上——那才是
 * 用户九成时候要点的东西。
 *
 * 品牌 mark、操作条、列表行共用同一条左边缘，页面只有一个对齐轴。
 *
 * 三段操作分别对应新建文件夹（Runtime `mkdir`）、打开文件夹（系统选择器
 * → 新建工作空间对话框）与克隆仓库。拖一个目录进窗口等同于「打开文件夹」。
 */
export function Launcher() {
  const t = useT();
  const workspaces = useWorkspacesQuery();
  const openWorkspace = useOpenWorkspace();
  const setPanel = useCanvasStore((state) => state.setPanel);
  const [openDialog, setOpenDialog] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const [cloneDialog, setCloneDialog] = useState(false);
  const [droppedPath, setDroppedPath] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(
    () =>
      onFileDrop((paths) => {
        const first = paths[0];
        if (!first) return;
        setDroppedPath(first);
        setOpenDialog(true);
        setDragging(false);
      }),
    [],
  );

  async function browse() {
    const picked = await pickDirectory();
    setDroppedPath(picked);
    setOpenDialog(true);
  }

  return (
    <div
      className="flex h-full flex-col bg-[var(--bg)]"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
      }}
    >
      <header
        style={{
          ...DRAG_REGION,
          paddingLeft: trafficLightInset() || undefined,
        }}
        className="flex h-[var(--tabbar-h)] shrink-0 items-center px-3"
      >
        <div className="ml-auto" style={NO_DRAG_REGION}>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                size="cluster"
                label={t("launcher.settings")}
                onClick={() => setPanel("settings", true)}
              >
                <Settings />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>{t("launcher.settings")}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col px-6 pb-6">
        {/* 品牌 lockup：mark 与应用名同一行、同一条左边缘（§24.3-1） */}
        <div className="flex shrink-0 items-center gap-2.5 px-2.5 pt-4 pb-7">
          <BrandMark className="size-7 text-[var(--brand)]" />
          <h1 className="text-[length:var(--text-title)] font-semibold tracking-[-0.01em]">
            {t("app.brand")}
          </h1>
        </div>

        {/* 操作条：一整块分组卡片，段与段之间 1px 分隔（§24.2「分组表单」） */}
        {/* 不用 overflow-hidden 裁圆角——那会连焦点环一起裁掉，
            改成首尾两段各自圆一边（外圆角 12 减去 1px 描边 = 11）。 */}
        <div className="grid shrink-0 grid-cols-3 rounded-[var(--r-panel)] border border-border bg-[var(--card)] [&>button+button]:border-l [&>button+button]:border-l-border [&>button:first-child]:rounded-l-[11px] [&>button:last-child]:rounded-r-[11px]">
          <ActionSegment
            icon={<FolderPlus />}
            label={t("launcher.newFolder")}
            onClick={() => setFolderDialog(true)}
          />
          <ActionSegment
            icon={<FolderOpen />}
            label={t("launcher.open")}
            onClick={() => void browse()}
          />
          <ActionSegment
            icon={<GitBranch />}
            label={t("launcher.clone")}
            onClick={() => setCloneDialog(true)}
          />
        </div>

        {workspaces.isError && (
          <div className="mt-4 flex h-9 shrink-0 items-center gap-2 rounded-[var(--r-card)] border border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[var(--danger-soft)] px-3">
            <span className="text-[var(--danger)]">{t("launcher.offline")}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={workspaces.isFetching}
              onClick={() => void workspaces.refetch()}
            >
              <RefreshCw />
              {t("launcher.reconnect")}
            </Button>
          </div>
        )}

        <div className="mt-8 flex min-h-0 flex-1 flex-col">
          <WorkspaceGrid
            workspaces={workspaces.data ?? []}
            onOpen={openWorkspace}
          />
        </div>
      </main>

      {dragging && (
        <div
          className="motion-fade-in pointer-events-none fixed inset-0 z-[var(--z-banners)] flex items-center justify-center bg-[var(--scrim)]"
          aria-hidden
        >
          <div className="absolute inset-3 rounded-[var(--r-dialog)] border-[1.5px] border-dashed border-[var(--brand)]" />
          <div className="flex items-center gap-2 rounded-[var(--r-dialog)] border border-border bg-[var(--card)] px-4 py-3 shadow-[var(--shadow-dialog)]">
            <FolderPlus
              className="size-5 text-[var(--brand)] [stroke-width:1.5]"
              aria-hidden
            />
            <span className="font-medium">{t("launcher.drop")}</span>
          </div>
        </div>
      )}

      <NewWorkspaceDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        initialPath={droppedPath}
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
    </div>
  );
}

/**
 * 操作条里的一段 = 一个图标 + 一个词，没有说明文字（§14）。
 * 高 72、方角（圆角由外层分组卡片统一裁切），hover 只换底色。
 */
function ActionSegment({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="motion-hover group/segment h-[72px] flex-col gap-2 rounded-none border-transparent text-[length:var(--text-body)] font-medium hover:bg-[var(--surface-raised)] focus-visible:z-10 [&_svg]:size-5 [&_svg]:[stroke-width:1.5]"
    >
      <span className="text-muted-foreground transition-colors duration-[var(--dur-base)] ease-[var(--ease-out)] group-hover/segment:text-foreground">
        {icon}
      </span>
      {label}
    </Button>
  );
}
