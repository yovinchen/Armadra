import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { RuntimeSettingsPatch } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { settingsGateway } from "../../settings";

/**
 * 设置文档的共享读写。
 *
 * 每一页都用同一个 `["settings"]` 查询键：SSH、Agent、终端、数据几页改的
 * 是同一份文档，共享缓存就不会互相覆盖，也不会各自轮询。写成功后直接把
 * 回来的整份文档塞回缓存。
 *
 * 读写都经 `settingsGateway`，调用点只认它那两个方法。
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
      toast.error(t("settings.saveFailed"), { description: cause.message }),
  });
  return { settings, save };
}
