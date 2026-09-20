import { beforeEach, describe, expect, it } from "vitest";

import {
  guestKey,
  hiddenCount,
  isOverBudget,
  markHidden,
  markVisible,
  resetBackgroundGuests,
} from "./background";

/**
 * 「隐藏着的 guest 排第几」。
 *
 * 这张表是 `pool.ts` 的 ghost 上限与 `discard.ts` 的五分钟之间那条接缝：
 * 数量超了就不等时间。四条否决不在这里，它们在 `shouldDiscard`。
 */

beforeEach(() => {
  resetBackgroundGuests();
});

describe("markHidden / markVisible", () => {
  it("可见的不在表里", () => {
    markHidden("a", 1);
    expect(hiddenCount()).toBe(1);
    markVisible("a");
    expect(hiddenCount()).toBe(0);
  });

  it("重复登记不刷新时刻", () => {
    // 一直隐藏着的页面不该因为一次无关的重渲染回到队尾——那会让最该释放的
    // 那个永远排不到。
    markHidden("a", 1);
    markHidden("a", 1000);
    markHidden("b", 2);
    expect(isOverBudget("a", 1)).toBe(true);
    expect(isOverBudget("b", 1)).toBe(false);
  });
});

describe("isOverBudget", () => {
  it("没超上限时谁都不超预算", () => {
    markHidden("a", 1);
    markHidden("b", 2);
    expect(isOverBudget("a", 8)).toBe(false);
    expect(isOverBudget("b", 8)).toBe(false);
  });

  it("超了就从隐藏得最久的那个开始", () => {
    markHidden("a", 1);
    markHidden("b", 2);
    markHidden("c", 3);
    expect(isOverBudget("a", 2)).toBe(true);
    expect(isOverBudget("b", 2)).toBe(false);
    expect(isOverBudget("c", 2)).toBe(false);
  });

  it("上限为 0 时隐藏的一个都不留", () => {
    markHidden("a", 1);
    expect(isOverBudget("a", 0)).toBe(true);
  });

  it("可见的永远不超预算", () => {
    markHidden("a", 1);
    markHidden("b", 2);
    expect(isOverBudget("missing", 0)).toBe(false);
  });

  it("同一毫秒隐藏的也分得出先后", () => {
    // 没有这条决胜负的规则，两边都认为对方更靠里，于是谁也不释放——而这正
    // 是「切走一整块画布」时最常见的情形：所有节点同一拍变成隐藏。
    markHidden("a", 5);
    markHidden("b", 5);
    markHidden("c", 5);
    const over = ["a", "b", "c"].filter((key) => isOverBudget(key, 1));
    expect(over).toHaveLength(2);
  });

  it("一块画布整批隐藏时，正好释放到剩下上限那么多", () => {
    for (let index = 0; index < 5; index += 1) markHidden(`g${index}`, 100);
    const over = ["g0", "g1", "g2", "g3", "g4"].filter((key) =>
      isOverBudget(key, 2),
    );
    expect(over).toHaveLength(3);
  });
});

describe("guestKey", () => {
  it("一个节点的每个标签各算一个", () => {
    expect(guestKey("n1", "wv-1")).not.toBe(guestKey("n1", "wv-2"));
    expect(guestKey("n1", "wv-1")).toBe(guestKey("n1", "wv-1"));
  });
});
