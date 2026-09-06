import type { LucideIcon } from "lucide-react";
import { supportedPermissionModes } from "@armadra/shared";
import { toast } from "sonner";
import { usePreferencesStore } from "../../app/preferences-store";
import {
  Activity,
  Bot,
  CalendarClock,
  FolderOpen,
  FolderTree,
  Frame,
  Globe,
  LayoutGrid,
  Maximize,
  Network,
  SquareDashedMousePointer,
  StickyNote,
  Terminal,
  Type,
  Upload,
} from "lucide-react";
import type { AgentInfo, Position, SshHost, Workspace } from "@armadra/shared";
import type { CommandId } from "../../keybindings";
import type { CanvasActions } from "../../store/canvas-store";
import { useCanvasStore } from "../../store/canvas-store";
import type { Translate } from "../../app/preferences-store";
import { runCanvasCommand, type CanvasCommandId } from "../commands";
import { pickFilesForCanvas } from "../dnd/external-content";
import { addItems, createItemId, select } from "../whiteboard/store";
import { textItemAt } from "../whiteboard/tools/draft";
import { openAutomationPanel } from "../../panels/automation/open";

/**
 * 新建菜单（§13.3）。
 *
 * 一份规格驱动三个入口：画布右键、Dock 的 `+`、会话侧栏项目头的 `+`。
 * 这里只描述菜单，不渲染——渲染在 `AddMenuContent.tsx`。
 *
 * 翻译函数由调用方传入（`useT()`），菜单项因此随语言重建；Agent 名是
 * CLI 自己的品牌名，原样透传不翻译。
 */

export interface AddMenuContext {
  addNode: CanvasActions["addNode"];
  /** 新节点的落点（画布坐标）。 */
  position: Position;
  workspace: Workspace;
  agents: AgentInfo[];
}

export interface AddMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: "terminal" | "agent" | "ssh" | "content" | "canvas";
  /** 右侧显示的快捷键；键位从 `keybindings.ts` 取，不在这里写死。 */
  shortcut?: CommandId;
  /** Agent 品牌色，渲染成图标右边的小色点。 */
  color?: string;
  run: (context: AddMenuContext) => void;
  /** 返回非 null 即禁用，字符串直接当作禁用原因显示。 */
  disabledReason?: (context: AddMenuContext) => string | null;
}

function command(id: CanvasCommandId): () => void {
  return () => {
    runCanvasCommand(id);
  };
}

/** 新建分组的默认尺寸；比一个终端节点稍宽，画进去还有余量。 */
const FRAME_SIZE = { width: 640, height: 420 };

/**
 * 「文字」= 一条 `whiteboard.items`（`wb.text`，不进 `nodes` 表）。
 *
 * 与文字工具点一下走的是同一条路（`whiteboard/tools/draft.textItemAt`）：
 * 空文字对象建出来就选中，`TextNode` 看到 `text` 为空自动进编辑态，所以
 * 菜单里点「新建文字」和用文字工具点一下的结果一模一样。
 */
function addTextShape(position: Position): void {
  const item = textItemAt(position, createItemId());
  addItems([item]);
  select([item.id]);
}

/** 「画框」= 分组节点（`nodes` 表里的一行），落点即左上角。 */
function addFrameShape(position: Position): void {
  useCanvasStore.getState().addNode("group", {
    position,
    size: FRAME_SIZE,
  });
}

/**
 * SSH 终端项（§21）：设置里配了几台主机就有几项，一台都没有时整组不出现。
 *
 * 节点只记 `ssh.hostId`；主机地址、端口、密钥都在 Runtime 的设置里，
 * 所以改一次主机，所有指向它的节点下次启动就跟着变。
 */
export function sshMenuItems(hosts: SshHost[], t: Translate): AddMenuItem[] {
  return hosts.map((host) => ({
    id: `add.ssh.${host.id}`,
    label: t("ssh.menuItem", { name: host.name }),
    icon: Network,
    group: "ssh",
    run: (context) => {
      context.addNode("terminal", {
        position: context.position,
        title: host.name,
        data: { kind: "terminal", ssh: { hostId: host.id } },
      });
    },
  }));
}

/**
 * 菜单项按 §3.2 的顺序：
 * 新建终端 → 各 Agent → 便签 → 文件管理器 → 打开文件… → 浏览器
 * → ─ → 全选 / 适应视图 / 整理画布。
 */
