import { describe, expect, it } from "vitest";

import { isValidLink } from "./connection";

const nodes = [{ id: "terminal" }, { id: "sticky" }, { id: "draw" }];

describe("isValidLink", () => {
  it("任意两种节点都能连（§21）", () => {
    expect(isValidLink({ source: "draw", target: "terminal" }, nodes, [])).toBe(
      true,
    );
    expect(isValidLink({ source: "draw", target: "sticky" }, nodes, [])).toBe(
      true,
    );
    // 反着拖也行：方向由用户决定，箭头由渲染决定。
    expect(isValidLink({ source: "terminal", target: "draw" }, nodes, [])).toBe(
      true,
    );
  });

  it("禁止自连", () => {
    expect(isValidLink({ source: "draw", target: "draw" }, nodes, [])).toBe(
      false,
    );
  });

  it("禁止重复连，反方向也算重复", () => {
    const edges = [{ source: "sticky", target: "terminal" }];
    expect(
      isValidLink({ source: "sticky", target: "terminal" }, nodes, edges),
    ).toBe(false);
    expect(
      isValidLink({ source: "terminal", target: "sticky" }, nodes, edges),
    ).toBe(false);
  });

  it("两端都必须存在", () => {
    expect(isValidLink({ source: "draw", target: "ghost" }, nodes, [])).toBe(
      false,
    );
    expect(isValidLink({ source: null, target: "draw" }, nodes, [])).toBe(
      false,
    );
  });
});
