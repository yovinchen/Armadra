import { expectedProcesses, paneRunsAgent } from "../../agent/launch";
import { baseAgent, hasCapability } from "../../agent/registry";
import {
  OBSERVED_QUIET,
  type TargetState,
  observedQuiet,
  stateSourceIsReported,
} from "../../agent/target-state";
import { getContextLinks } from "../../canvas/context-links";
import {
  LEASE_GENERATION,
  LEASE_HELD_BY_AGENT,
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
  agentActor,
} from "../../drive/lease";
import { audit } from "../../identity/audit";
import { allows } from "../../identity/gate";
import { scope } from "../../identity/scopes";
import { uuidV7 } from "../../workspaces/support";
import { AddressError, handleOf, loadHandles, resolveLink } from "../addressing";
import { recordDelivery } from "../deliveries";
import { MAX_BODY_CHARS } from "../mailbox";
import {
  type Caller,
  type NodeRef,
  type SessionRef,
  loadNode,
  loadSession,
  workspaceRoot,
} from "../nodes";
import {
  type Args,
  Refused,
  collapseNewlines,
  nonce,
  stripControl,
} from "../refusals";
import { MAX_HOPS, sendLimits } from "../send-limits";
import {
  type QueueItem,
  SEND_QUEUE_TTL_SECONDS,
  claim,
  enqueue,
  positionOf,
  requeue,
  settle,
} from "../send-queue";
import { type CollabContext, nowDate, nowSeconds } from "../service";
import { type Outcome, raw } from "./outcome";

/**
 * `send` —— 把一段正文写进已连线目标的终端**并回车**（设计
 * `agent-delivery.md` §3、§4.5、§7）。
 *
 * `post` 不被它取代：`post` 是一张表，目标自己来读；`send` 是一次真正的按键。
 * 一个停在空闲提示符上的 CLI 永远不会主动去读信箱（§1.3），所以「请你现在做
 * 这件事」需要一条推式通道，而这是它。
 *
 * 门链的顺序不是随手排的，它从「便宜且与此刻无关」走到「贵且只在此刻成立」：
 *
 *   1. **连线**——授权本身。源→目标有边就编译出 `terminal:drive`，没边只能
 *      `post`（D2、§3.2）。
 *   2. **同工作空间、能力位、scope**——三条都是「你有没有资格」。scope 今天
 *      本机恒真，判定入口现在就放上去（§3.2 第 5 条）。
 *   3. **正文**——长度、控制字符、幂等键。都是调用者自己的错，越早说越好。
 *   4. **速率 / 扇出 / 环 / 跳数**——失控闸。放在状态闸之前，因为一个环里的
 *      消息不该因为目标恰好空闲就被放行。
 *   5. **会话、前台进程**——目标有没有在跑它声称的那个 Agent。
 *   6. **五态**——`idle` 直接投，`busy` / `starting` 排队，`awaiting-approval`
 *      排队但永不写入，`exited` 拒绝。
 *   7. **租约**——人在打字就不是 Agent 的回合（§6.1）。
 *
 * 第 1、2、5、6、7 条在出队时**重跑一遍**（§4.5 最后一行）：一条排了两分钟的
 * 指令，投出去时世界早就不是它入队时的样子了。所以那五条写在
 * {@link attempt} 里，而不是写在 {@link send} 里。
 *
 * 一条硬规矩贯穿全文，与 `schedule/dispatch.ts` 同源：
 * **`awaiting-approval` 的节点在任何参数组合下都不会被写入正文。**
 */

export const DELIVERY_PROTOCOL = "armadra.delivery.v1";

/** 发一个 `ESC` 之后，最多等这么久等一条 `idle`（§4.5）。 */
export const INTERRUPT_SETTLE_MS = 5_000;

/** 等的时候每隔这么久看一眼。 */
export const INTERRUPT_POLL_MS = 200;

