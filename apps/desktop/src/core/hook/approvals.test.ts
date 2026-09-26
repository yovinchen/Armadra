import { describe, expect, it } from "vitest";

import { permissionWaitEnvironment } from "./approvals";

/**
 * 只有 Claude 的 Hook 会等画布的答复。自定义 Agent 按它借用的内置 CLI 判：底层
 * 是 Claude 的 `custom:` 条目以前拿到的是原始 id，于是没有画布审批。
 */
describe("the approval wait variable", () => {
  it("is set for Claude when replying on the canvas is on", () => {
    expect(permissionWaitEnvironment("claude", true)).toHaveLength(1);
    expect(permissionWaitEnvironment("claude", false)).toEqual([]);
    expect(permissionWaitEnvironment("codex", true)).toEqual([]);
  });

  it("follows a custom entry to the built-in it borrows", () => {
    const baseOf = (id: string) =>
      id === "custom:review" ? "claude" : id === "custom:fast" ? "codex" : id;
    expect(
      permissionWaitEnvironment("custom:review", true, baseOf),
    ).toHaveLength(1);
    expect(permissionWaitEnvironment("custom:fast", true, baseOf)).toEqual([]);
  });
});