export function buildAddMenu(
  agents: AgentInfo[],
  t: Translate,
  hosts: SshHost[] = [],
): AddMenuItem[] {
  const agentItems: AddMenuItem[] = agents.map((agent) => ({
    id: `add.agent.${agent.id}`,
    label: agent.label,
    icon: Bot,
    group: "agent",
    color: agent.color,
    run: (context) => {
      const permissionMode =
        usePreferencesStore.getState().defaultPermissionMode;
      if (
        !supportedPermissionModes(agent.baseAgent ?? agent.id).includes(
          permissionMode,
        )
      ) {
        toast.error(t("settings.permissionUnsupported"));
        return;
      }
      context.addNode("terminal", {
        position: context.position,
        title: agent.label,
        data: {
          kind: "terminal",
          agent: {
            id: agent.id,
            ...(permissionMode !== "default" ? { permissionMode } : {}),
          },
        },
      });
    },
    // 探测不到可执行文件时不隐藏、只禁用：用户需要知道这个 CLI 存在。
    disabledReason: () => (agent.resolvedPath ? null : t("add.notInstalled")),
  }));

  return [
    {
      id: "add.terminal",
      label: t("add.terminal"),
      icon: Terminal,
      group: "terminal",
      shortcut: "canvas.newTerminal",
      run: (context) => {
        context.addNode("terminal", { position: context.position });
      },
    },
    ...agentItems,
    ...sshMenuItems(hosts, t),
    {
      id: "add.sticky",
      label: t("add.sticky"),
      icon: StickyNote,
      group: "content",
      run: (context) => {
        context.addNode("sticky", { position: context.position });
      },
    },
    {
      id: "add.files",
      label: t("add.files"),
      icon: FolderTree,
      group: "content",
      run: (context) => {
        context.addNode("files", {
          position: context.position,
          data: { kind: "files", path: context.workspace.rootPath },
        });
      },
    },
    {
      id: "add.openFile",
      label: t("add.openFile"),
      icon: FolderOpen,
      group: "content",
      shortcut: "app.explorer",
      // 打开文件走资源管理器抽屉：文件树里点一下才知道要开哪个文件。
      run: () => useCanvasStore.getState().setPanel("explorer", "drawer"),
    },
    {
      id: "add.importFiles",
      label: t("add.importFiles"),
      icon: Upload,
      group: "content",
      run: (context) => pickFilesForCanvas(context.position),
    },
    {
      id: "add.text",
      label: t("add.text"),
      icon: Type,
      group: "content",
      run: (context) => addTextShape(context.position),
    },
    {
      id: "add.frame",
      label: t("add.frame"),
      icon: Frame,
      group: "content",
      run: (context) => addFrameShape(context.position),
    },
    {
      id: "add.browser",
      label: t("add.browser"),
      icon: Globe,
      group: "content",
      run: (context) => {
        context.addNode("browser", { position: context.position });
      },
    },
    {
      id: "add.automation",
      label: t("add.automation"),
      icon: CalendarClock,
      group: "content",
      // 计划本身住在 Host 上，所以这一项开的是自动化页，而不是先造一张
      // 指向不存在计划的空卡片。
      run: () => openAutomationPanel(null),
    },
    {
      id: "add.agentActivity",
      label: t("add.agentActivity"),
      icon: Activity,
      group: "content",
      run: (context) => {
        const source = useCanvasStore
          .getState()
          .document?.nodes.find((node) => node.type === "terminal");
        if (!source) return;
        context.addNode("agentActivity", {
          position: context.position,
          title: source.title,
          data: { kind: "agentActivity", sourceNodeId: source.id },
        });
      },
      // 没有终端节点就没有可观察的对象；这时禁用而不是造一张空卡片。
      disabledReason: () =>
        useCanvasStore
          .getState()
          .document?.nodes.some((node) => node.type === "terminal")
          ? null
          : t("add.noTerminal"),
    },
    {
      id: "canvas.selectAll",
      label: t("canvas.selectAll"),
      icon: SquareDashedMousePointer,
      group: "canvas",
      run: command("canvas.selectAll"),
    },
    {
      id: "canvas.fitView",
      label: t("canvas.fitView"),
      icon: Maximize,
      group: "canvas",
      run: command("canvas.fitView"),
    },
    {
      id: "canvas.tidy",
      label: t("canvas.tidy"),
      icon: LayoutGrid,
      group: "canvas",
      shortcut: "canvas.tidy",
      run: command("canvas.tidy"),
    },
  ];
}