/**
 * 打断用的那个键。
 *
 * 与 `interrupt.ts` 里的是同一个常数、同一个理由：它是常数。这个动词带正文，
 * 但正文走括号粘贴那条路，`ESC` 这条路上永远只有这一个字节。
 */
const ESCAPE = "\u001b";

/* --------------------------------- 错误码 --------------------------------- */

/**
 * 稳定错误码（§3.5）。大写、机器读、原样显示不翻译；`LEASE_*` 四个与浏览器域
 * **同名同义**，从 `core/drive/lease.ts` 导入而不是在这里再写一遍——同一件事
 * 在两个域有两个名字，模型就得学两遍。
 */
export const SEND_CODES = {
  NOT_LINKED: 403,
  TARGET_NOT_TERMINAL: 400,
  TARGET_GONE: 404,
  TARGET_NOT_AGENT_PANE: 409,
  TARGET_STARTING: 409,
  TARGET_BUSY: 409,
  TARGET_AWAITING_APPROVAL: 409,
  TARGET_STATE_UNVERIFIED: 409,
  [LEASE_HELD_BY_HUMAN]: 409,
  [LEASE_REVOKED]: 409,
  [LEASE_HELD_BY_AGENT]: 409,
  [LEASE_GENERATION]: 409,
  RATE_LIMITED: 429,
  QUEUE_FULL: 429,
  LOOP_DETECTED: 409,
  BODY_TOO_LONG: 400,
  KEY_CONFLICT: 409,
  DRIVE_DENIED: 403,
} as const satisfies Record<string, number>;

export type SendCode = keyof typeof SEND_CODES;

/** 这个码值不值得再来一次。回执里的 `retryable` 就是它。 */
function isRetryable(code: SendCode): boolean {
  return code === "RATE_LIMITED" || code === "QUEUE_FULL";
}

function refuse(
  code: SendCode,
  message: string,
  detail: Record<string, unknown> = {},
): Refused {
  return new Refused(SEND_CODES[code], code, message, {
    retryable: isRetryable(code),
    ...detail,
  });
}

/* ------------------------------- 排队的理由 ------------------------------- */

/**
 * 「现在投不进去，但等一等有意义」的那几个码。
 *
 * 默认排队、`--no-queue` 拒绝，两条路用的是同一个判断——否则「忙」在两个参数
 * 下会变成两件事。
 */
type QueueReason =
  | "TARGET_BUSY"
  | "TARGET_STARTING"
  | "TARGET_AWAITING_APPROVAL"
  | typeof LEASE_HELD_BY_HUMAN
  | typeof LEASE_HELD_BY_AGENT;

const QUEUE_MESSAGES: Record<QueueReason, string> = {
  TARGET_BUSY: "目标正在一轮里。",
  TARGET_STARTING: "目标刚起来，还没有报过第一条状态。",
  TARGET_AWAITING_APPROVAL:
    "目标停在一个权限提示或提问上；写进去就是替人回答了那个问题。",
  [LEASE_HELD_BY_HUMAN]: "有人正在这个终端里打字。",
  [LEASE_HELD_BY_AGENT]: "另一个 Agent 正在驱动它。",
};

const QUEUE_STATE: Record<QueueReason, TargetState> = {
  TARGET_BUSY: "busy",
  TARGET_STARTING: "starting",
  TARGET_AWAITING_APPROVAL: "awaiting-approval",
  [LEASE_HELD_BY_HUMAN]: "idle",
  [LEASE_HELD_BY_AGENT]: "idle",
};

/* ------------------------------ 目标的此刻 ------------------------------- */

interface LiveTarget {
  readonly target: NodeRef;
  readonly session: SessionRef;
  readonly state: TargetState;
  readonly stateSource?: string | undefined;
  readonly leaseState: string;
  readonly leaseHolderId: string;
}

/* ---------------------------------- send ---------------------------------- */

