import { useEffect } from "react";

import { useT } from "../../../app/preferences-store";
import {
  domainStatus,
  useOwnership,
  OWNERSHIP_DOMAINS,
} from "../../../ownership/store";
import { useCanvasOwnership } from "../../../canvas-ownership";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Badge } from "@/ui/badge";

/**
 * 六个业务域此刻由谁写（Go Host 业务所有权迁移 §2.2、§2.11）。
 *
 * 只读。切换需要在本机控制通道上申请的维护窗口令牌，浏览器拿不到，所以这里
 * 不放「切换」按钮——按不动的按钮比没有按钮更糟。要切换就用
 * `armadra-host ownership switch --domain D`。
 *
 * 维护窗口开着时那一行显示为只读并带原因键：那正是两边都拒绝写的状态，把它
 * 画成正常归属会让人以为改动还在保存。
 */
/**
 * 只有登记过的原因键才当键用。服务将来会加新的键，把没登记的原样画到界面上
 * 等于把内部字符串当文案，所以未知的就不显示。
 */
const KNOWN_REASONS = new Set([
  "ownership.switch.pending",
  "ownership.switch.unknown",
  "ownership.rollback.exported",
]);

export function OwnershipPanel() {
  const t = useT();
  const { domains, failed, probing, probe } = useOwnership();
  // 画布那一档跟着写入路由的探测走，两处显示才不会互相矛盾。
  const canvas = useCanvasOwnership((state) => state.status);

  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <SettingsGroup title={t("ownership.title")}>
      {OWNERSHIP_DOMAINS.map((domain) => {
        const record = domains.find((entry) => entry.domain === domain);
        const status =
          domain === "canvas" && canvas !== "unknown"
            ? canvas
            : domainStatus(domain, domains);
        const maintenance = status === "maintenance";
        return (
          <SettingsRow
            key={domain}
            label={t(`ownership.domain.${domain}`)}
            footnote={
              maintenance && record && KNOWN_REASONS.has(record.reasonCode)
                ? t(`ownership.reason.${record.reasonCode}`)
                : undefined
            }
          >
            <Badge
              variant={
                status === "host"
                  ? "default"
                  : status === "runtime"
                    ? "secondary"
                    : "outline"
              }
              className="h-5 px-1.5 text-[11px]"
            >
              {t(`ownership.writer.${status}`)}
            </Badge>
            {record && !maintenance && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t("ownership.epoch")} {record.epoch.toString()}
              </span>
            )}
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={null}
        className="text-[11px] leading-4 text-muted-foreground"
      >
        <span>
          {failed
            ? t("ownership.unavailable")
            : probing && domains.length === 0
              ? t("ownership.loading")
              : t("ownership.note")}
        </span>
      </SettingsRow>
    </SettingsGroup>
  );
}
