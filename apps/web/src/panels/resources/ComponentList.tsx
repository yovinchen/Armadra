/**
 * Armadra 自己的进程，单独一组（设计 §8「平台组件」，路线图 §4.3）。
 *
 * 和用户的 CLI 会话分开，因为那是两个问题：「我的 Agent 占多少」和「这个应用
 * 占多少」。混在一起的话，一次重构里 Agent 吃掉 3 GB 会看起来像应用臃肿，反过
 * 来应用真的臃肿时又会被藏在会话总数里。
 *
 * Runtime 那一行只算它自己：它启动的会话是它的子进程，加进来就等于把用户的
 * Agent 在平台这边再数一遍。命令 Worker 反过来算整棵树，它跑的命令就是它存在
 * 的理由。哪一种，行里直接写出来，不让读者猜。
 */
import type { PlatformComponent } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { ProcessTree } from "./ProcessTree";
import { formatMetricBytes, formatPercent } from "./metrics";

export function ComponentList({
  components,
}: {
  components: readonly PlatformComponent[];
}) {
  const t = useT();

  if (components.length === 0) {
    return (
      <p className="px-1 py-2 text-[12px] text-muted-foreground">
        {t("resources.noComponents")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {components.map((component) => (
        <li
          key={`${component.process.pid}:${component.process.startTimeUnixMs ?? "?"}`}
          className="flex flex-col rounded-[var(--r-control)] px-1.5 py-1 hover:bg-accent"
        >
          <div className="flex w-full items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px]">
                {t(`resources.component.${component.kind}`)}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {component.tree
                  ? t("resources.component.tree")
                  : t("resources.component.selfOnly")}
                {` · pid ${component.process.pid}`}
                {component.location === "remote" &&
                  ` · ${t("resources.location.remote")}`}
                {component.unknownReason === "remote" &&
                  ` · ${t("resources.unknown.remote")}`}
              </div>
            </div>
            <span className="w-14 shrink-0 text-right text-[12px] tabular-nums">
              {formatPercent(component.process.cpuPercent)}
            </span>
            <span className="w-20 shrink-0 text-right text-[12px] tabular-nums">
              {formatMetricBytes(component.process.memoryBytes)}
            </span>
          </div>
          {component.tree && (
            <ProcessTree
              processes={component.children}
              total={component.childCount}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
