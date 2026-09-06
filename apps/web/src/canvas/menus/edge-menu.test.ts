import { describe, expect, it } from "vitest";

import { edgeMenuTargets } from "./edge-menu";

/**
 * 连线右键菜单的作用范围（React Flow 计划 F18）。
 *
 * 与节点 / 对象菜单同一条规则：命中的东西在选区里就作用于整个选区，
 * 否则只作用于它自己。三处规则不一致的话，「框选一片连线再右键删除」
 * 会只删掉指针底下那一条。
 */
describe("edgeMenuTargets", () => {
  it("命中的边在选区里就删整个选区", () => {
    expect(edgeMenuTargets("e1", ["e1", "e2"])).toEqual(["e1", "e2"]);
  });

  it("命中的边不在选区里就只删它自己", () => {
    expect(edgeMenuTargets("e3", ["e1", "e2"])).toEqual(["e3"]);
  });

  it("没有选区时同样只删它自己", () => {
    expect(edgeMenuTargets("e1", [])).toEqual(["e1"]);
  });
});
