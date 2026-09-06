import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { RuntimeSettingsPatch } from "../../api/client";
import { useT } from "../../app/preferences-store";
import {
  canEditCanvas,
  type CanvasOwnershipStatus,
} from "../../canvas-ownership";
import { settingsStatus, useOwnership } from "../../ownership/store";
import {
  settingsGateway,
  SettingsOwnershipMovedError,
  SettingsReadOnlyError,
} from "../../settings";

/**
 * 设置文档不能写时该说哪一句。三档分开，因为要用户做的事不一样：维护窗口
 * 等一会儿就好，读不到归属得先把 Runtime 接上，还没探到则只是「稍等」。
 */
function reasonKey(status: CanvasOwnershipStatus): string {
  if (status === "maintenance") return "ownership.settings.readonly";
  if (status === "error") return "ownership.settings.error";
  return "ownership.settings.unconfirmed";
}

/**
 * 设置域此刻能不能写。
 *
 * `maintenance` 与 `error` 是确定的「现在写不了」，界面据此变成只读；
 * `unknown` 只是探测还没回来，不该把整页控件禁掉——真要保存时网关会拦下来
 * 并说明原因。
 */
export function useSettingsWritable() {
  const status = useOwnership(settingsStatus);
  const probe = useOwnership((state) => state.probe);
  useEffect(() => {
    void probe();
  }, [probe]);
  return {
    status,
    writable: canEditCanvas(status),
    /** 确定写不了（而不是「还不知道」），界面应当显示为只读。 */
    blocked: status === "maintenance" || status === "error",
    reasonKey: reasonKey(status),
  };
}

/**
 * 设置文档的共享读写。
 *
 * 每一页都用同一个 `["settings"]` 查询键：SSH、Agent、终端、数据几页改的
 * 是同一份文档，共享缓存就不会互相覆盖，也不会各自轮询。写成功后直接把
 * 回来的整份文档塞回缓存。
 *
 * 走 Runtime 还是走 Host 由 `settingsGateway` 按归属决定，两侧的返回形状
 * 一致，所以设置页不需要知道是谁答的。
 */
export function useRuntimeSettings() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsGateway.load(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (patch: RuntimeSettingsPatch) => settingsGateway.patch(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(["settings"], next);
      // `agents.custom[]` 是 `GET /api/agents` 的一部分（§24.1）：存完自定义
      // Agent 就得让新建菜单、启动行那份快照重新拉一次，否则要等 60 秒。
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (cause: Error) =>
      toast.error(t("settings.saveFailed"), {
        description:
          cause instanceof SettingsReadOnlyError
            ? t(reasonKey(cause.status))
            : cause instanceof SettingsOwnershipMovedError
              ? t("ownership.settings.host")
              : cause.message,
      }),
  });
  return { settings, save };
}
