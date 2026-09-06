import { Eye, Plug, Puzzle } from "lucide-react";
import type { AgentStateSource } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";

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
 * 只给图标：这一行常驻在每个 Agent 节点上，多一个词就是每个节点多一个词。
 * 三种来源三个图标，说明留在 tooltip 与无障碍名里。
 */
const SOURCE_ICONS = { hook: Plug, extension: Puzzle, observed: Eye } as const;

export function StateSourceBadge({
  source,
}: {
  source: AgentStateSource | undefined;
}) {
  const t = useT();
  if (!source) return null;
  const Icon = SOURCE_ICONS[source];
  const label = t(`agent.stateSource.${source}`);
  return (
    <Badge
      variant="outline"
      className="h-[18px] px-1 text-[length:var(--text-caption)] text-muted-foreground"
      title={`${label} — ${t(`agent.stateSource.${source}.note`)}`}
      // 一个只有图标的标记，没有 role 就是一段没有名字的空白：读屏什么都
      // 不会念，`title` 也只对鼠标有用。
      role="img"
      aria-label={label}
      data-state-source={source}
    >
      <Icon className="size-2.5" />
    </Badge>
  );
}
