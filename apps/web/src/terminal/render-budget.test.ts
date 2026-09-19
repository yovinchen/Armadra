import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampRenderBudget,
  DEFAULT_RENDER_BUDGET,
  getRenderBudget,
  loseWebglContexts,
  registerRenderClient,
  releaseHidden,
  RENDER_ACQUIRE_DEBOUNCE_MS,
  RENDER_BUDGET_MAC,
  RENDER_BUDGET_OTHER,
  RENDER_BUDGET_RANGE,
  RENDER_LOSS_STREAK_MAX,
  RENDER_PRIORITY_FOCUSED,
  RENDER_PRIORITY_HIDDEN,
  RENDER_PRIORITY_VISIBLE,
  RENDER_REACQUIRE_AFTER_LOSS_MS,
  resetRenderBudget,
  selectGranted,
  setRenderBudget,
  type RenderClaim,
} from "./render-budget";

afterEach(() => resetRenderBudget());

/** 依次变可见的一串终端：`seq` 越小越早可见（老住户）。 */
function visible(ids: readonly string[]): RenderClaim[] {
  return ids.map((id, index) => ({
    id,
    priority: RENDER_PRIORITY_VISIBLE,
    seq: index + 1,
  }));
}

/** 依次隐藏的一串持有者：`seq` 就是 `hiddenAt`，越小越久没被看见。 */
function hidden(ids: readonly string[]): RenderClaim[] {
  return ids.map((id, index) => ({
    id,
    priority: RENDER_PRIORITY_HIDDEN,
    seq: index + 1,
  }));
}