export async function send(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const nowMs = nowDate(context).getTime();
  const now = nowSeconds(context);
  const limits = sendLimits();

  const target = resolveTarget(context, caller, args);
  const body = readBody(args);
  const key = readKey(args);

  /* --- 失控闸（§7）。放在状态闸之前：环里的消息不因为目标空闲就被放行。 --- */
  const trail = limits.trailFor(caller.node.id, nowMs);
  if (trail.includes(target.id)) {
    throw refuse(
      "LOOP_DETECTED",
      `「${target.title}」已经在这条消息的来源链里（${renderTrail(context, trail)}），这是一个环，已停下。`,
      { trail: [...trail] },
    );
  }
  if (trail.length > MAX_HOPS) {
    throw refuse(
      "LOOP_DETECTED",
      `这条消息已经转了 ${trail.length} 跳，超过上限 ${MAX_HOPS}，已停下。`,
      { hops: trail.length },
    );
  }
  const rate = limits.rate(caller.node.id, target.id, nowMs);
  if (!rate.allowed) {
    throw refuse(
      "RATE_LIMITED",
      `向「${target.title}」的投递太密集，${Math.ceil(rate.retryAfterMs / 1000)} 秒后再来。`,
      { retryAfterMs: rate.retryAfterMs },
    );
  }
  if (!limits.fanout(caller.node.id, target.id)) {
    throw refuse(
      "RATE_LIMITED",
      "这一轮已经投给了四个不同的目标，等下一轮再继续。",
      { retryAfterMs: 0 },
    );
  }

  const options: AttemptOptions = {
    queue: !args.flag("no-queue"),
    interrupt: args.flag("interrupt"),
    unverified: args.flag("unverified"),
  };

  if (args.flag("dry-run")) {
    const live = await peek(context, target);
    return receipt({
      ok: true,
      protocol: DELIVERY_PROTOCOL,
      outcome: "dry-run",
      dryRun: true,
      id: target.id,
      title: target.title,
      targetState: live?.state ?? "exited",
      bodyChars: [...body].length,
      hops: trail.length,
      message: `（演练）会向「${target.title}」投递 ${[...body].length} 个字符。`,
    });
  }

  /* --- 幂等与入队。两种结果都在表里留一行，`--key` 才对两种都成立。 --- */
  const inserted = enqueue(context.database, {
    id: uuidV7(),
    workspaceId: caller.node.workspaceId,
    sourceNodeId: caller.node.id,
    targetNodeId: target.id,
    origin: "send",
    messageKey: key,
    body,
    hops: trail.length,
    trail,
    now,
    state: "queued",
  });
  if (inserted.kind === "full") {
    throw refuse(
      "QUEUE_FULL",
      `「${target.title}」的待投队列已经满了，改用 canvas post 留一条收件箱消息。`,
    );
  }
  if (inserted.kind === "conflict") {
    throw refuse(
      "KEY_CONFLICT",
      `幂等键 \`${key}\` 已经指向另一段正文，换一个 key。`,
    );
  }
  if (inserted.kind === "duplicate") {
    return receipt(duplicateBody(context, inserted.item, now));
  }
  return attempt(context, inserted.item, options);
}

/* ------------------------------ 一次投递尝试 ------------------------------ */

export interface AttemptOptions {
  /** 投不进去时排队（默认），还是当场拒绝（`--no-queue`）。 */
  readonly queue: boolean;
  readonly interrupt?: boolean;
  readonly unverified?: boolean;
  /**
   * 排队 / 投递 / 拒绝要不要发 `agent.delivery` 事件。默认发；出队时也发，只是
   * 那一次没有人在等那个回执。
   */
  readonly announce?: boolean;
}

/**
 * 一条队列项在此刻能不能投出去。
 *
 * 出队跑的就是这个函数，所以「出队重跑整条门链」不是一句承诺，是同一段代码
 * （契约 §5.7 第 9 条）。它**不重跑**失控闸里的环与跳数：那两条是消息自己的
 * 属性，入队时是什么，出队时还是什么。
 */
