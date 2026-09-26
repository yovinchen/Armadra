import { describe, expect, it } from "vitest";

import { MAX_TARGETS_PER_TURN, SendLimits } from "./send-limits";

/**
 * 单回合目标数（设计 `agent-delivery.md` §7）只对有状态上报的发起者设：一轮的
 * 边界靠它自己报的非 `working` 来划。从不上报的发起者——人自己的普通终端、没
 * 装适配的 CLI——不知道一轮从哪开始，就不设这道闸。
 *
 * 2026-09-26 端到端：普通终端当发送方，前面的场景投过四个不同目标之后，第五个
 * 新目标一律「这一轮已经投给了四个不同的目标」——它永远不会报状态，这一轮
 * 永远不结束。
 */
describe("单回合目标数", () => {
  const targets = Array.from(
    { length: MAX_TARGETS_PER_TURN + 2 },
    (_, index) => `target-${index}`,
  );

  it("从不上报的发起者不设这道闸", () => {
    const limits = new SendLimits();
    for (const target of targets) {
      expect(limits.fanout("shell", target)).toBe(true);
      limits.noteDelivered("shell", target, 0);
    }
  });

  it("上报过的发起者一轮最多四个不同目标，报了非 working 就开新的一轮", () => {
    const limits = new SendLimits();
    limits.noteSourceState("agent", "working");
    for (const target of targets.slice(0, MAX_TARGETS_PER_TURN)) {
      expect(limits.fanout("agent", target)).toBe(true);
      limits.noteDelivered("agent", target, 0);
    }
    expect(
      limits.fanout("agent", targets[MAX_TARGETS_PER_TURN] as string),
    ).toBe(false);
    // 投过的目标不算新的。
    expect(limits.fanout("agent", targets[0] as string)).toBe(true);
    limits.noteSourceState("agent", "idle");
    expect(
      limits.fanout("agent", targets[MAX_TARGETS_PER_TURN] as string),
    ).toBe(true);
  });
});
