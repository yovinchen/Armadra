import { loadNode } from "./nodes";
import { type UnreadDigest, unreadDigest } from "./mailbox";
import { enqueue } from "./send-queue";
import { type CollabContext, nowSeconds } from "./service";
import { uuidV7 } from "../workspaces/support";

/**
 * 收件箱唤醒（设计 `agent-delivery.md` §5）。
 *
 * 收件箱是拉取式的，而拉取需要一个还在运行的拉取者：一个停在空闲提示符上的
 * CLI 不会自发去读 `canvas inbox`（§1.3）。所以当目标**进入空闲**而它的收件箱
 * 里还躺着未读时，由 core 推一条进去。
 *
 * 三条边界，逐条都是设计里写死的：
 *
 *   1. **同一条队列，两种来源。** 唤醒与 `send` 共用 `agent_send_queue`、共用
 *      容量、共用串行门与整条门链。不给唤醒开快车道——两条路径同时命中一个刚
 *      空闲的终端，那就是两次粘贴挤在一起。
 *   2. **唤醒不是投递保证。** 队列项的 TTL 与 `send` 一样是五分钟；过期就过
 *      期，收件箱那条消息仍在表里，24 小时后自己过期。
 *   3. **`deliver` 模式下不自动 `ack`。** ack 的语义是「我接下了」，应用替人
 *      ack 会让交接状态变成谎话。
 *
 * 「同一批未读只提示一次」记在进程内（{@link notified}）而不是库里：它是时序
 * 而不是状态，与 `hook/reduce.ts` 的 `Memory` 同一类。重启之后最多多提示一
 * 次，而那一次的前提是目标真的又跑完了一轮——那时候再提醒他一遍并不冒犯。
 */

/** 节点设置 `data.agent.inboxWake` 的三档。 */
export const INBOX_WAKE_MODES = ["off", "notify", "deliver"] as const;

export type InboxWake = (typeof INBOX_WAKE_MODES)[number];

/**
 * 缺省是**提示**而不是关掉。
 *
 * 与设计 §5 那张表的默认值（`off`）不同，这是本阶段有意选的一条：`post` 今天
 * 的失效方式不是「提示太吵」，是「没有人来读」（§1.1 的实测）。一条 32 个字
 * 的提示行，比一个默认关掉、因而没有人会去打开的开关诚实。关掉它仍然是一次
 * 设置的事。
 */
export const DEFAULT_INBOX_WAKE: InboxWake = "notify";

/** `data.agent.inboxWake`，读不出来就是默认档。 */
export function inboxWakeOf(data: unknown): InboxWake {
  if (data === null || typeof data !== "object") return DEFAULT_INBOX_WAKE;
  const agent = (data as Record<string, unknown>).agent;
  if (agent === null || typeof agent !== "object") return DEFAULT_INBOX_WAKE;
  const wanted = (agent as Record<string, unknown>).inboxWake;
  return (INBOX_WAKE_MODES as readonly string[]).includes(wanted as string)
    ? (wanted as InboxWake)
    : DEFAULT_INBOX_WAKE;
}

/** 节点 → 已经为哪一批未读提示过（那一批里最大的 `sequence`）。 */
const notified = new Map<string, number>();

/** 用例之间换一份干净的。 */
export function resetInboxWake(): void {
  notified.clear();
}

export interface WakeOutcome {
  readonly queued: boolean;
  /** 没排进去的理由，给用例与日志看。 */
  readonly reason?:
    | "off"
    | "no-unread"
    | "already-notified"
    | "not-idle"
    | "queue-full"
    | "gone";
}

/**
 * 这个目标现在该不该被唤醒；该的话往队列里塞一条。
 *
 * 状态只问一次，问的是阶段 B 那个投影（`driveTarget`），不是自己再推一遍：
 * 「现在算不算空闲」这个问题在这个 core 里只有一个答案。
 */
export function wakeInbox(
  context: CollabContext,
  targetNodeId: string,
): WakeOutcome {
  const node = loadNode(context.database, targetNodeId);
  if (node === undefined || node.nodeType !== "terminal") {
    return { queued: false, reason: "gone" };
  }
  const mode = inboxWakeOf(node.data);
  if (mode === "off") return { queued: false, reason: "off" };

  // 只在真的空闲时才唤醒。忙的时候塞一条进去也不算错（它会排队），但那条排队
  // 项会在整整一轮里占着队伍的一个位子，而它带的信息是「有未读」——那件事在
  // 目标空下来的那一刻再问一次就行。
  const drive = context.terminals?.driveTarget;
  if (drive === undefined || drive(targetNodeId).state !== "idle") {
    return { queued: false, reason: "not-idle" };
  }

  const now = nowSeconds(context);
  const digest = unreadDigest(context, targetNodeId, now);
  if (digest === undefined) {
    // 这一批读完了，记号也跟着清掉：下一批来的时候还要提示。
    notified.delete(targetNodeId);
    return { queued: false, reason: "no-unread" };
  }
  if (notified.get(targetNodeId) === digest.latestSequence) {
    return { queued: false, reason: "already-notified" };
  }

  const inserted = enqueue(context.database, {
    id: uuidV7(),
    workspaceId: node.workspaceId,
    sourceNodeId: targetNodeId,
    targetNodeId,
    origin: "mailbox-wake",
    // 幂等键让「同一批只提示一次」在五分钟的窗口内也活过一次重启：同一批未读
    // 的 `latestSequence` 不变，同一个 key 的重发答的是原来那一行。
    messageKey: `wake:${digest.latestSequence}`,
    body: mode === "deliver" ? deliverBody(digest) : notifyBody(digest),
    hops: 0,
    // 唤醒不接在任何一条来源链后面：它不是从别处转过来的一条指令，链空的话下
    // 一跳的跳数也就从头数起。
    trail: [],
    now,
    state: "queued",
  });
  if (inserted.kind === "full") return { queued: false, reason: "queue-full" };
  notified.set(targetNodeId, digest.latestSequence);
  return { queued: true };
}

function notifyBody(digest: UnreadDigest): string {
  return (
    `收件箱有 ${digest.count} 条新消息，运行 \`armadra-hook canvas inbox\` 查看。` +
    `最早一条来自 ${digest.earliestFrom}。`
  );
}

/**
 * `deliver` 档投的是最早那条未读的正文本身。
 *
 * 正文前面加一行来源，因为信封的 `from:` 写的是应用（唤醒不是一次 Agent 之间
 * 的对话），而「这段话是谁说的」是读它的人第一个要问的。读了**不**等于确认：
 * 这一条投出去之后收件箱那条消息一个字节没动，仍然等着目标自己 `ack`。
 */
function deliverBody(digest: UnreadDigest): string {
  const more =
    digest.count > 1
      ? `\n（收件箱里还有 ${digest.count - 1} 条，\`armadra-hook canvas inbox\` 可以读；读完记得 \`canvas ack --id\`。）`
      : "\n（读了不等于确认，处理完用 `armadra-hook canvas ack --id` 标记。）";
  return `来自 ${digest.earliestFrom} 的未读画布消息：\n${digest.earliestBody}${more}`;
}

export type { UnreadDigest };