export async function attempt(
  context: CollabContext,
  item: QueueItem,
  options: AttemptOptions,
): Promise<Outcome> {
  const now = nowSeconds(context);
  const nowMs = nowDate(context).getTime();

  let live: LiveTarget;
  try {
    live = await gate(context, item);
  } catch (error) {
    // 门链上的硬拒绝：这一条再等也不会变好，从队列里拿掉。
    settle(context.database, item.id, "cancelled", codeOf(error));
    throw error;
  }
  const target = live.target;
  let state = live.state;
  let targetStateLabel: string = state;

  // 没有状态适配的通道（§4.3）。默认拒绝而不是默认放行：这种节点上「在等人」
  // 这个事实根本不存在，放行就没法保证不替人回答权限提示。
  if (!stateSourceIsReported(live.stateSource)) {
    if (options.unverified !== true) {
      settle(context.database, item.id, "cancelled", "TARGET_STATE_UNVERIFIED");
      throw refuse(
        "TARGET_STATE_UNVERIFIED",
        `「${target.title}」没有装状态适配，只有 PTY 观测；改用 canvas post，或显式加 --unverified 自负其责。`,
      );
    }
    const activity = context.terminals?.observed?.(live.session.sessionId);
    if (activity === undefined || !observedQuiet(activity, nowMs)) {
      return queueOrRefuse(context, item, target, "TARGET_BUSY", options, now);
    }
    state = "idle";
    targetStateLabel = OBSERVED_QUIET;
  }

  // `--interrupt`：只对真的在一轮里的目标有意义。空闲提示符上的 `ESC` 是空
  // 操作，而权限提示上的 `ESC` 的意思是「拒绝这次工具调用」——那是替人做决定。
  if (options.interrupt === true && state === "awaiting-approval") {
    settle(context.database, item.id, "cancelled", "TARGET_AWAITING_APPROVAL");
    throw refuse(
      "TARGET_AWAITING_APPROVAL",
      `「${target.title}」停在一个权限提示上，Escape 在那里的意思是「拒绝这次工具调用」，已拒绝。`,
    );
  }
  if (options.interrupt === true && state === "busy") {
    state = await interruptAndSettle(context, item.targetNodeId, live.session);
    targetStateLabel = state;
  }

  if (state !== "idle") {
    const reason: QueueReason =
      state === "busy"
        ? "TARGET_BUSY"
        : state === "starting"
          ? "TARGET_STARTING"
          : "TARGET_AWAITING_APPROVAL";
    return queueOrRefuse(context, item, target, reason, options, now);
  }

  // 租约（§6）。人在打字就不是 Agent 的回合；接管更是明说了不自动恢复。
  if (live.leaseState === "humanTakeover") {
    settle(context.database, item.id, "cancelled", LEASE_REVOKED);
    throw refuse(
      LEASE_REVOKED,
      `有人接管了「${target.title}」的终端，Agent 的驱动权要等对方交还；读 canvas outbox 并告诉用户。`,
    );
  }
  if (live.leaseState === "human") {
    return queueOrRefuse(
      context,
      item,
      target,
      LEASE_HELD_BY_HUMAN,
      options,
      now,
    );
  }
  if (
    live.leaseState === "agent" &&
    live.leaseHolderId !== "" &&
    live.leaseHolderId !== item.sourceNodeId
  ) {
    return queueOrRefuse(
      context,
      item,
      target,
      LEASE_HELD_BY_AGENT,
      options,
      now,
    );
  }

  /* ------------------------------- 真的投 ------------------------------- */

  // 串行门：同一目标同时只有一条在投。这一步与状态判断分开，因为它问的不是
  // 「目标忙不忙」而是「我们自己有没有已经在往里写」。
  const claimed = claim(context.database, item.id, item.targetNodeId, now);
  if (claimed === undefined) {
    return queueOrRefuse(context, item, target, "TARGET_BUSY", options, now);
  }

  const submit = context.terminals?.writeSubmit;
  if (submit === undefined) {
    requeue(context.database, item.id, "TARGET_GONE");
    throw new Refused(503, "internal_error", "终端域还没有装配好，无法投递。");
  }
  const source = loadNode(context.database, item.sourceNodeId);
  const sourceName = displayName(source, item.sourceNodeId);
  const envelope = buildEnvelope({
    sourceNodeId: item.sourceNodeId,
    sourceName,
    trail: renderTrail(context, item.trail),
    body: item.body,
  });
  const traceId = nonce(16);
  try {
    await submit(
      live.session.sessionId,
      live.session.generation,
      envelope,
      agentActor(item.sourceNodeId, live.session.sessionId, sourceName),
    );
  } catch (error) {
    // 写到一半失败：不知道对面收到了多少。它**不是**可以重试的那种失败，所以
    // 这一条不回队列（`schedule/dispatch.ts:200-208` 的同一条规矩）。
    settle(context.database, item.id, "done", "WRITE_FAILED");
    const message = error instanceof Error ? error.message : String(error);
    const traced = trace(context, item, "unknown", traceId, "write-failed");
    recordAndAnnounce(context, item, traceId, "unknown", options);
    return receipt({
      ok: true,
      protocol: DELIVERY_PROTOCOL,
      outcome: "unknown",
      id: item.id,
      traceId,
      traced,
      retryable: false,
      targetState: targetStateLabel,
      message: `向「${target.title}」的投递写到一半失败了，不知道对面收到了多少，不要重试：${message}`,
    });
  }

  settle(context.database, item.id, "done", "DELIVERED");
  const limits = sendLimits();
  limits.noteDelivered(item.sourceNodeId, item.targetNodeId, nowMs);
  // 下一跳的来源链从这里接上：目标再往外投时，链里已经有它的上游。
  limits.noteTrail(item.targetNodeId, item.trail, nowMs);
  audit({
    action: "agent.send",
    target: item.targetNodeId,
    workspaceId: item.workspaceId,
    detail: {
      source: item.sourceNodeId,
      hops: item.hops,
      bodyChars: [...item.body].length,
      queueId: item.id,
    },
  });
  const traced = trace(context, item, "delivered", traceId, "written");
  recordAndAnnounce(context, item, traceId, "delivered", options);
  return receipt({
    ok: true,
    protocol: DELIVERY_PROTOCOL,
    outcome: "delivered",
    id: item.id,
    traceId,
    traced,
    targetState: targetStateLabel,
    bodyChars: [...item.body].length,
    hops: item.hops,
    message: `已投进「${target.title}」并回车。送到不是做完——要知道结果就读对方的转录，或者等对方 post 回来。`,
  });
}

