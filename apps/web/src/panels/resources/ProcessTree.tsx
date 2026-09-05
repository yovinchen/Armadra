/**
 * 展开后的进程列表（设计 §8「面板支持…查看进程树」）。
 *
 * 只有进程名、pid 和两个数字。**不显示命令行**：参数里可能有路径、token 和
 * 用户不打算给面板看的东西，而回答「谁在吃内存」并不需要它们。
 *
 * Runtime 只回占用最高的若干个，`total` 是真实总数。截断时明说，免得读者以为
 * 这就是全部——那会让一棵一百个进程的树看起来只有三十二个。
 */
import type { ProcessSample } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { formatMetricBytes, formatPercent } from "./metrics";

export function ProcessTree({
  processes,
  total,
}: {
  processes: readonly ProcessSample[];
  total: number | null;
}) {
  const t = useT();
  if (processes.length === 0) return null;
  const truncated = typeof total === "number" && total > processes.length;

  return (
    <ul className="mt-0.5 ml-7 flex flex-col gap-0.5 border-l border-border pl-2">
      {processes.map((process) => (
        <li
          key={`${process.pid}:${process.startTimeUnixMs ?? "?"}`}
          className="flex items-center gap-2 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {process.name}
            <span className="ml-1 opacity-70">pid {process.pid}</span>
          </span>
          <span className="w-12 shrink-0 text-right tabular-nums">
            {formatPercent(process.cpuPercent)}
          </span>
          <span className="w-16 shrink-0 text-right tabular-nums">
            {formatMetricBytes(process.memoryBytes)}
          </span>
        </li>
      ))}
      {truncated && (
        <li className="text-[11px] text-muted-foreground">
          {t("resources.session.treeTruncated", { count: processes.length })}
        </li>
      )}
    </ul>
  );
}
