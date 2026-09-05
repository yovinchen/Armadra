import { UserRound } from "lucide-react";
import type { TerminalAgent } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";

/**
 * 节点头部的账号绑定标记（画布设计 §4 表格「节点头部」，S02）。
 *
 * 账号绑定还没有实现：Host 在 Hello 里把 `accountBinding` 报为 unsupported，
 * `PresenceService` / `AccountService` 一律返回 UNSUPPORTED。所以这里**只在
 * 节点数据上真的有 `agent.account` 时**才渲染——字段缺省就完全不占位置，
 * 设置页也没有绑定入口。没有伪按钮、没有下拉、没有「切换账号」。
 *
 * 显示的是节点声明的账号，不是「生效中的账号」：CLI 用哪个账号登录由它自己
 * 决定，Runtime 现在对非 `default` 的账号显式拒绝。凭据引用（`credentialRef`）
 * 只是凭据存储里的一个名字，不是密钥，也不在这里显示。
 */
export function AccountBindingBadge({ agent }: { agent: TerminalAgent }) {
  const t = useT();
  const account = agent.account;
  if (!account) return null;
  const label = account.label || account.accountId;
  return (
    <Badge
      variant="outline"
      className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
      title={t("account.badge.reserved", {
        account: account.providerId
          ? `${account.providerId} · ${account.accountId}`
          : account.accountId,
      })}
    >
      <UserRound className="size-2.5" />
      <span className="max-w-24 truncate">{label}</span>
    </Badge>
  );
}
