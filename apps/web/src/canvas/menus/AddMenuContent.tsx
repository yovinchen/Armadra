import * as React from "react";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/ui/dropdown-menu";
import { useT } from "@/app/preferences-store";
import { commandKeysLabel } from "@/keybindings";
import { useSshHosts } from "@/panels/settings/ssh-hosts";
import { buildAddMenu, type AddMenuContext } from "./add-menu";

/**
 * 把 `buildAddMenu` 的规格渲染成 Radix 菜单项（§13.3）。
 *
 * 调用方自己套 `<ContextMenuContent>` / `<DropdownMenuContent>`，
 * 这里只吐子项，所以画布右键、Dock `+`、会话侧栏 `+` 共用同一份实现。
 */
export interface AddMenuContentProps {
  ctx: AddMenuContext;
  kind: "context" | "dropdown";
}

/**
 * 新建菜单容器的尺寸，三处入口共用。
 *
 * shadcn 生成的 `DropdownMenuContent` 把宽度钉在触发器上
 * （`w-(--radix-dropdown-menu-trigger-width)`）。Dock 的 `+` 是一颗 32px 的
 * 图标钮，菜单于是缩到 `min-w-32`（128px），「新建终端」「打开文件…」
 * 「新建定时计划」全被省略号吃掉。这里改回按内容排版，并给一个放得下
 * 「标签 + 快捷键」的下限。
 *
 * 高度不必在这里管：两种容器都已经是
 * `max-h-(--radix-*-content-available-height)` 配 `overflow-y-auto`，
 * 窗口矮的时候菜单自己滚，不会顶出视口。
 */
export const ADD_MENU_CONTENT_CLASS = "w-auto min-w-60 max-w-80";

export function AddMenuContent({ ctx, kind }: AddMenuContentProps) {
  const t = useT();
  // `t` 按 locale 记忆化，所以切语言时菜单会重建，平时不会每帧重算。
  const hosts = useSshHosts();
  const items = React.useMemo(
    () => buildAddMenu(ctx.agents, t, hosts),
    [ctx.agents, hosts, t],
  );
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Label = kind === "context" ? ContextMenuLabel : DropdownMenuLabel;
  const Separator =
    kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const Shortcut =
    kind === "context" ? ContextMenuShortcut : DropdownMenuShortcut;

  return (
    <>
      {items.map((item, index) => {
        const disabledReason = item.disabledReason?.(ctx) ?? null;
        const Icon = item.icon;
        const keys = item.shortcut ? commandKeysLabel(item.shortcut) : "";
        // 画布动作前的分隔线（§3.2），以及 SSH 组前的那一条（§21）。
        const previous = items[index - 1]?.group;
        const newGroup = previous !== item.group;
        return (
          <React.Fragment key={item.id}>
            {newGroup && previous ? <Separator /> : null}
            {newGroup ? (
              <Label className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                {t(`add.group.${item.group}`)}
              </Label>
            ) : null}
            <Item
              className="min-h-8 gap-2.5 rounded-md px-2.5 text-[13px]"
              disabled={disabledReason !== null}
              title={disabledReason ?? item.label}
              onSelect={() => item.run(ctx)}
            >
              <Icon />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {disabledReason ? (
                <span className="max-w-28 shrink-0 truncate text-[11px] text-muted-foreground">
                  {disabledReason}
                </span>
              ) : keys ? (
                <Shortcut>{keys}</Shortcut>
              ) : null}
            </Item>
          </React.Fragment>
        );
      })}
    </>
  );
}
