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
