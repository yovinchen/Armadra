import type { Caller } from "../nodes";
import { type Args, Refused } from "../refusals";
import { byId, cancelOwn } from "../send-queue";
import type { CollabContext } from "../service";
import { DELIVERY_PROTOCOL } from "./send";
import { type Outcome, raw } from "./outcome";

/**
 * `cancel` —— 撤掉一条还没投出去的投递（设计 §3.3、§4.6 的取消那一行）。
 *
 * 只能撤自己的，也只能撤**还在排**的那些。已经写进 PTY 的那一条收不回来，对它
 * 说「取消了」就是撒谎；正在投的那一条同理——`delivering` 的意思是字节已经在
 * 路上。目标那一侧的人在面板上删掉一条等于拒收，那条路是另一个入口，不走这个
 * 动词。
 */
export function cancel(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const id = args.text("id");
  if (id === undefined) {
    throw new Refused(400, "bad_request", "cancel 需要 --id <待投 id>。");
  }
  const item = byId(context.database, id);
  if (item === undefined || item.sourceNodeId !== caller.node.id) {
    // 不是自己的那一条与不存在答同一句：否则这个动词就是一个探测别人队列的
    // 工具。
    throw new Refused(404, "not_found", `你的待投里没有 \`${id}\`。`);
  }
  const cancelled = cancelOwn(context.database, caller.node.id, id);
  return raw(
    {
      ok: true,
      protocol: DELIVERY_PROTOCOL,
      id,
      cancelled,
      message: cancelled
        ? `已撤掉 ${id}。`
        : `${id} 已经不在排队里了（${item.state}），没有撤掉任何东西。`,
    },
    "cancel",
  );
}
