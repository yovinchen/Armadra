import { afterEach, describe, expect, it } from "vitest";

import {
  claimRenderSlot,
  clampRenderBudget,
  DEFAULT_RENDER_BUDGET,
  getRenderBudget,
  RENDER_BUDGET_RANGE,
  RENDER_PRIORITY_FOCUSED,
  RENDER_PRIORITY_VISIBLE,
  resetRenderBudget,
  selectGranted,
  setRenderBudget,
  type RenderClaim,
} from "./render-budget";

afterEach(() => resetRenderBudget());

/** 依次活跃的一串可见终端：`seq` 越大越新。 */
function visible(ids: readonly string[]): RenderClaim[] {
  return ids.map((id, index) => ({
    id,
    priority: RENDER_PRIORITY_VISIBLE,
    seq: index + 1,
  }));
}

describe("selectGranted", () => {
  it("名额够时全都给", () => {
    expect(selectGranted(visible(["a", "b"]), 4)).toEqual(new Set(["a", "b"]));
  });

  it("超出上限时淘汰最久没活跃的", () => {
    expect(selectGranted(visible(["a", "b", "c", "d", "e"]), 3)).toEqual(
      new Set(["c", "d", "e"]),
    );
  });

  it("焦点实例永远有名额，哪怕因此超出上限", () => {
    const claims: RenderClaim[] = [
      { id: "f1", priority: RENDER_PRIORITY_FOCUSED, seq: 1 },
      { id: "f2", priority: RENDER_PRIORITY_FOCUSED, seq: 2 },
      ...visible(["a"]).map((claim) => ({ ...claim, seq: claim.seq + 10 })),
    ];
    // 上限 1 却给出两个：焦点那一档不受上限约束，剩下的一个名额也没有了。
    expect(selectGranted(claims, 1)).toEqual(new Set(["f1", "f2"]));
  });

  it("最老的那个有焦点时也不会被挤掉", () => {
    const claims: RenderClaim[] = [
      { id: "old", priority: RENDER_PRIORITY_FOCUSED, seq: 1 },
      ...visible(["a", "b", "c"]).map((claim) => ({
        ...claim,
        seq: claim.seq + 10,
      })),
    ];
    expect(selectGranted(claims, 2)).toEqual(new Set(["old", "c"]));
  });

  it("同优先级同 seq 时按 id 升序，结果稳定", () => {
    const claims: RenderClaim[] = [
      { id: "b", priority: RENDER_PRIORITY_VISIBLE, seq: 5 },
      { id: "a", priority: RENDER_PRIORITY_VISIBLE, seq: 5 },
    ];
    expect(selectGranted(claims, 1)).toEqual(new Set(["a"]));
    expect(selectGranted([...claims].reverse(), 1)).toEqual(new Set(["a"]));
  });

  it("上限小于等于 0 时只剩焦点实例", () => {
    const claims: RenderClaim[] = [
      { id: "focus", priority: RENDER_PRIORITY_FOCUSED, seq: 1 },
      ...visible(["a"]),
    ];
    expect(selectGranted(claims, 0)).toEqual(new Set(["focus"]));
  });
});

describe("clampRenderBudget", () => {
  it("夹在范围里并取整", () => {
    expect(clampRenderBudget(0)).toBe(RENDER_BUDGET_RANGE[0]);
    expect(clampRenderBudget(999)).toBe(RENDER_BUDGET_RANGE[1]);
    expect(clampRenderBudget(4.4)).toBe(4);
  });

  it("非数字退回默认值", () => {
    expect(clampRenderBudget(Number.NaN)).toBe(DEFAULT_RENDER_BUDGET);
  });
});

describe("登记处", () => {
  it("默认上限是设计里的 4", () => {
    expect(getRenderBudget()).toBe(DEFAULT_RENDER_BUDGET);
  });

  it("名额够时申请即授予", () => {
    const seen: boolean[] = [];
    claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, (granted) =>
      seen.push(granted),
    );
    expect(seen).toEqual([true]);
  });

  it("超额时最早的那个收到 onChange(false)", () => {
    setRenderBudget(2);
    const log: string[] = [];
    claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`a:${String(g)}`),
    );
    claimRenderSlot("b", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`b:${String(g)}`),
    );
    claimRenderSlot("c", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`c:${String(g)}`),
    );
    expect(log).toEqual(["a:true", "b:true", "a:false", "c:true"]);
  });

  it("释放会把名额还回去", () => {
    setRenderBudget(1);
    const log: string[] = [];
    claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`a:${String(g)}`),
    );
    const releaseB = claimRenderSlot("b", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`b:${String(g)}`),
    );
    expect(log).toEqual(["a:true", "a:false", "b:true"]);
    releaseB();
    expect(log).toEqual(["a:true", "a:false", "b:true", "a:true"]);
  });

  it("重复释放是空操作", () => {
    setRenderBudget(1);
    const release = claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, () => {});
    release();
    release();
    const log: string[] = [];
    claimRenderSlot("b", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`b:${String(g)}`),
    );
    expect(log).toEqual(["b:true"]);
  });

  it("改上限会立刻重算并通知", () => {
    setRenderBudget(4);
    const log: string[] = [];
    for (const id of ["a", "b", "c"]) {
      claimRenderSlot(id, RENDER_PRIORITY_VISIBLE, (g) =>
        log.push(`${id}:${String(g)}`),
      );
    }
    expect(log).toEqual(["a:true", "b:true", "c:true"]);
    setRenderBudget(1);
    expect(log.slice(3)).toEqual(["a:false", "b:false"]);
    setRenderBudget(4);
    expect(log.slice(5)).toEqual(["a:true", "b:true"]);
  });

  it("上限没变时不重算", () => {
    setRenderBudget(1);
    const log: string[] = [];
    claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, (g) => log.push(String(g)));
    setRenderBudget(1);
    expect(log).toEqual(["true"]);
  });

  it("聚焦（释放后重新申请）能把名额抢回来", () => {
    setRenderBudget(1);
    const log: string[] = [];
    const releaseA = claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`a:${String(g)}`),
    );
    claimRenderSlot("b", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`b:${String(g)}`),
    );
    // 优先级变了就重登记一次：新的序号让它排到队首，焦点档还直接免检。
    releaseA();
    claimRenderSlot("a", RENDER_PRIORITY_FOCUSED, (g) =>
      log.push(`a2:${String(g)}`),
    );
    expect(log).toEqual(["a:true", "a:false", "b:true", "b:false", "a2:true"]);
  });

  it("同一个节点重复登记不会覆盖上一条", () => {
    setRenderBudget(4);
    const log: string[] = [];
    claimRenderSlot("same", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`1:${String(g)}`),
    );
    claimRenderSlot("same", RENDER_PRIORITY_VISIBLE, (g) =>
      log.push(`2:${String(g)}`),
    );
    setRenderBudget(1);
    // 两条登记各自收到通知；用节点 id 当键的话第一条会被静默丢掉。
    expect(log).toEqual(["1:true", "2:true", "1:false"]);
  });

  it("resetRenderBudget 清空登记并恢复默认上限", () => {
    setRenderBudget(2);
    claimRenderSlot("a", RENDER_PRIORITY_VISIBLE, () => {});
    resetRenderBudget();
    expect(getRenderBudget()).toBe(DEFAULT_RENDER_BUDGET);
  });
});
