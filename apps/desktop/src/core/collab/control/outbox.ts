import { getContextLinks } from "../../canvas/context-links";
import { AddressError, loadHandles, resolveLink } from "../addressing";
import { type Caller, loadNode } from "../nodes";
import { type Args, Refused } from "../refusals";
import { outboxFor, positionOf } from "../send-queue";
import { type CollabContext, nowSeconds } from "../service";
import { DELIVERY_PROTOCOL, displayName } from "./send";
import { type Outcome, raw } from "./outcome";

/**
 * `outbox` —— 排在别人终端前面、还没投出去的那些（设计 §3.3、§4.6 的可见性）。
 *
 * 只列**自己**投的。它不是一个队列总览：一条排在别人终端前面的指令，发起者要
 * 能看见并取消，而目标那一侧的人看的是节点头的「排队 N」与收件箱面板的那个
 * 页签——两边看到的是同一张表的两个切片，各自只看得见自己该管的那部分。
 *
 * 不带正文。这条与 `agent_deliveries` 的那条规矩一样：列表是「有什么排着」，
 * 不是「排着的东西说了什么」，后者在目标的屏幕上而不在发起者的列表里。
 */
export function outbox(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const now = nowSeconds(context);
  const limit = Math.min(50, Math.max(1, args.count(["limit"]) ?? 20));
  const wanted = args.text("to") ?? args.text("node");
  let targetNodeId: string | undefined;
  if (wanted !== undefined) {
    const links = getContextLinks(context.database, caller.node.id).links;
    const handles = loadHandles(context.database, links);
    try {
      targetNodeId = resolveLink(links, handles, wanted).id;
    } catch (error) {
      if (error instanceof AddressError) {
        throw new Refused(
          error.status,
          error.code,
          error.refusal("--to").message,
        );
      }
      throw error;
    }
  }
  const items = outboxFor(
    context.database,
    caller.node.id,
    targetNodeId,
    limit,
    now,
  );
  const rows = items.map((item) => {
    const target = loadNode(context.database, item.targetNodeId);
    return {
      id: item.id,
      to: item.targetNodeId,
      toHandle: displayName(target, item.targetNodeId),
      origin: item.origin,
      queuedAt: item.createdAt,
      expiresAt: item.expiresAt,
      position: positionOf(context.database, item, now),
      bodyChars: [...item.body].length,
      attempts: item.attempts,
      ...(item.lastReason === undefined ? {} : { reason: item.lastReason }),
    };
  });
  return raw(
    {
      ok: true,
      protocol: DELIVERY_PROTOCOL,
      items: rows,
      message:
        rows.length === 0
          ? "你没有还没投出去的投递。"
          : `${rows.length} 条还排着；canvas cancel --id <id> 可以撤掉一条。`,
    },
    "outbox",
  );
}
