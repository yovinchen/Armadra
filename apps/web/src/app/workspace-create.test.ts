import { describe, expect, it } from "vitest";
import { WORKSPACE_COLORS } from "@armadra/shared";

import {
  pickWorkspaceColor,
  workspaceNameOf,
  workspaceRequest,
} from "./workspace-create";

describe("workspaceNameOf", () => {
  it("取路径最后一段，斜杠与反斜杠都认", () => {
    expect(workspaceNameOf("/tmp/projects/demo")).toBe("demo");
    expect(workspaceNameOf("/tmp/projects/demo/")).toBe("demo");
    expect(workspaceNameOf("/tmp/projects/demo///")).toBe("demo");
    expect(workspaceNameOf("C:\\code\\demo")).toBe("demo");
    expect(workspaceNameOf("C:\\code\\demo\\")).toBe("demo");
    expect(workspaceNameOf("  /tmp/demo  ")).toBe("demo");
  });

  it("根目录与空串没有末段", () => {
    expect(workspaceNameOf("/")).toBe("");
    expect(workspaceNameOf("")).toBe("");
  });
});

describe("pickWorkspaceColor", () => {
  it("按已有数量在色板上轮询", () => {
    expect(pickWorkspaceColor([])).toBe(WORKSPACE_COLORS[0]);
    expect(pickWorkspaceColor([1])).toBe(WORKSPACE_COLORS[1]);
    expect(pickWorkspaceColor(Array(WORKSPACE_COLORS.length - 1).fill(0))).toBe(
      WORKSPACE_COLORS[WORKSPACE_COLORS.length - 1],
    );
  });

  it("绕回色板开头，不会取空", () => {
    expect(pickWorkspaceColor(Array(WORKSPACE_COLORS.length).fill(0))).toBe(
      WORKSPACE_COLORS[0],
    );
    expect(
      pickWorkspaceColor(Array(WORKSPACE_COLORS.length * 3 + 2).fill(0)),
    ).toBe(WORKSPACE_COLORS[2]);
  });
});

describe("workspaceRequest", () => {
  it("名称取末段、权限全开，createDirectory 默认不带", () => {
    expect(workspaceRequest("/tmp/demo", [])).toEqual({
      name: "demo",
      rootPath: "/tmp/demo",
      color: WORKSPACE_COLORS[0],
      permissions: { read: true, write: true, execute: true },
    });
  });

  it("要建目录时才带 createDirectory", () => {
    expect(workspaceRequest("/tmp/demo", [1, 2], true)).toMatchObject({
      color: WORKSPACE_COLORS[2],
      createDirectory: true,
    });
  });
});
