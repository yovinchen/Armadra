import { useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { basename } from "../agent/sessions";
import { agentColorVar } from "../agent/launch";
import { formatRelativeTime } from "../lib/format";
import {
  resumeLaunchCommand,
  useConversations,
  type Conversation,
} from "../meta/conversations";
import { COMMANDS, commandKeysLabel } from "../keybindings";
import { useCanvasStore } from "../store/canvas-store";
import { useCommandDispatch } from "../app/commands";
import { useEnabledAgents } from "../app/use-agents";
import { useT } from "../app/preferences-store";
import { sshMenuItems } from "../canvas/menus/add-menu";
import { requestCenterOnNode } from "../canvas/editor-context";
import { useSshHosts } from "./settings/ssh-hosts";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/command";

/** 一次最多列这么多个跳转目标，超过靠输入过滤。 */
const MAX_NODE_RESULTS = 50;

/**
 * 命令面板（⌘K，§3.6）。三组：新建 / 跳转 / 命令。
 * 没有说明文字，右侧只显示快捷键。
 */
export function CommandPalette() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.palette);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const document = useCanvasStore((state) => state.document);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const addNode = useCanvasStore((state) => state.addNode);
  const agents = useEnabledAgents();
  const { run, addMenuItems, centerPosition } = useCommandDispatch();
  const hosts = useSshHosts();
  // SSH 终端项和添加菜单是同一份规格（§21），只是这里另外拼进「新建」组。
  const newItems = useMemo(
    () => [
      ...addMenuItems.filter((item) => item.group !== "canvas"),
      ...sshMenuItems(hosts, t),
    ],
    [addMenuItems, hosts, t],
  );
  const [query, setQuery] = useState("");
  // 历史对话索引（§17）：只在面板开着时查，输入去抖 150ms。
  const conversations = useConversations(query, open);

  const nodes = useMemo(
    () => (document?.nodes ?? []).slice(0, MAX_NODE_RESULTS),
    [document],
  );

  const close = () => setPanel("palette", false);

  /** 选中一条历史对话：在视口中心开一个以 `--resume` 启动的终端节点。 */
  function resume(conversation: Conversation) {
    const command = resumeLaunchCommand(
      conversation.provider,
      conversation.sessionId,
    );
    if (!command) return;
    close();
    addNode("terminal", {
      position: centerPosition(),
      title: conversation.title,
      data: {
        kind: "terminal",
        cwd: conversation.cwd,
        agent: {
          id: conversation.provider,
          initialCommand: command,
          // 启动行在这里就定了，交给 `pending-launch`（无依赖 = 提示符一安静
          // 就敲）而不是让 TerminalSurface 自己拼——它拼不出 `--resume`。
          pendingLaunch: { command, after: [] },
        },
      },
    });
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => setPanel("palette", next)}
      className="z-[var(--z-dialog)]"
      title={t("cluster.palette")}
    >
      <CommandInput
        placeholder={t("palette.placeholder")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>

        {workspace && (
          <CommandGroup heading={t("palette.new")}>
            {newItems.map((item) => {
              const Icon = item.icon;
              const disabled = item.disabledReason?.({
                addNode,
                position: centerPosition(),
                workspace,
                agents,
              });
              return (
                <CommandItem
                  key={item.id}
                  value={`${t("palette.new")} ${item.label}`}
                  disabled={Boolean(disabled)}
                  onSelect={() => {
                    close();
                    item.run({
                      addNode,
                      position: centerPosition(),
                      workspace,
                      agents,
                    });
                  }}
                >
                  <Icon />
                  {item.label}
                  {item.shortcut && (
                    <CommandShortcut>
                      {commandKeysLabel(item.shortcut)}
                    </CommandShortcut>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {nodes.length > 0 && (
          <CommandGroup heading={t("palette.goto")}>
            {nodes.map((node) => (
              <CommandItem
                key={node.id}
                value={`${t("palette.goto")} ${node.title}`}
                onSelect={() => {
                  close();
                  selectNodes([node.id]);
                  // 居中的算术在画布那边（§9.1）：这里只发事件，
                  // 免得壳自己复刻一份节点尺寸与缩放的规则。
                  requestCenterOnNode(node.id);
                }}
              >
                {node.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {workspace && (conversations.data?.length ?? 0) > 0 && (
          <CommandGroup heading={t("meta.conversations")}>
            {conversations.data!.map((conversation) => (
              <CommandItem
                key={`${conversation.provider}:${conversation.sessionId}`}
                value={`${t("meta.conversations")} ${conversation.title} ${basename(conversation.cwd)} ${conversation.provider}`}
                onSelect={() => resume(conversation)}
              >
                <Bot style={{ color: agentColorVar(conversation.provider) }} />
                <span className="min-w-0 flex-1 truncate">
                  {conversation.title}
                </span>
                <CommandShortcut className="truncate">
                  {basename(conversation.cwd)}
                </CommandShortcut>
                <CommandShortcut className="tabular-nums">
                  {formatRelativeTime(conversation.updatedAt)}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading={t("palette.command")}>
          {COMMANDS.filter(
            (command) => command.id !== "app.commandPalette",
          ).map((command) => (
            <CommandItem
              key={command.id}
              value={`${t("palette.command")} ${t(command.labelKey)}`}
              onSelect={() => {
                close();
                run(command.id);
              }}
            >
              {t(command.labelKey)}
              <CommandShortcut>{commandKeysLabel(command.id)}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