/* ------------------------------- 排队或拒绝 ------------------------------- */

function queueOrRefuse(
  context: CollabContext,
  item: QueueItem,
  target: NodeRef,
  reason: QueueReason,
  options: AttemptOptions,
  now: number,
): Outcome {
  if (!options.queue) {
    settle(context.database, item.id, "cancelled", reason);
    throw refuse(
      reason,
      `${QUEUE_MESSAGES[reason]}没有排队，因为你给了 --no-queue。`,
    );
  }
  requeue(context.database, item.id, reason);
  const position = positionOf(
    context.database,
    { ...item, state: "queued", lastReason: reason },
    now,
  );
  const traceId = nonce(16);
  trace(context, item, "queued", traceId, reason);
  recordAndAnnounce(context, item, traceId, "queued", options);
  return receipt({
    ok: true,
    protocol: DELIVERY_PROTOCOL,
    outcome: "queued",
    id: item.id,
    queuePosition: position,
    expiresAt: item.expiresAt,
    reason,
    targetState: QUEUE_STATE[reason],
    message: `${QUEUE_MESSAGES[reason]}已排进「${target.title}」的队伍，第 ${position} 位；它下一次空闲时自动投进去，${SEND_QUEUE_TTL_SECONDS / 60} 分钟后过期。`,
  });
}

/* --------------------------------- 门链 ---------------------------------- */

/**
 * `--to` → 一个已连线、同工作空间、能力位开着、我有 `terminal:drive` 的终端
 * 节点。§3.2 判定链的第 2–5 条。
 */
