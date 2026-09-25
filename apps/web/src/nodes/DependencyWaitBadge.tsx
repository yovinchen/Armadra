/**
 * 「等待 X」——这个节点启动之前在等谁（Agent 自动化设计 §6）。
 *
 * 等待与启动都归 core：数据从依赖表来（`agent/dependency-store.ts`），不再读
 * 节点数据里的 `pendingLaunch`。上游失败、被删、等过了期的边不会自己放行，所
 * 以浮层里给一个「不等了」：取消还挡着它的边，其余都满足时 core 当场启动。
 * 没有等待就什么都不画。
 */
import * as React from "react";
import { Hourglass } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  cancelNodeDependencies,
  useNodeDependencies,
} from "@/agent/dependency-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export function DependencyWaitBadge({
  nodeId,
  workspaceId,
}: {
  nodeId: string;
  workspaceId: string | null;
}) {
  const t = useT();
  const launch = useNodeDependencies(workspaceId, nodeId);
  const [busy, setBusy] = React.useState(false);
  if (!launch || workspaceId === null) return null;

  const blocking = launch.dependencies.filter(
    (edge) => edge.state !== "satisfied" && edge.state !== "cancelled",
  );
  const stuck =
    launch.state === "failed" ||
    blocking.some((edge) => edge.state !== "waiting");
  const names = blocking
    .map((edge) => edge.upstreamTitle ?? t("dependency.deleted"))
    .join(t("dependency.separator"));
  const label =
    launch.state === "failed"
      ? t("dependency.launchFailed")
      : t("dependency.waiting", { names });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className={
            "h-[18px] px-1.5 text-[length:var(--text-caption)]" +
            (stuck ? " text-[var(--danger)]" : "")
          }
          data-no-drag="true"
        >
          <button
            type="button"
            data-slot="dependency-wait"
            data-testid={`dependency-wait-${nodeId}`}
            aria-label={label}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Hourglass className="size-2.5" />
            <span className="max-w-40 truncate">{label}</span>
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-1rem)] text-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="font-medium">{t("dependency.title")}</h3>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {launch.dependencies.map((edge) => (
            <li key={edge.id} className="min-w-0">
              <span className="block truncate">
                {edge.upstreamTitle ?? t("dependency.deleted")}
              </span>
              <span className="block truncate text-muted-foreground">
                {t(`dependency.condition.${edge.condition}`)}
                {" · "}
                {t(`dependency.state.${edge.state}`)}
              </span>
            </li>
          ))}
        </ul>
        {blocking.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void cancelNodeDependencies(workspaceId, launch).finally(() =>
                setBusy(false),
              );
            }}
          >
            {t("dependency.cancel")}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
