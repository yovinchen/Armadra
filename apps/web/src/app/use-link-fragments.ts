import { useEffect } from "react";

import { hasInvitationFragment } from "../api/accounts";
import { hasPairingFragment } from "../api/identity";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "./preferences-store";

/**
 * 服务器壳的两种链接落在页面根的片段上：邀请 `#invite=<令牌>` 打开到「账号与
 * 共享」，兑换对话框在那一页取走令牌；配对 `#pair=<票>` 打开到「后台服务」，
 * 那一页检查连接后取走票完成配对。只看一次，片段由那两页抹掉。
 *
 * 必须挂在浮层闸门之外（`Overlays.tsx`）：设置对话框只在打开之后才挂载，把
 * 这段判断放进对话框里，等于链接打开后什么都不会发生。
 */
export function useLinkFragments(serverShell = RUNTIME_VIA_SERVER_SHELL): void {
  useEffect(() => {
    if (!serverShell) return;
    const section = hasInvitationFragment()
      ? "accounts"
      : hasPairingFragment()
        ? "host"
        : undefined;
    if (section === undefined) return;
    usePreferencesStore.getState().setLastSettingsSection(section);
    useCanvasStore.getState().setPanel("settings", true);
  }, [serverShell]);
}