export function resolveTarget(
  context: CollabContext,
  caller: Caller,
  args: Args,
): NodeRef {
  const wanted = args.text("to") ?? args.text("node");
  if (wanted === undefined) {
    throw new Refused(
      400,
      "bad_request",
      "send 需要 --to <已连线节点的 id、名字或标题>。",
    );
  }
  const links = getContextLinks(context.database, caller.node.id).links;
  const handles = loadHandles(context.database, links);
  let link;
  try {
    link = resolveLink(links, handles, wanted);
  } catch (error) {
    if (error instanceof AddressError) {
      throw refuse(
        "NOT_LINKED",
        `${error.refusal("--to").message}先在画布上连一条线，或者用 canvas post 留一条收件箱消息。`,
      );
    }
    throw error;
  }
  const target = loadNode(context.database, link.id);
  if (target === undefined) {
    throw refuse("NOT_LINKED", "这个链接指向的节点已经不在画布上了。");
  }
  if (target.id === caller.node.id) {
    throw new Refused(400, "bad_request", "不能给你自己投递。");
  }
  authorize(context, caller.node, target);
  return target;
}

/**
 * 「我有没有资格驱动它」——与目标此刻在做什么无关的那几条。
 *
 * 出队时重跑的就是它：连线可以在这两分钟里被删掉，能力位可以被关掉，节点可以
 * 被搬去另一个工作空间。
 */
function authorize(
  context: CollabContext,
  source: NodeRef,
  target: NodeRef,
): void {
  const linked = getContextLinks(context.database, source.id).links.some(
    (link) => link.id === target.id,
  );
  if (!linked) {
    throw refuse(
      "NOT_LINKED",
      `「${target.title}」不在这个节点的链接列表里；先在画布上连一条线，或者用 canvas post 留一条收件箱消息。`,
    );
  }
  if (target.workspaceId !== source.workspaceId) {
    throw refuse("NOT_LINKED", "这个链接指向的节点不在当前工作空间，已拒绝。");
  }
  if (target.nodeType !== "terminal") {
    throw refuse(
      "TARGET_NOT_TERMINAL",
      `「${target.title}」不是终端节点，没有可以投进去的地方。`,
    );
  }
  // 能力位：双方的 `contextLink` 都得开着。自定义 Agent 可以关掉它，而关掉的
  // 意思是「别人读不到我，也别往我这儿写」。
  if (
    source.agentId !== null &&
    !hasCapability(context.settings, source.agentId, "contextLink")
  ) {
    throw refuse("DRIVE_DENIED", "这个 Agent 的节点连线能力被关掉了。");
  }
  if (
    target.agentId !== null &&
    !hasCapability(context.settings, target.agentId, "contextLink")
  ) {
    throw refuse("DRIVE_DENIED", `「${target.title}」的节点连线能力被关掉了。`);
  }
  // scope。今天本机只有 owner，判定恒真；入口现在就放上去，理由与
  // `server-accounts-and-sharing.md` §4.4 相同——等到有第二个 principal 再找
  // 一遍，找漏一条就是一个人替另一个人点了「允许」。
  if (!allows([scope("terminal:drive", target.workspaceId)])) {
    throw refuse(
      "DRIVE_DENIED",
      "驱动这个工作空间的终端需要 terminal:drive 授权。",
    );
  }
}

/** 会话、前台进程门与五态快照。授权在前，因为它更便宜也更稳定。 */
async function gate(
  context: CollabContext,
  item: QueueItem,
): Promise<LiveTarget> {
  const target = loadNode(context.database, item.targetNodeId);
  const source = loadNode(context.database, item.sourceNodeId);
  if (target === undefined) {
    throw refuse("TARGET_GONE", "目标节点已经不在画布上了。");
  }
  if (source === undefined) {
    throw refuse("NOT_LINKED", "发起这条投递的节点已经不在画布上了。");
  }
  authorize(context, source, target);
  return observe(context, target);
}

