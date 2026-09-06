import { useQuery } from "@tanstack/react-query";
import { isLocalSettingPath } from "@armadra/shared";

import { runtimeApi } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { Badge } from "@/ui/badge";

/**
 * 「这条设置存在本机」的来源标记（Host 业务所有权迁移 §1.4）。
 *
 * 大部分设置跟着账号走，少数几条不能：这台机器上有没有 tmux、浏览器可执行
 * 文件在哪、允不允许阻止它休眠。它们存在 `worker-settings.json`，改了只对
 * 这台机器生效——不说出来的话，用户会以为在别的设备上也改了。
 *
 * 清单向 Runtime 要，不在前端写第二份：前端那份一旦和 Runtime 分歧，页面
 * 上的标记就是错的，而错的地方恰好是「这会不会同步」。
 */
export function useLocalSettings() {
  const local = useQuery({
    queryKey: ["settings", "local"],
    queryFn: runtimeApi.localSettings,
    // 一次启动内不会变：拆分表是编译进 Runtime 的。
    staleTime: Infinity,
    retry: false,
  });
  const paths = local.data?.paths ?? [];
  return {
    file: local.data?.file ?? "",
    isLocal: (path: string) => isLocalSettingPath(paths, path),
  };
}

/** 一行设置的来源徽标；不是本机项就什么也不画。 */
export function LocalSourceBadge({ path }: { path: string }) {
  const t = useT();
  const { file, isLocal } = useLocalSettings();
  if (!isLocal(path)) return null;
  return (
    <Badge
      variant="secondary"
      className="shrink-0 font-normal"
      // 文件名放 title 而不是行内：一行设置里塞一条路径会把标签挤没，
      // 但「存在哪」是想弄清楚同步行为的人第一个要问的。
      title={t("settings.source.localFootnote", { file })}
    >
      {t("settings.source.local")}
    </Badge>
  );
}
