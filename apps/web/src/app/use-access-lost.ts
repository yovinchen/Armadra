import { useEffect } from "react";
import { toast } from "sonner";

import { onWorkspaceAccessLost } from "../api/events";
import { useCanvasStore } from "../store/canvas-store";
import { t } from "./preferences-store";

/**
 * 这块工作空间的读授权被收回了（服务器壳上撤销共享、停用账号）：core 以 4403
 * 关掉事件流（`api/events.ts`）。
 *
 * 留在原处的话，侧栏会一直把它当「当前工作空间」列着，画布停在一份再也读
 * 不到、存不进的旧文档上，之后的每个请求都是 403 却没人说为什么。所以离开它，
 * 并用一句话说明；工作空间列表由事件流那边重取，它会从侧栏里消失。
 */
export function useWorkspaceAccessLost(): void {
  useEffect(
    () =>
      onWorkspaceAccessLost((lost) => {
        const state = useCanvasStore.getState();
        if (state.workspace?.id !== lost) return;
        const name = state.workspace.name;
        state.setWorkspace(null);
        toast.info(t("sharing.revoked", { name }));
      }),
    [],
  );
}