/** 目标此刻的会话、前台与五态。 */
async function observe(
  context: CollabContext,
  target: NodeRef,
): Promise<LiveTarget> {
  const session = loadSession(context.database, target.id);
  const drive = context.terminals?.driveTarget;
  if (drive === undefined) {
    throw new Refused(503, "internal_error", "终端域还没有装配好，无法投递。");
  }
  const answer = drive(target.id);
  if (
    session === undefined ||
    session.status !== "running" ||
    answer.state === "exited"
  ) {
    throw refuse(
      "TARGET_GONE",
      `「${target.title}」没有在运行的终端会话；改用 canvas post，节点起来之后会有人读。`,
    );
  }
  // 前台进程门（§3.2 第 6 条）：前台仍得是它声称的那个 Agent，否则这段正文会
  // 落进用户自己在那个 pane 里开的东西。
  if (target.agentId !== null) {
    const expected = expectedProcesses(
      baseAgent(context.settings, target.agentId),
    );
    const foreground = await context.terminals
      ?.foreground(session.sessionId)
      .catch(() => undefined);
    if (foreground === undefined || !paneRunsAgent(foreground, expected)) {
      throw refuse(
        "TARGET_NOT_AGENT_PANE",
        `「${target.title}」的终端当前没有在跑 ${target.agentId}，没有投递。`,
      );
    }
  }
  return {
    target,
    session,
    state: answer.state,
    stateSource: answer.stateSource,
    leaseState: answer.lease.state,
    leaseHolderId: answer.lease.holder?.id ?? "",
  };
}

/** 演练用：门链跑不过就当作「看不见」，不抛。 */
async function peek(
  context: CollabContext,
  target: NodeRef,
): Promise<LiveTarget | undefined> {
  try {
    return await observe(context, target);
  } catch {
    return undefined;
  }
}

/* --------------------------------- 正文 ---------------------------------- */

function readBody(args: Args): string {
  const rawBody = args.text("body");
  if (rawBody === undefined) {
    throw new Refused(400, "bad_request", "send 需要 --body <正文>。");
  }
  const body = stripControl(rawBody);
  if (body.trim() === "") {
    throw new Refused(400, "bad_request", "正文是空的。");
  }
  if ([...body].length > MAX_BODY_CHARS) {
    throw refuse(
      "BODY_TOO_LONG",
      `正文超过 ${MAX_BODY_CHARS} 个字符；把大产物写进文件，发路径。`,
    );
  }
  return body;
}

function readKey(args: Args): string | undefined {
  const key = args.text("key");
  if (key === undefined) return undefined;
  if (key.length > 128 || !/^[A-Za-z0-9\-_.:]+$/.test(key)) {
    throw new Refused(
      400,
      "bad_request",
      "幂等键只能是 1–128 个 ASCII 字母、数字、-、_、. 或 :。",
    );
  }
  return key;
}

/**
 * 写进 PTY 的那段字节的**正文部分**（§3.6）。括号粘贴的包裹与 `\r` 由终端域的
 * `writeSubmit` 加上，因为那三样必须是同一次写。
 *
 * nonce 每次铸造、不给发起者；头字段折叠换行，否则发起者可以用一个换行伪造出
 * 一行假的帧边界。
 */
export function buildEnvelope(options: {
  readonly sourceNodeId: string;
  readonly sourceName: string;
  readonly trail: string;
  readonly body: string;
}): string {
  const frame = nonce(12);
  const from = collapseNewlines(
    `${options.sourceName} (${options.sourceNodeId})`,
  );
  return [
    `--- ARMADRA MESSAGE ${frame} ---`,
    `from: ${from}   via: ${collapseNewlines(options.trail)}`,
    options.body,
    `--- END ARMADRA MESSAGE ${frame} ---`,
  ].join("\n");
}

/** 署名用名字，没有名字才退回标题（§2.4）。 */
export function displayName(
  node: NodeRef | undefined,
  fallback: string,
): string {
  if (node === undefined) return fallback;
  return handleOf(node.data) ?? node.title ?? fallback;
}

