import { expectedProcesses, paneRunsAgent } from "../../agent/launch";
import {
  baseAgent,
  hasCapability,
  startsSilently,
  stateSourceFor,
} from "../../agent/registry";
import {
  OBSERVED_QUIET,
  type TargetState,
  observedQuiet,
  sessionStartIdle,
  silentStartIdle,
  stateSourceIsReported,
} from "../../agent/target-state";
import { getAgentStatus } from "../../agent/status";
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
import {
  AddressError,
  handleOf,
  loadHandles,
  resolveLink,
} from "../addressing";
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
  findByKey,
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

/**
 * 收件箱唤醒的信封署名与来源链（§5）。
 *
 * 它不是一次 Agent 之间的对话：没有第二个节点在发话，所以 `from:` 写应用自己，
 * 而不是把目标自己的名字写上去冒充一次对话。
 */
export const WAKE_SENDER = "Armadra 收件箱";
const WAKE_VIA = "收件箱";

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
  TARGET_INPUT_PENDING: 409,
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
  /**
   * 从想把文字打进主的终端（迁移 0024 的边角色）。
   *
   * 不是权限缺失，是方向不对：一条 `supervises` 边说的就是「谁给谁派活」。下
   * 级要说话仍然有 `post`——留言不打断人，而打断上级正在做的事是它该请求而不
   * 是该执行的。主可以在自己的节点设置里显式打开这条路。
   */
  UPWARD_SEND_REFUSED: 403,
} as const satisfies Record<string, number>;

export type SendCode = keyof typeof SEND_CODES;

/** 这个码值不值得再来一次。回执里的 `retryable` 就是它。 */
function isRetryable(code: SendCode): boolean {
  return code === "RATE_LIMITED" || code === "QUEUE_FULL";
}

