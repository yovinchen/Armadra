import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";

/**
 * 节点头上那一排常驻徽标，多了就折起来。
 *
 * 头部只有一行 30px，而徽标是各自决定要不要出现的：内存一直在，账号、交接、
 * 驱动、排队、主从只在有话说的时候出现。谁都不知道此刻一共有几枚——所以**数
 * 的是渲染出来的 DOM**，不是传进来的 React 子元素：一个 `return null` 的组件
 * 仍然是一个子元素，按它数会把「三枚」数成「五枚」。
 *
 * 超出的那些不卸载，只隐藏：它们各自还在订阅事件（排队徽标在重读队列，驱动
 * 徽标在听租约），卸载会让「折起来」变成「停止工作」。
 */

/** 头部最多平铺这么多枚，多出来的折成一枚计数。 */
export const MAX_VISIBLE_CHIPS = 3;

/** 折起来的那几枚有几枚。`0` 表示不折。 */
export function overflowCount(total: number, max = MAX_VISIBLE_CHIPS): number {
  return total > max ? total - max : 0;
}

export function HeaderChips({ children }: { children?: React.ReactNode }) {
  const t = useT();
  const ref = React.useRef<HTMLSpanElement>(null);
  const [total, setTotal] = React.useState(0);

  // 徽标自己决定出现与消失（事件到了才出现），所以数一次不够：这里跟着 DOM
  // 的增减重新数，而不是在每次父组件重渲时猜。
  React.useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const count = () => setTotal(host.childElementCount);
    count();
    const observer = new MutationObserver(count);
    observer.observe(host, { childList: true });
    return () => observer.disconnect();
  }, [children]);

  const hidden = overflowCount(total);
  return (
    <span className="node-header-chips flex min-w-0 items-center gap-1">
      <span
        ref={ref}
        data-slot="header-chips"
        data-overflow={hidden > 0 ? "true" : undefined}
        className="flex min-w-0 items-center gap-1 [&[data-overflow]>*:nth-child(n+4)]:hidden"
      >
        {children}
      </span>
      {hidden > 0 && (
        <Badge
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
          data-slot="header-chips-overflow"
          title={t("node.chips.more", { count: hidden })}
        >
          {t("node.chips.more", { count: hidden })}
        </Badge>
      )}
    </span>
  );
}