/**
 * `via:` 行。链里最早的一跳在前，所以人看到
 * `via: planner → reviewer → codex-1` 就知道这条指令是从哪里来的。
 */
function renderTrail(
  context: CollabContext,
  trail: readonly string[],
): string {
  return [...trail]
    .reverse()
    .map((id) => displayName(loadNode(context.database, id), id))
    .join(" → ");
}

/* ------------------------------- 打断并等待 ------------------------------- */

/**
 * 发一个 `ESC`，然后等一条 `idle`。等不到就把当前状态原样答回去，由调用方退回
 * 排队（§4.5 的 `--interrupt` 那一列）。
 */
async function interruptAndSettle(
  context: CollabContext,
  nodeId: string,
  session: SessionRef,
): Promise<TargetState> {
  const bridge = context.terminals;
  const drive = bridge?.driveTarget;
  if (bridge === undefined || drive === undefined) return "busy";
  try {
    await bridge.write(session.sessionId, session.generation, ESCAPE);
  } catch {
    return "busy";
  }
  const wait = context.delay ?? defaultDelay;
  const started = nowDate(context).getTime();
  let state: TargetState = "busy";
  for (let waited = 0; waited < INTERRUPT_SETTLE_MS; waited += INTERRUPT_POLL_MS) {
    await wait(INTERRUPT_POLL_MS);
    state = drive(nodeId).state;
    if (state !== "busy") return state;
    // 注入的 `delay` 可以是空操作，那就靠这把注入的钟收尾。
    if (nowDate(context).getTime() - started >= INTERRUPT_SETTLE_MS) break;
  }
  return state;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* --------------------------------- 记账 ---------------------------------- */

function trace(
  context: CollabContext,
  item: QueueItem,
  outcome: string,
  traceId: string,
  receiptText: string,
): string {
  return context.boardLog.record(
    workspaceRoot(context.database, item.workspaceId),
    {
      traceId,
      source: item.sourceNodeId,
      target: item.targetNodeId,
      outcome,
      receipt: receiptText,
      bodyChars: [...item.body].length,
    },
  );
}

/**
 * `agent_deliveries` 的一行 + 一帧 `agent.delivery`。
 *
 * 那张表（迁移 0006）从合并之后就没有写者了；`send` 让它重新有一个，所以投递
 * 记录面板不再是一段只会变短的历史（§3.4 最后一段）。正文不进表，只进字符数。
 */
function recordAndAnnounce(
  context: CollabContext,
  item: QueueItem,
  traceId: string,
  outcome: string,
  options: AttemptOptions,
): void {
  recordDelivery(context.database, {
    traceId,
    workspaceId: item.workspaceId,
    sourceNodeId: item.sourceNodeId,
    targetNodeId: item.targetNodeId,
    outcome,
    receipt: item.id,
    bodyChars: [...item.body].length,
  });
  if (options.announce === false) return;
  context.publish(item.workspaceId, {
    type: "agent.delivery",
    traceId,
    sourceNodeId: item.sourceNodeId,
    targetNodeId: item.targetNodeId,
    outcome,
  });
}

function duplicateBody(
  context: CollabContext,
  item: QueueItem,
  now: number,
): Record<string, unknown> {
  const queued = item.state === "queued" || item.state === "delivering";
  return {
    ok: true,
    protocol: DELIVERY_PROTOCOL,
    outcome: queued ? "queued" : "delivered",
    id: item.id,
    duplicate: true,
    ...(queued
      ? { queuePosition: positionOf(context.database, item, now) }
      : {}),
    expiresAt: item.expiresAt,
    message: `这个 key 的同一段正文已经处理过了（${item.id}），没有再投一次。`,
  };
}

function receipt(body: Record<string, unknown>): Outcome {
  return raw(body, String(body.message ?? "send"));
}

function codeOf(error: unknown): string {
  return error instanceof Refused ? error.code : "internal_error";
}
