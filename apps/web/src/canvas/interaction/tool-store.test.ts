import { afterEach, describe, expect, it } from "vitest";

import {
  getToolGroupChoice,
  resetToolStore,
  setTool,
  toolGroupOf,
} from "./tool-store";

afterEach(() => resetToolStore());

/**
 * 工具组的记忆（2026-09-21 用户反馈：Dock 上成对的工具各占一格太占地方）。
 *
 * Dock 把画笔 / 高亮、直线 / 箭头各收成一格，按钮显示的是组里当前那个。
 * 记忆必须由 `setTool` 统一维护——快捷键与命令面板走的也是它，不然按了
 * `Shift+D` 之后 Dock 上还画着画笔的图标。
 */
describe("工具组", () => {
  it("默认是画笔与直线", () => {
    expect(getToolGroupChoice()).toEqual({ pen: "draw", line: "line" });
  });

  it("切到组内成员就记下它，两组互不影响", () => {
    setTool("highlight");
    expect(getToolGroupChoice()).toEqual({ pen: "highlight", line: "line" });
    setTool("arrow");
    expect(getToolGroupChoice()).toEqual({ pen: "highlight", line: "arrow" });
  });

  it("切到组外的工具不动记忆：选完再回来还是上次那一种", () => {
    setTool("arrow");
    setTool("select");
    setTool("geo");
    expect(getToolGroupChoice().line).toBe("arrow");
  });

  it("`toolGroupOf` 只认组内成员", () => {
    expect(toolGroupOf("draw")).toBe("pen");
    expect(toolGroupOf("highlight")).toBe("pen");
    expect(toolGroupOf("line")).toBe("line");
    expect(toolGroupOf("arrow")).toBe("line");
    expect(toolGroupOf("geo")).toBeNull();
    expect(toolGroupOf("select")).toBeNull();
  });

  it("重置回到默认", () => {
    setTool("highlight");
    setTool("arrow");
    resetToolStore();
    expect(getToolGroupChoice()).toEqual({ pen: "draw", line: "line" });
  });
});
