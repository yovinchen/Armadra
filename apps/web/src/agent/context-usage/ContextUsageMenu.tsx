import * as React from "react";
import { Gauge } from "lucide-react";
import type { ContextThresholds, ContextUsage } from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import { contextUsageView } from "./details";

export interface ContextUsageMenuProps {
  nodeId: string;
  sessionId: string | null;
  generation: number | null;
  usage: ContextUsage | null;
  unavailableReason?: ContextUsage["unknownReason"];
  /** Settings → Agent; the defaults are only a fallback for tests. */
  thresholds?: ContextThresholds;
}

/**
 * 节点 `···` 菜单里的「上下文占用」一行（F5）。
 *
 * 以前它是头部常驻的一个徽标，没有来源时就写着「未知」——一个每个 Agent
 * 节点都挂着的、多数时候什么也没说的词。现在它是菜单里的一行：有来源时那一行
 * 直接显示百分比，展开才是完整的诊断表（模型、容量、来源、代次、观测时刻…）。
 *
 * 用子菜单而不是 Popover：Popover 开在 Radix 菜单里会和菜单的焦点陷阱打架，
 * 而子菜单本来就是菜单自己的东西。
 */
export function ContextUsageMenu({
  nodeId,
  sessionId,
  generation,
  usage,
  unavailableReason,
  thresholds,
}: ContextUsageMenuProps) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.contextThresholds);
  const received = React.useRef({ usage, at: Date.now() });
  if (received.current.usage !== usage)
    received.current = { usage, at: Date.now() };

  const view = contextUsageView(
    {
      nodeId,
      sessionId,
      generation,
      usage,
      ...(unavailableReason ? { unavailableReason } : {}),
      elapsedMs: Date.now() - received.current.at,
      ...((thresholds ?? stored) ? { thresholds: thresholds ?? stored } : {}),
    },
    t,
  );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger aria-label={view.label}>
        <Gauge />
        <span>{t("context.title")}</span>
        <span
          className={`ml-auto pl-2 tabular-nums ${
            view.level === "danger"
              ? "text-destructive"
              : view.level === "warn"
                ? "text-amber-500"
                : "text-muted-foreground"
          }`}
        >
          {view.text}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-80 max-w-[calc(100vw-24px)] p-2 text-xs">
        <h3 className="font-medium">{view.title}</h3>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {view.rows.map(([label, content]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="m-0 break-words text-right [overflow-wrap:anywhere]">
                {content}
              </dd>
            </React.Fragment>
          ))}
        </dl>
        {view.notes.map((note) => (
          <p key={note} className="mt-1.5 text-muted-foreground">
            {note}
          </p>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
