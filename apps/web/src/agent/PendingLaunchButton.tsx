import { Hourglass, Play } from "lucide-react";

import { IconButton } from "@/ui/icon-button";
import { useT } from "@/app/preferences-store";
import { runPendingLaunchNow, usePendingLaunch } from "./pending-launch";

/**
 * 待启动节点在头部的那一个按钮（§5.8）。
 *
 *  - 等依赖时：⏳，不可点（状态由 rope 边表达，这里只是节点自己的回声）；
 *  - 三次重试都没有回执后：▶「立即运行」，点一下再敲一次启动行；
 *  - 其余时候什么都不渲染。
 */
export function PendingLaunchButton({ nodeId }: { nodeId: string }) {
  const t = useT();
  const entry = usePendingLaunch(nodeId);
  if (!entry) return null;

  if (entry.phase === "manual") {
    return (
      <IconButton
        className="nodrag"
        label={t("launch.manual")}
        onClick={() => runPendingLaunchNow(nodeId)}
      >
        <Play />
      </IconButton>
    );
  }
  if (entry.phase !== "waiting") return null;
  return (
    <IconButton className="nodrag" disabled label={t("launch.waiting")}>
      <Hourglass />
    </IconButton>
  );
}
