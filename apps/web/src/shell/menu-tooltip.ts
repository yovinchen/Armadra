import * as React from "react";

/**
 * 「按钮既有 Tooltip 又开菜单」的接线（§14 第 1 条）。
 *
 * 症状：点开 Dock 的「新建」，把菜单关掉，「新建」这条提示还挂在屏幕上。
 *
 * 原因在 Radix：菜单收起时它把焦点还给触发器，而 `Tooltip.Trigger` 的
 * `onFocus` 会直接把提示打开（`if (!isPointerDownRef.current) onOpen()`，
 * 那一下 pointerup 早就把标记清了）。指针这时并不在按钮上，`pointerleave`
 * 永远不会来，提示于是一直留着。
 *
 * 这里给两样东西：
 *
 * - `menuProps`：摊给 `<DropdownMenu>` / `<Popover>`，用来接管开合状态；
 *   关闭那一下先记一笔「接下来这次 focus 是还回来的」。
 * - `tooltipTriggerProps`：摊给 `<TooltipTrigger>`。那一次 focus 上
 *   `preventDefault()`——Radix 的 `composeEventHandlers` 默认看
 *   `defaultPrevented`，于是它自己的 `onOpen` 不会跑。键盘 Tab 到按钮上的
 *   提示照旧，只有「菜单关掉后还回来的焦点」被吃掉。
 *
 * `menuOpen` 顺手返回，调用方拿去点亮按钮、以及在菜单开着时不渲染提示。
 */
export interface MenuTooltip {
  menuOpen: boolean;
  menuProps: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
  tooltipTriggerProps: {
    onFocus: (event: React.FocusEvent) => void;
  };
}

export function useMenuTooltip(
  onChange?: (open: boolean) => void,
): MenuTooltip {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const restoringFocus = React.useRef(false);

  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) restoringFocus.current = true;
      setMenuOpen(open);
      onChange?.(open);
    },
    [onChange],
  );

  const onFocus = React.useCallback((event: React.FocusEvent) => {
    if (!restoringFocus.current) return;
    restoringFocus.current = false;
    event.preventDefault();
  }, []);

  return {
    menuOpen,
    menuProps: { open: menuOpen, onOpenChange },
    tooltipTriggerProps: { onFocus },
  };
}
