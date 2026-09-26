import { hasCapability } from "../../agent/registry";
import type { Caller } from "../nodes";
import { HELP, PROTOCOL, runMailbox } from "../mailbox";
import { Args, Refusal, Refused, asRefused } from "../refusals";
import type { CollabContext } from "../service";
import { openBrowser } from "./browser-node";
import { cancel } from "./cancel";
import { close } from "./close";
import { color, link, rename } from "./edits";
import { interrupt } from "./interrupt";
import { list, openAgent, openTerminal, sticky, team } from "./nodes";
import { outbox } from "./outbox";
import { resolveTarget, send } from "./send";
import { type Outcome, outcomeBody, raw, result } from "./outcome";

export { outcomeBody };

export {
  CONFIRM_TIMEOUT_SECS,
  answerConfirm,
  confirmWorkspace,
  pendingConfirms,
} from "./close";
export { NODE_PALETTE, PLACEMENT_GAP, PLACEMENT_STEP } from "./board";
export type { Outcome } from "./outcome";

/**
 * The canvas verbs, and the one function the Hook surface calls.
 *
 * Ported from the pre-merge implementation. The split of
 * responsibilities with the Hook domain is deliberate and is the whole reason
 * {@link ControlDispatcher} exists: the Hook server owns the socket, the
 * bearer, the node token and the body limit, and once it has decided *who is
 * calling* it hands the already-authenticated verb here. Nothing in this
 * module reads a header, and nothing in the Hook server decides what a verb
 * may do.
 *
 * `list` and `help` are the only verbs a `legacy` caller — one with no node
 * token this core minted — may run. Everything that changes something
 * requires a verified caller, and that check lives here rather than in the
 * Hook server so a route can never be a weaker door than the verb behind it.
 */

export const VERBS = [
  "help",
  "post",
  "inbox",
  "ack",
  "handoff-read",
  "list",
  "open-terminal",
  "open-agent",
  // 画布规则要 Agent 用画布里的浏览器节点；没有连着的就得能自己建一个。
  "open-browser",
  "sticky",
  "link",
  "rename",
  "color",
  "interrupt",
  "close",
  // 推式投递（设计 agent-delivery.md §3.3）。`post` 留在原处：一张表与一次
  // 按键是两件事，不是同一件事的两种写法。
  "send",
  "outbox",
  "cancel",
  // 批量组队（Agent 自动化设计 §6）：几次 `open-agent` 加上它们之间的依赖。
  "team",
] as const;

export type ControlVerb = (typeof VERBS)[number];

/** Verbs a caller with no node token may run: the read-only ones. */
const LEGACY_VERBS: readonly string[] = ["list", "help"];

/**
 * What the Hook surface hands over once it knows who is calling.
 *
 * `caller` is fully resolved: the node row was loaded from the board and the
 * verdict is the Hook server's judgement about the node token. A dispatcher
 * never re-reads a header, and never trusts a node id out of the body that the
 * Hook server did not authenticate.
 */
export interface ControlDispatcher {
  /** The verbs this build answers. `help` is derived from exactly this list. */
  readonly verbs: readonly string[];
  dispatch(
    verb: string,
    caller: Caller,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ControlOutcome>;
}

export type ControlOutcome =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      /** 机器读的附加字段，原样摊进拒绝体里。 */
      readonly detail?: Record<string, unknown>;
    };

/**
 * The dispatcher for one assembled core.
 *
 * Held in a module-level slot rather than passed around because the Hook
 * domain is installed separately and must not have to reach into this one's
 * internals to find it. `undefined` before this domain is installed, which is
 * an answer the Hook server can give honestly (503) rather than a crash.
 */
let dispatcher: ControlDispatcher | undefined;

export function controlDispatcher(): ControlDispatcher | undefined {
  return dispatcher;
}

export function setControlDispatcher(next: ControlDispatcher | undefined) {
  dispatcher = next;
}

export function createControlDispatcher(
  context: CollabContext,
): ControlDispatcher {
  return {
    verbs: VERBS,
    dispatch: async (verb, caller, args) => {
      try {
        const outcome = await run(context, caller, verb, new Args(args));
        return { ok: true, body: outcomeBody(outcome) };
      } catch (error) {
        const refused = asRefused(error);
        return {
          ok: false,
          status: refused.status,
          code: refused.code,
          message: refused.message,
          // `retryable` / `retryAfterMs` / 来源链：一个要靠解析中文句子才能
          // 知道该退避多久的调用者，没有退避，只有猜测（§3.5、§3.7）。
          ...(refused.detail === undefined ? {} : { detail: refused.detail }),
        };
      }
    },
  };
}

