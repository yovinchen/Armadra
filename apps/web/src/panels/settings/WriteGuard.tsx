import type { ReactNode } from "react";

import { useT } from "../../app/preferences-store";
import { useSettingsWritable } from "./use-runtime-settings";

/**
 * 改的是设置文档的那几个分区。
 *
 * 其余分区（关于、更新、GitHub 登录、本机偏好）写的不是这份文档，归属切换
 * 不该把它们一起禁掉——按不动的按钮比没有按钮更糟。
 */
export const SETTINGS_DOCUMENT_SECTIONS = new Set([
  "agent",
  "integration",
  "terminal",
  "workspace",
  "ssh",
  "data",
  "account",
  "keybindings",
]);

/**
 * 归属切换期间把设置页变成只读（业务所有权迁移 §2.4）。
 *
 * 维护窗口开着时两侧都拒绝写，这时候还把开关摆在那里，用户点一下只会看到
 * 一个失败提示，并且不知道自己改的到底存没存。所以先说明原因，再把整页控件
 * 禁掉：`fieldset[disabled]` 会一路禁到里面的每一个表单控件，页面布局不变。
 */
export function SettingsWriteGuard({
  section,
  children,
}: {
  section: string;
  children: ReactNode;
}) {
  const t = useT();
  const { blocked, reasonKey } = useSettingsWritable();
  if (!blocked || !SETTINGS_DOCUMENT_SECTIONS.has(section))
    return <>{children}</>;
  return (
    <>
      <div
        role="status"
        data-testid="settings-readonly"
        className="rounded-lg border border-border bg-panel px-3 py-2 text-[12px] leading-5 text-muted-foreground"
      >
        {t(reasonKey)}
      </div>
      <fieldset disabled className="contents">
        {children}
      </fieldset>
    </>
  );
}
