import * as React from "react";
import type {
  BrowserActivity,
  BrowserDialog,
  BrowserFileChooser,
  BrowserLease,
} from "@armadra/shared";

import { onWorkspaceEvent } from "@/api/events";

/**
 * Agent 驱动期间，人在画布上看得到的那一行（复查 §5.2 的「对话框 / 文件
 * 选择器」行、§7 的 #5 与 #8）。
 *
 * Agent 驱动一个页面时，页面照样会 `confirm()`，照样会开文件选择器。那两件
 * 事由主进程按 CDP 事件当场处理，人不参与——但人**必须看得见**，否则一个停
 * 在对话框上的页面在画布上和一个正常页面长得一模一样。
 *
 * ## 怎么认出「这是我这个节点的事」
 *
 * 三条事件都走工作空间事件流，键是 `sessionId`（Runtime 那一行的主键）；而
 * 页面这一侧只知道 `nodeId`，两者之间没有一条现成的对照表。
 *
 * 认领靠的是活动事件自己带的 `actorId`：Runtime 把驱动方 Agent 的节点 id 写
 * 进去，而同一个 Agent 正是租约的持有者——租约由 `browser:drive` 按 `nodeId`
 * 送到这个组件手里。两边对上，这个 `sessionId` 就是本节点的，之后三条事件
 * 一律按 `sessionId` 严格过滤。
 *
 * 一个 Agent 同时驱动两个浏览器节点时，两边的租约持有者是同一个 id，所以
 * 第一条活动会被先到的那个节点认领；`CLAIMED` 保证它不会被第二个节点重复
 * 认领——宁可另一个节点暂时不显示，也不要显示别人的页面在做什么。
 */

export interface BrowserAlerts {
  /** Agent 最近一次动作。 */
  activity: BrowserActivity | null;
  /** 页面正被一个对话框挡着。 */
  dialog: BrowserDialog | null;
  /** 页面正在要文件。 */
  chooser: BrowserFileChooser | null;
}

const EMPTY: BrowserAlerts = { activity: null, dialog: null, chooser: null };

/** `sessionId` → 已经认领它的 `nodeId`。一个会话只归一个节点。 */
const CLAIMED = new Map<string, string>();

/** 测试用：清掉认领表。 */
export function resetBrowserAlerts(): void {
  CLAIMED.clear();
}

export function useBrowserAlerts(
  nodeId: string,
  lease: BrowserLease | undefined,
): BrowserAlerts {
  const [alerts, setAlerts] = React.useState<BrowserAlerts>(EMPTY);
  const sessionRef = React.useRef<string | null>(null);
  const leaseRef = React.useRef(lease);
  leaseRef.current = lease;

  React.useEffect(() => {
    /** 这条事件属不属于本节点。第一条活动同时完成认领。 */
    function mine(sessionId: string, actorId?: string): boolean {
      if (sessionRef.current !== null) return sessionRef.current === sessionId;
      if (actorId === undefined) return false;
      const holder = leaseRef.current?.holder;
      if (leaseRef.current?.state !== "agent" || holder?.kind !== "agent") {
        return false;
      }
      if (!actorId || actorId !== holder.id) return false;
      if (CLAIMED.has(sessionId)) return false;
      CLAIMED.set(sessionId, nodeId);
      sessionRef.current = sessionId;
      return true;
    }

    const stops = [
      onWorkspaceEvent("browser.activity", (event) => {
        if (!mine(event.sessionId, event.actorId)) return;
        const { type: _type, ...activity } = event;
        setAlerts((previous) => ({ ...previous, activity }));
      }),
      onWorkspaceEvent("browser.dialog", (event) => {
        if (!mine(event.sessionId)) return;
        setAlerts((previous) => ({
          ...previous,
          dialog: event.dialog ?? null,
        }));
      }),
      onWorkspaceEvent("browser.fileChooser", (event) => {
        if (!mine(event.sessionId)) return;
        setAlerts((previous) => ({
          ...previous,
          chooser: event.chooser ?? null,
        }));
      }),
    ];

    return () => {
      for (const stop of stops) stop();
      const session = sessionRef.current;
      if (session !== null && CLAIMED.get(session) === nodeId) {
        CLAIMED.delete(session);
      }
      sessionRef.current = null;
    };
  }, [nodeId]);

  return alerts;
}