/** One control verb. Throws {@link Refused} or {@link Refusal} on refusal. */
export async function run(
  context: CollabContext,
  caller: Caller,
  verb: string,
  args: Args,
): Promise<Outcome> {
  // A custom Agent that had `contextLink` switched off may not draw one
  // either: `link` is how an unreadable peer becomes a readable one.
  if (
    verb === "link" &&
    caller.node.agentId?.startsWith("custom:") === true &&
    !hasCapability(context.settings, caller.node.agentId, "contextLink")
  ) {
    throw Refusal.forbidden(
      "Node context links are disabled for this custom Agent",
    );
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw Refusal.badRequest(
      `未知的画布动词 \`${verb}\`，可用：${VERBS.join(" / ")}。`,
    );
  }
  if (!LEGACY_VERBS.includes(verb) && caller.verdict !== "verified") {
    throw Refusal.forbidden(
      `\`${verb}\` 需要本运行时签发的节点令牌；这个终端没有，已拒绝。`,
    );
  }
  switch (verb) {
    case "help":
      // Derived from the registry above rather than restated: a verb added to
      // `VERBS` without a line in the help text would be invisible, and a line
      // left behind after a verb was removed would be a lie.
      return result(`${HELP}\n可用画布动词：${VERBS.join(" / ")}`, {
        protocol: PROTOCOL,
        verbs: VERBS,
      });
    case "handoff-read":
      return handoffRead(context, caller, args);
    case "post":
    case "inbox":
    case "ack": {
      const body = await runMailbox(context, caller, verb, args);
      return raw(body, String(body.message ?? verb));
    }
    case "list":
      return list(context, caller);
    case "open-terminal":
      return openTerminal(context, caller, args);
    case "open-agent":
      return openAgent(context, caller, args);
    case "open-browser":
      return openBrowser(context, caller, args);
    case "sticky":
      return sticky(context, caller, args);
    case "link":
      return link(context, caller, args);
    case "rename":
      return rename(context, caller, args);
    case "color":
      return color(context, caller, args);
    case "interrupt":
      return interrupt(context, caller, args);
    case "close":
      return close(context, caller, args);
    case "send":
      wakeTarget(context, caller, args);
      return send(context, caller, args);
    case "outbox":
      return outbox(context, caller, args);
    case "cancel":
      return cancel(context, caller, args);
    case "team":
      return team(context, caller, args);
    default:
      throw Refusal.badRequest(`未知的画布动词 \`${verb}\`。`);
  }
}

/**
 * 投给一个休眠节点（Eco 模式，终端宿主设计 §7.2）：踢一下唤醒，**不等**它接回
 * 来，直接走 `send` 自己的整条门链。
 *
 * 不等：接回来要起 shell、等提示符、敲恢复行、等前台变成 CLI，秒级；而
 * `armadra-hook canvas` 整个请求只有 1.5 秒。等下去的结果是客户端先超时、报「可
 * 能已经生效」并以非零退出——发送方的 Agent 看到失败，消息却排上了、随后也投
 * 了出去（2026-09-26 端到端实测）。门链在目标 `sleeping` 期间把「没有会话 /
 * 前台不是 CLI」当成「还早」排队（`send.ts::attempt`），接回来之后唤醒方推一下
 * 出队泵。
 *
 * 放在 `send` 外面而不是里面：`send` 的门链不为唤醒多一条分支。目标解析不出
 * 来、演练，都交给 `send` 自己如实拒绝。接不回来的由唤醒方记日志、在节点上标
 * 失败；排着的那条由队列的 TTL 决定死期。
 */
function wakeTarget(context: CollabContext, caller: Caller, args: Args): void {
  const wake = context.terminals?.wakeNode;
  if (wake === undefined || args.flag("dry-run")) return;
  let targetId: string;
  try {
    targetId = resolveTarget(context, caller, args).id;
  } catch {
    return;
  }
  void wake(targetId).catch(() => {
    // 没接回来：唤醒方已经记了日志、发了 `failed`。
  });
}

/**
 * `handoff-read` — the frozen bundle a peer approved for this session.
 *
 * The session binding is not optional and not a convenience: a bundle is
 * addressed to one session of one generation, and a receipt that could be
 * re-pointed at another session would stop being evidence.
 */
async function handoffRead(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const id = args.text("id");
  if (id === undefined) {
    throw Refusal.badRequest("handoff-read requires --id");
  }
  const sessionId = args.text("sessionId");
  if (sessionId === undefined) {
    throw Refusal.forbidden("Current session binding is required");
  }
  const generation = args.count(["generation"]);
  if (generation === undefined || generation < 0) {
    throw Refusal.forbidden("Current generation binding is required");
  }
  const reader = context.handoffReader;
  if (reader === undefined) {
    throw new Refused(
      503,
      "internal_error",
      "交接域还没有装配好，无法读取交接材料。",
    );
  }
  try {
    const value = await reader(caller, id, sessionId, generation);
    return raw(value, "Frozen peer context");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Refusal.forbidden(message);
  }
}
