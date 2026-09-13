import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { formatRelativeTime } from "../../../lib/format";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";

/**
 * 价格与上下文上限的出处（用户实测反馈 F10）。
 *
 * 用户问的是“模型计费用的是哪家渠道的价格”，那就把答案写在成本开关旁边：
 * 来源、取的时间、覆盖了多少个模型，外加一个立刻更新的按钮。联网只发生在
 * Runtime 侧——页面从不直接访问 models.dev。
 *
 * 取不到时返回的仍是 200：目录没换，只是没更新成，所以这里照常显示当前来源，
 * 另起一行说明失败。
 */
export function ModelCatalogPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["model-catalog"],
    queryFn: () => runtimeApi.modelCatalog(),
    staleTime: 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => runtimeApi.refreshModelCatalog(),
    onSuccess: (next) => {
      queryClient.setQueryData(["model-catalog"], next);
      // 价格换了，已经算出来的成本汇总就过期了。
      void queryClient.invalidateQueries({ queryKey: ["usage-cost"] });
    },
  });

  const document = catalog.data;
  const source = document
    ? t(`settings.priceSource.${document.source}`)
    : t("settings.priceSource.builtIn");
  const updated = document?.fetchedAt
    ? formatRelativeTime(document.fetchedAt)
    : t("settings.priceUpdatedNever");
  const failed = Boolean(document?.refreshError) || refresh.isError;

  return (
    <SettingsGroup>
      <SettingsRow
        label={t("settings.priceSource")}
        footnote={t("settings.priceSourceHint", {
          path: "model-pricing.json",
        })}
      >
        <span className="text-right text-xs text-muted-foreground">
          {source}
        </span>
      </SettingsRow>
      <SettingsRow label={t("settings.priceUpdated")}>
        <span className="text-right text-xs text-muted-foreground">
          {updated}
          {document
            ? ` · ${t("settings.priceModelCount", {
                count: document.pricedModels,
              })}`
            : ""}
        </span>
      </SettingsRow>
      {failed && (
        <SettingsRow label={null}>
          <span role="status" className="text-[11px] text-danger">
            {t("settings.priceRefreshFailed")}
          </span>
        </SettingsRow>
      )}
      <SettingsRow label={null}>
        <Button
          variant="secondary"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            className={refresh.isPending ? "animate-spin" : undefined}
          />
          {t("settings.priceRefresh")}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
