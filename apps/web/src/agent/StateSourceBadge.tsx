import type { AgentStateSource } from "@armadra/shared";

import { useT } from "@/app/preferences-store";

/**
 * 节点头部的状态来源提示（协作通道 §3.2 / §3.4）。
 *
 * 头部已经说了「Agent 在做什么」，这里说的是「凭什么这么说」——两件不同的
 * 事，所以是两个位置，胶囊不带这层信息。
 *
 * `hook` 与 `extension` 是同一份认证报告的两种传输（fork 一次客户端，或者
 * CLI 进程内的扩展直连同一个 socket），都是回合确实结束了的证据；`observed`
 * 是 §3.4 的 PTY 侧猜测，它只配出现在这里：交接与消息投递的空闲门读的是
 * 上报，不是它。没有来源就什么都不画——那是「还没有人报过」，说成 idle 是
 * 另一回事。
 *
 * F5 之后它是标题**左边的一个 6px 色点**，不是徽标：这一行常驻在每个 Agent
 * 节点上，一个图标加一圈描边已经是头部里最贵的东西。上报（hook / extension）
 * 是实心的品牌色，猜测（observed）是空心的灰点——一眼就分得出「有人报过」
 * 和「我们自己看出来的」，说明留在悬停提示与无障碍名里。
 */
const SOURCE_STYLES: Record<AgentStateSource, string> = {
  hook: "bg-[var(--brand)]",
  extension: "bg-[var(--brand)]",
  observed: "border border-[var(--border-strong)] bg-transparent",
};

export function StateSourceBadge({
  source,
}: {
  source: AgentStateSource | undefined;
}) {
  const t = useT();
  if (!source) return null;
  const label = t(`agent.stateSource.${source}`);
  return (
    <span
      // 一个只有颜色的点，没有 role 就是一段没有名字的空白：读屏什么都不会
      // 念，`title` 也只对鼠标有用，所以两样都给。
      role="img"
      aria-label={label}
      title={`${label} — ${t(`agent.stateSource.${source}.note`)}`}
      data-state-source={source}
      data-slot="state-source-dot"
      className={`size-1.5 shrink-0 rounded-full ${SOURCE_STYLES[source]}`}
    />
  );
}