export function refuse(
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
  | "TARGET_INPUT_PENDING"
  | typeof LEASE_HELD_BY_HUMAN
  | typeof LEASE_HELD_BY_AGENT;

const QUEUE_MESSAGES: Record<QueueReason, string> = {
  TARGET_BUSY: "目标正在一轮里。",
  TARGET_STARTING: "目标刚起来，还没有报过第一条状态。",
  TARGET_AWAITING_APPROVAL:
    "目标停在一个权限提示或提问上；写进去就是替人回答了那个问题。",
  TARGET_INPUT_PENDING:
    "目标的输入行上有半截没提交的字；投进去就会接在那半行后面。",
  [LEASE_HELD_BY_HUMAN]: "有人正在这个终端里打字。",
  [LEASE_HELD_BY_AGENT]: "另一个 Agent 正在驱动它。",
};

const QUEUE_STATE: Record<QueueReason, TargetState> = {
  TARGET_BUSY: "busy",
  TARGET_STARTING: "starting",
  TARGET_AWAITING_APPROVAL: "awaiting-approval",
  TARGET_INPUT_PENDING: "idle",
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

/**
 * 被拦下的那一次也要发一帧 `agent.delivery`（设计 §10 的顶部通知条）。
 *
 * 在这之前只有 `delivered` / `queued` / `unknown` 上过事件流，于是「两个 Agent
 * 在互相喂」这件事只有发起者的回执里看得见——而那正是**没有人在看**的地方：
 * 一个环里的两个模型各自读到一句「这是一个环」，画布前面的人什么都看不到。
 *
 * 帧里只有码，没有那句话：页面按码取自己的文案（`status §20.4`），core 的中文
 * 句子不该出现在英文界面上。
 */
function announceRefusal(
  context: CollabContext,
  sourceNodeId: string,
  workspaceId: string,
  targetNodeId: string,
  error: unknown,
): void {
  const code = codeOf(error);
  if (code === undefined || code === "") return;
  context.publish(workspaceId, {
    type: "agent.delivery",
    traceId: nonce(16),
    sourceNodeId,
    targetNodeId,
    outcome: "refused",
    code,
  });
}

export async function send(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const target = resolveTarget(context, caller, args);
  try {
    return await sendTo(context, caller, args, target);
  } catch (error) {
    announceRefusal(
      context,
      caller.node.id,
      caller.node.workspaceId,
      target.id,
      error,
    );
    throw error;
  }
}

async function sendTo(
  context: CollabContext,
  caller: Caller,
  args: Args,
  target: NodeRef,
): Promise<Outcome> {
  const nowMs = nowDate(context).getTime();
  const now = nowSeconds(context);
  const limits = sendLimits();

  const body = readBody(args);
  const key = readKey(args);

  // 幂等先答（§3.3）。一次重发**不是**一次新的投递，所以它不该撞上速率闸：
  // 「同样的 key 和正文重发是安全的」这句话，一撞上 RATE_LIMITED 就不成立了。
  if (key !== undefined) {
    const already = findByKey(
      context.database,
      caller.node.id,
      target.id,
      key,
      now,
    );
    if (already !== undefined) {
      if (already.body !== body) {
        throw refuse(
          "KEY_CONFLICT",
          `幂等键 \`${key}\` 已经指向另一段正文，换一个 key。`,
        );
      }
      return receipt(duplicateBody(context, already, now));
    }
  }

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
  const outcome = await attempt(context, inserted.item, options);
  // 没投出去而是排上了：推一下泵。目标若是「启动不上报」的那一类，它的第一条
  // 空闲只能靠探（§4.3），而排队项自己不会再被任何事件想起。
  const reply = outcome.raw ?? outcome.result;
  if (
    reply !== null &&
    typeof reply === "object" &&
    (reply as { outcome?: unknown }).outcome === "queued"
  ) {
    context.nudge?.(target.id);
  }
  return outcome;
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
    // 休眠着或正在接回的目标（终端宿主设计 §7.2）：「没有会话」「前台还是
    // shell」都只是还没起来。排队等它，接回来之后唤醒方会推出队泵；别的拒绝
    // （没连线、没权限、节点没了）照旧。
    const code = codeOf(error);
    if (
      (code === "TARGET_GONE" || code === "TARGET_NOT_AGENT_PANE") &&
      context.terminals?.sleeping?.(item.targetNodeId) === true
    ) {
      const target = loadNode(context.database, item.targetNodeId);
      if (target !== undefined) {
        return queueOrRefuse(
          context,
          item,
          target,
          "TARGET_STARTING",
          options,
          now,
        );
      }
    }
    // 「还没起来」对带任务启动与收件箱唤醒不是拒绝，是「还早」：`open-agent`
    // 建完节点到页面挂起 PTY 之间有一段真空，而那一条排队项的全部意义就是等过
    // 这一段。没有人在等它的回执，所以它退回队列，由 TTL 决定它什么时候死。
    if (item.origin !== "send" && codeOf(error) === "TARGET_GONE") {
      requeue(context.database, item.id, "TARGET_GONE");
      throw error;
    }
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
    // 「还没报过第一条」与「这个 CLI 根本没有状态通道」是两件事，而它们在
    // `stateSource` 上长得一模一样：都是空的。分不开的代价是一条真实的失败——
    // `open-agent --task` 建的节点刚起 PTY 时还没有任何一行 `agent_status`，
    // 按「没有适配」处理就是把它的第一条任务当场取消掉，而三秒之后同一个节点
    // 会报出一条完好的 `hook` 状态。所以问的是**这个 provider 有没有状态通道**
    // （注册表的事实，与此刻无关），有就排队等第一条上报（§4.1 的 `starting`）。
    // 例外一条：注册表标了 `startsSilently` 的 CLI（今天只有 Codex）。它的第
    // 一条上报**按定义不会来**——实测 0.155.1 装了全部 hook 也不发
    // `session_start`，第一条事件要等人在里面提交一次输入。所以对这种节点
    // 「等第一条真上报」等的是一件不会发生的事，`open-agent --task` 的第一条
    // 任务会一直停在 `queued / TARGET_STARTING` 直到过期。放行判据全在
    // `silentStartIdle` 里（§4.3），这里只负责把三样事实取给它。
    if (silentStart(context, live, nowMs)) {
      state = "idle";
      targetStateLabel = OBSERVED_QUIET;
    } else if (hasStateChannel(context, target)) {
      return queueOrRefuse(
        context,
        item,
        target,
        "TARGET_STARTING",
        options,
        now,
      );
    } else if (options.unverified !== true) {
      settle(context.database, item.id, "cancelled", "TARGET_STATE_UNVERIFIED");
      throw refuse(
        "TARGET_STATE_UNVERIFIED",
        `「${target.title}」没有装状态适配，只有 PTY 观测；改用 canvas post，或显式加 --unverified 自负其责。`,
      );
    } else {
      const activity = context.terminals?.observed?.(live.session.sessionId);
      if (activity === undefined || !observedQuiet(activity, nowMs)) {
        return queueOrRefuse(
          context,
          item,
          target,
          "TARGET_BUSY",
          options,
          now,
        );
      }
      state = "idle";
      targetStateLabel = OBSERVED_QUIET;
    }
  }

  // 有状态通道、但只报过一条开场的目标（Claude 起来之后的样子）：那条开场把
  // 状态清成空，`targetState()` 答 `starting`，而下一条事件要等有人提交一次输
  // 入——与上面 Codex 那一例同一个死锁，判据在 `sessionStartIdle`。
  if (
    state === "starting" &&
    stateSourceIsReported(live.stateSource) &&
    sessionStart(context, live, nowMs)
  ) {
    state = "idle";
    targetStateLabel = state;
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

  // 人打了一半的输入（§4.3 第 3 条，推广到每一种目标）。租约只管「人此刻在不
  // 在打字」：停手十秒它就过期，而输入行上那半截字还在。有 hook 状态的目标报的
  // `idle` 说的是「这一轮结束了」，不是「输入行是空的」——这时候投进去，正文会
  // 接在人那半行后面一起提交。所以排队，等人自己提交或清掉那一行。
  // 判据是终端域的输入围栏（`terminal/input.ts` 的 `InputSafety`），终端对查询
  // 的应答不算人打的字，那条规矩在围栏里，这里不另判一遍。
  if (context.terminals?.observed?.(live.session.sessionId)?.pending === true) {
    return queueOrRefuse(
      context,
      item,
      target,
      "TARGET_INPUT_PENDING",
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
  // 收件箱唤醒没有第二个节点在发话：那一条是应用自己说的，署名就该是应用，而
  // 不是把目标自己的名字写在 `from:` 上冒充一次对话（§5、§2.4）。
  const wake = item.origin === "mailbox-wake";
  const sourceName = wake
    ? WAKE_SENDER
    : displayName(source, item.sourceNodeId);
  const envelope = buildEnvelope({
    sourceNodeId: item.sourceNodeId,
    sourceName,
    trail: wake ? WAKE_VIA : renderTrail(context, item.trail),
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
    recordAndAnnounce(
      context,
      item,
      traceId,
      "unknown",
      targetStateLabel,
      options,
    );
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
      targetState: targetStateLabel,
    },
  });
  const traced = trace(
    context,
    item,
    "delivered",
    traceId,
    // 追溯里也要看得出这一条是按观察放行的：一次 `observed-quiet` 的投递与一次
    // 有上报的投递事后只差这一个词。
    targetStateLabel === OBSERVED_QUIET
      ? `written ${OBSERVED_QUIET}`
      : "written",
  );
  recordAndAnnounce(
    context,
    item,
    traceId,
    "delivered",
    targetStateLabel,
    options,
  );
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
  // 同一个理由的重复等待不再记一次。一条排了两分钟的指令会被每一次
  // `agent.status` 试一遍，每次都记一行的话，投递记录面板与连线上的那一下闪动
  // 说的就不再是「发生了一件事」而是「泵跑了一圈」。
  const repeated = item.state === "queued" && item.lastReason === reason;
  if (!repeated) {
    trace(context, item, "queued", traceId, reason);
    recordAndAnnounce(
      context,
      item,
      traceId,
      "queued",
      QUEUE_STATE[reason],
      options,
    );
  }
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
  options: { readonly requireLink?: boolean } = {},
): void {
  // 收件箱唤醒是节点对自己说话（§5）：连线编译的是**节点之间**那条边的授权，
  // 而这里没有第二个节点。其余每一条照跑——能力位关掉的节点仍然不该被写入。
  const linked =
    options.requireLink === false ||
    getContextLinks(context.database, source.id).links.some(
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
  // 方向（迁移 0024）。放在能力位之前：一条不该存在的投递，理由应该是「方向
  // 不对」而不是「某个开关关着」。
  const link = getContextLinks(context.database, source.id).links.find(
    (entry) => entry.id === target.id,
  );
  if ((link?.role ?? "peer") === "main" && !acceptsFromSubs(target)) {
    throw refuse(
      "UPWARD_SEND_REFUSED",
      `「${target.title}」是你的主，下级不能把文字打进上级的终端；用 canvas post 留一条消息，由对方自己决定什么时候读。`,
    );
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
  authorize(context, source, target, {
    requireLink: !(
      item.origin === "mailbox-wake" && item.sourceNodeId === item.targetNodeId
    ),
  });
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

/**
 * 主有没有在自己的节点设置里打开「允许从向我投递」。
 *
 * 默认关：一个上级的终端不该因为它带了一个下级就多出一条别人能写进来的路。
 */
export function acceptsFromSubs(target: NodeRef): boolean {
  const data = target.data;
  if (data === null || typeof data !== "object") return false;
  const agent = (data as Record<string, unknown>).agent;
  if (agent === null || typeof agent !== "object") return false;
  return (agent as Record<string, unknown>).acceptSubDelivery === true;
}

/**
 * 这个节点跑的 CLI 有没有状态通道——注册表的事实，不是此刻的观测。
 *
 * 自定义 Agent 按 base 问，与门链上其它几条一致；没有 agent 的裸终端没有通道，
 * 它永远走 §4.3 的 `--unverified` 那条路。
 */
function hasStateChannel(context: CollabContext, target: NodeRef): boolean {
  if (target.agentId === null) return false;
  return (
    stateSourceFor(baseAgent(context.settings, target.agentId)) !== undefined
  );
}

/**
 * 「启动时不上报」的 CLI 的首投放行（§4.3）。
 *
 * 三样事实取给 `silentStartIdle`：注册表的那一位、终端域对这个会话的观测、会话
 * 建立到现在多久。判据本身是一个纯函数，放在 `agent/target-state.ts` 与五态并
 * 排——这条路是那张表的补充说明，不是另一套状态。
 *
 * 「从未上报过」由调用点保证：整段只在 `!stateSourceIsReported(stateSource)`
 * 里跑，而一个报过一条的节点此后永远有 `stateSource`（`restored` 的行也是
 * `hook`，所以重启恢复的节点不走这条路，仍按 §4.1 排队）。
 */
function silentStart(
  context: CollabContext,
  live: LiveTarget,
  nowMs: number,
): boolean {
  const agentId = live.target.agentId;
  if (agentId === null) return false;
  const session = live.session;
  return silentStartIdle({
    startsSilently: startsSilently(baseAgent(context.settings, agentId)),
    reported: stateSourceIsReported(live.stateSource),
    observed: context.terminals?.observed?.(session.sessionId),
    sessionAgeMs:
      session.createdAtMs === undefined
        ? undefined
        : nowMs - session.createdAtMs,
    nowMs,
  });
}

/**
 * 「只报过开场」的目标的首投放行：事实取给 `sessionStartIdle`，与上面
 * {@link silentStart} 并排。状态行现读——`LiveTarget` 只带五态，而这条门要的
 * 是五态背后那一行的 `sessionPhase` 与 `restored`。
 */
function sessionStart(
  context: CollabContext,
  live: LiveTarget,
  nowMs: number,
): boolean {
  const session = live.session;
  return sessionStartIdle({
    status: getAgentStatus(context.database, live.target.id),
    observed: context.terminals?.observed?.(session.sessionId),
    sessionAgeMs:
      session.createdAtMs === undefined
        ? undefined
        : nowMs - session.createdAtMs,
  });
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
  return checkBody(rawBody, "--body");
}

/**
 * The one set of rules a body has to pass, whichever verb collected it.
 *
 * `open-agent --task` queues an item that the same code path will write into a
 * PTY, so it answers to the same length and the same control-character rule —
 * otherwise the first task of a node's life would be the single delivery in
 * this system with limits of its own (§8.3 第 4 条).
 */
export function checkBody(raw: string, flag: string): string {
  const body = stripControl(raw);
  if (body.trim() === "") {
    throw new Refused(400, "bad_request", `${flag} 的正文是空的。`);
  }
  if ([...body].length > MAX_BODY_CHARS) {
    throw refuse(
      "BODY_TOO_LONG",
      `${flag} 的正文超过 ${MAX_BODY_CHARS} 个字符；把大产物写进文件，发路径。`,
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
function renderTrail(context: CollabContext, trail: readonly string[]): string {
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
  for (
    let waited = 0;
    waited < INTERRUPT_SETTLE_MS;
    waited += INTERRUPT_POLL_MS
  ) {
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
  targetState: string,
  options: AttemptOptions,
): void {
  recordDelivery(context.database, {
    traceId,
    workspaceId: item.workspaceId,
    sourceNodeId: item.sourceNodeId,
    targetNodeId: item.targetNodeId,
    outcome,
    // 「结果如何」之外的另一半：凭什么。一条 `observed-quiet` 的 `delivered`
    // 与一条有上报的 `delivered` 在面板上不该长得一样（迁移 0026、§4.3）。
    targetState,
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