describe("selectGranted", () => {
  it("名额够时全都给", () => {
    expect(selectGranted(visible(["a", "b"]), 4)).toEqual(new Set(["a", "b"]));
  });

  it("可见档满了就不给新来者，老住户不被挤下去", () => {
    // a/b/c 先可见（seq 1/2/3），d/e 后到。上限 3：新来者留在 DOM 渲染器。
    expect(selectGranted(visible(["a", "b", "c", "d", "e"]), 3)).toEqual(
      new Set(["a", "b", "c"]),
    );
  });

  it("可见的新来者拿走最久未见的隐藏持有者的名额", () => {
    const claims = [
      ...hidden(["h1", "h2", "h3"]),
      { id: "fresh", priority: RENDER_PRIORITY_VISIBLE, seq: 10 },
    ];
    // 上限 3：可见档整体排在隐藏档之前，隐藏档里 hiddenAt 最小的 h1 出局。
    expect(selectGranted(claims, 3)).toEqual(new Set(["fresh", "h3", "h2"]));
  });

  it("隐藏持有者永远挤不掉可见实例", () => {
    const claims = [...hidden(["h1", "h2"]), ...visible(["v"])];
    expect(selectGranted(claims, 1)).toEqual(new Set(["v"]));
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

describe("默认预算按平台", () => {
  it("只可能是 mac 的 16 或其他平台的 24", () => {
    expect([RENDER_BUDGET_MAC, RENDER_BUDGET_OTHER]).toContain(
      DEFAULT_RENDER_BUDGET,
    );
  });

  it("两档都在可设范围内", () => {
    expect(clampRenderBudget(RENDER_BUDGET_MAC)).toBe(RENDER_BUDGET_MAC);
    expect(clampRenderBudget(RENDER_BUDGET_OTHER)).toBe(RENDER_BUDGET_OTHER);
  });
});

describe("loseWebglContexts", () => {
  /** 只长得像 canvas 的替身：`webgl2` 有没有、扩展有没有都能配出来。 */
  function fakeCanvas(options: { webgl2: boolean; extension?: boolean }) {
    const calls = { lose: 0 };
    const canvas = {
      getContext: (type: string) =>
        options.webgl2 && type === "webgl2"
          ? {
              getExtension: (name: string) =>
                name === "WEBGL_lose_context" && options.extension !== false
                  ? { loseContext: () => (calls.lose += 1) }
                  : null,
            }
          : null,
    } as unknown as HTMLCanvasElement;
    return { canvas, calls };
  }

  it("把每个 WebGL canvas 的上下文显式弄丢", () => {
    const a = fakeCanvas({ webgl2: true });
    const b = fakeCanvas({ webgl2: true });
    expect(loseWebglContexts([a.canvas, b.canvas])).toBe(2);
    expect([a.calls.lose, b.calls.lose]).toEqual([1, 1]);
  });

  it("跳过非 WebGL 的 canvas，不会凭空建一个上下文", () => {
    const plain = fakeCanvas({ webgl2: false });
    expect(loseWebglContexts([plain.canvas])).toBe(0);
    expect(plain.calls.lose).toBe(0);
  });

  it("拿不到扩展时算没弄丢", () => {
    const noExt = fakeCanvas({ webgl2: true, extension: false });
    expect(loseWebglContexts([noExt.canvas])).toBe(0);
  });

  it("空输入与抛异常的 canvas 都 fail-open", () => {
    expect(loseWebglContexts(null)).toBe(0);
    expect(loseWebglContexts([])).toBe(0);
    const thrower = {
      getContext: () => {
        throw new Error("no gl");
      },
    } as unknown as HTMLCanvasElement;
    expect(loseWebglContexts([thrower])).toBe(0);
  });
});

/* -------------------------------- 协调器 ---------------------------------- */

/** 一条登记 + 它收到的所有通知。 */
function client(id: string, initialVisible = true, focused = false) {
  const log: boolean[] = [];
  const handle = registerRenderClient(
    id,
    { visible: initialVisible, focused },
    (granted) => log.push(granted),
  );
  return { handle, log, granted: () => log.at(-1) ?? false };
}

describe("协调器", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("默认上限是本机默认预算", () => {
    expect(getRenderBudget()).toBe(DEFAULT_RENDER_BUDGET);
  });

  it("登记时就可见的立刻授予——挂载不是平移扫过", () => {
    const a = client("a");
    expect(a.log).toEqual([true]);
  });

  it("登记时看不见的不授予", () => {
    const a = client("a", false);
    expect(a.log).toEqual([]);
  });

  describe("acquire 去抖", () => {
    it("去抖窗口内来回多次，只在窗口结束后授予一次", () => {
      const a = client("a", false);
      a.handle.setVisible(true);
      a.handle.setVisible(false);
      a.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS - 1);
      expect(a.log).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(a.log).toEqual([true]);
    });

    it("整片扫过：窗口内进又出的一个上下文都不建", () => {
      setRenderBudget(4);
      const swept = ["n1", "n2", "n3", "n4", "n5", "n6"].map((id) =>
        client(id, false),
      );
      for (const node of swept) node.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS - 20);
      for (const node of swept) node.handle.setVisible(false);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS * 2);
      // 一次都没授予过：快速平移不该越过上限去触发浏览器的强制驱逐。
      expect(swept.flatMap((node) => node.log)).toEqual([]);
    });

    it("聚焦立刻作废去抖——用户在打字", () => {
      const a = client("a", false);
      a.handle.setVisible(true);
      a.handle.setFocused(true);
      expect(a.log).toEqual([true]);
    });

    it("平移回来时已经暖着的不必再等一遍去抖", () => {
      const a = client("a");
      a.handle.setVisible(false);
      a.handle.setVisible(true);
      // 隐藏时名额一直留着，可见时也没掉过，所以一条通知都没有。
      expect(a.log).toEqual([true]);
    });
  });

  describe("超预算回收", () => {
    it("按 hiddenAt LRU 从隐藏持有者回收", () => {
      setRenderBudget(2);
      const a = client("a");
      const b = client("b");
      // a 先隐藏（hiddenAt 小），b 后隐藏；两个都暖着。
      a.handle.setVisible(false);
      b.handle.setVisible(false);
      expect(a.granted()).toBe(true);
      expect(b.granted()).toBe(true);

      const c = client("c", false);
      c.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      // 最久没被看见的 a 让出名额，b 还暖着。
      expect(a.granted()).toBe(false);
      expect(b.granted()).toBe(true);
      expect(c.granted()).toBe(true);
    });

    it("持有者全都可见时新来者不给，留在 DOM 渲染器", () => {
      setRenderBudget(2);
      const a = client("a");
      const b = client("b");
      const c = client("c", false);
      c.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      expect(c.log).toEqual([]);
      // 正在看的那两个一点没被动过：绝不为新来者降级可见实例。
      expect(a.log).toEqual([true]);
      expect(b.log).toEqual([true]);
    });

    it("持有者之一隐藏后，饿着的可见实例补上", () => {
      setRenderBudget(1);
      const a = client("a");
      const b = client("b", false);
      b.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      expect(b.log).toEqual([]);
      a.handle.setVisible(false);
      expect(a.granted()).toBe(false);
      expect(b.granted()).toBe(true);
    });

    it("卸载会把名额还回去", () => {
      setRenderBudget(1);
      const a = client("a");
      const b = client("b", false);
      b.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      expect(b.log).toEqual([]);
      a.handle.dispose();
      expect(b.log).toEqual([true]);
    });

    it("重复 dispose 是空操作", () => {
      setRenderBudget(1);
      const a = client("a");
      a.handle.dispose();
      a.handle.dispose();
      const b = client("b");
      expect(b.log).toEqual([true]);
    });

    it("焦点实例可以超出上限，其余一个不剩", () => {
      setRenderBudget(1);
      const a = client("a");
      const b = client("b", true, true);
      const c = client("c", true, true);
      expect(b.granted()).toBe(true);
      expect(c.granted()).toBe(true);
      expect(a.granted()).toBe(false);
    });
  });

  describe("context loss 后的重授", () => {
    it("仍可见时延迟一次重授", () => {
      const a = client("a");
      a.handle.contextLost();
      expect(a.log).toEqual([true, false]);
      vi.advanceTimersByTime(RENDER_REACQUIRE_AFTER_LOSS_MS - 1);
      // 退避期间绝不原地重授：刚唤醒的 GPU 还在安顿。
      expect(a.log).toEqual([true, false]);
      vi.advanceTimersByTime(1);
      expect(a.log).toEqual([true, false, true]);
    });

    it("看不见时不重授，等下次变可见", () => {
      const a = client("a");
      a.handle.setVisible(false);
      a.handle.contextLost();
      vi.advanceTimersByTime(RENDER_REACQUIRE_AFTER_LOSS_MS * 5);
      expect(a.log).toEqual([true, false]);
      a.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      expect(a.log).toEqual([true, false, true]);
    });

    it("连败到上限后留在 DOM 渲染器，不再申请", () => {
      const a = client("a");
      for (let i = 0; i < RENDER_LOSS_STREAK_MAX; i += 1) {
        a.handle.contextLost();
        vi.advanceTimersByTime(RENDER_REACQUIRE_AFTER_LOSS_MS);
        expect(a.granted()).toBe(true);
      }
      // 第 MAX+1 次：不再挂重授计时器。
      a.handle.contextLost();
      vi.advanceTimersByTime(RENDER_REACQUIRE_AFTER_LOSS_MS * 10);
      expect(a.granted()).toBe(false);
      // 聚焦也捶不动它——退避不是去抖。
      a.handle.setFocused(true);
      expect(a.granted()).toBe(false);
    });

    it("可见性变化清零连败，放弃只持续到用户移出再移回", () => {
      const a = client("a");
      for (let i = 0; i <= RENDER_LOSS_STREAK_MAX; i += 1) {
        a.handle.contextLost();
        vi.advanceTimersByTime(RENDER_REACQUIRE_AFTER_LOSS_MS);
      }
      expect(a.granted()).toBe(false);
      a.handle.setVisible(false);
      a.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      expect(a.granted()).toBe(true);
    });

    it("丢掉的名额当场发给饿着的可见实例", () => {
      setRenderBudget(1);
      const a = client("a");
      const b = client("b", false);
      b.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      expect(b.log).toEqual([]);
      a.handle.contextLost();
      expect(b.log).toEqual([true]);
    });
  });

  describe("releaseHidden", () => {
    it("释放所有隐藏持有者，可见的一个不动", () => {
      setRenderBudget(4);
      const a = client("a");
      const b = client("b");
      const c = client("c");
      a.handle.setVisible(false);
      b.handle.setVisible(false);
      releaseHidden();
      expect(a.granted()).toBe(false);
      expect(b.granted()).toBe(false);
      expect(c.log).toEqual([true]);
    });

    it("释放后不会原地拿回去", () => {
      const a = client("a");
      a.handle.setVisible(false);
      releaseHidden();
      vi.advanceTimersByTime(RENDER_REACQUIRE_AFTER_LOSS_MS * 5);
      expect(a.granted()).toBe(false);
    });

    it("让出来的名额补给饿着的可见实例", () => {
      setRenderBudget(1);
      const a = client("a");
      a.handle.setVisible(false);
      const b = client("b", false);
      b.handle.setVisible(true);
      vi.advanceTimersByTime(RENDER_ACQUIRE_DEBOUNCE_MS);
      // 上限 1、a 还暖着：b 其实已经按 LRU 抢到了。
      expect(b.granted()).toBe(true);
      expect(a.granted()).toBe(false);
      releaseHidden();
      expect(b.granted()).toBe(true);
    });

    it("没有隐藏持有者时是空操作", () => {
      const a = client("a");
      releaseHidden();
      expect(a.log).toEqual([true]);
    });
  });

  describe("上限变更", () => {
    it("改上限会立刻重算并通知", () => {
      setRenderBudget(4);
      const a = client("a");
      const b = client("b");
      const c = client("c");
      expect([a.granted(), b.granted(), c.granted()]).toEqual([
        true,
        true,
        true,
      ]);
      setRenderBudget(1);
      // 可见档按先来后到：最早可见的 a 留下。
      expect([a.granted(), b.granted(), c.granted()]).toEqual([
        true,
        false,
        false,
      ]);
      setRenderBudget(4);
      expect([a.granted(), b.granted(), c.granted()]).toEqual([
        true,
        true,
        true,
      ]);
    });

    it("上限没变时不重算", () => {
      setRenderBudget(1);
      const a = client("a");
      setRenderBudget(1);
      expect(a.log).toEqual([true]);
    });
  });

  it("同一个节点重复登记不会覆盖上一条", () => {
    setRenderBudget(4);
    const first = client("same");
    const second = client("same");
    setRenderBudget(1);
    // 两条登记各自收到通知；用节点 id 当键的话第一条会被静默丢掉。
    expect(first.log).toEqual([true]);
    expect(second.log).toEqual([true, false]);
  });

  it("resetRenderBudget 清空登记并恢复默认上限", () => {
    setRenderBudget(2);
    client("a");
    resetRenderBudget();
    expect(getRenderBudget()).toBe(DEFAULT_RENDER_BUDGET);
  });
});
