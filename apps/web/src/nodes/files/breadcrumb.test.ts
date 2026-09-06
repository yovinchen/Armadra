import { describe, expect, it } from "vitest";

import {
  breadcrumbs,
  collapseCrumbs,
  DEFAULT_TAIL,
  rootLabelFor,
  tailSizeFor,
} from "./breadcrumb";

/**
 * 用户实测：面包屑「从根目录逐级列出来，太长，箭头太多」。这份测试钉住的
 * 是折叠规则本身——头一格永远是工作空间根，中间全折进一个 `…`，末尾留两级
 * （窄节点一级）。
 */

describe("breadcrumbs", () => {
  it("always starts at the root", () => {
    expect(breadcrumbs(".", "根目录")).toEqual([
      { label: "根目录", path: "." },
    ]);
  });

  it("accumulates one crumb per segment", () => {
    expect(breadcrumbs("src/nodes/ui", "根目录")).toEqual([
      { label: "根目录", path: "." },
      { label: "src", path: "src" },
      { label: "nodes", path: "src/nodes" },
      { label: "ui", path: "src/nodes/ui" },
    ]);
  });
});

describe("rootLabelFor", () => {
  it("用工作空间名", () => {
    expect(
      rootLabelFor("Armadra", "/Users/me/Projects/armadra", "根目录"),
    ).toBe("Armadra");
  });

  it("没有名字就用根路径的最后一段", () => {
    expect(
      rootLabelFor(undefined, "/Users/me/Projects/armadra/", "根目录"),
    ).toBe("armadra");
    expect(rootLabelFor("   ", "/Users/me/Projects/armadra", "根目录")).toBe(
      "armadra",
    );
  });

  it("两样都没有才用兜底文案", () => {
    expect(rootLabelFor(undefined, undefined, "根目录")).toBe("根目录");
    expect(rootLabelFor(undefined, "/", "根目录")).toBe("根目录");
  });
});

describe("collapseCrumbs", () => {
  const deep = breadcrumbs(
    "Users/yovinchen/Projects/Rust/Tauri/armadra/apps/web/src",
    "Armadra",
  );

  it("头一格是工作空间根，中间折起来，末尾留两级", () => {
    const { root, hidden, tail } = collapseCrumbs(deep, DEFAULT_TAIL);
    expect(root).toEqual({ label: "Armadra", path: "." });
    expect(tail.map((crumb) => crumb.label)).toEqual(["web", "src"]);
    expect(hidden.map((crumb) => crumb.label)).toEqual([
      "Users",
      "yovinchen",
      "Projects",
      "Rust",
      "Tauri",
      "armadra",
      "apps",
    ]);
    // 显示出来的一共三格（根、`…`、两级里的两格），不是九格。
    expect(1 + 1 + tail.length).toBe(4);
  });

  it("折起来的每一级还带着自己能跳的路径", () => {
    const { hidden } = collapseCrumbs(deep, DEFAULT_TAIL);
    expect(hidden[0]).toEqual({ label: "Users", path: "Users" });
    expect(hidden.at(-1)?.path).toBe(
      "Users/yovinchen/Projects/Rust/Tauri/armadra/apps",
    );
  });

  it("窄节点只留最后一级", () => {
    const { hidden, tail } = collapseCrumbs(deep, tailSizeFor(200));
    expect(tail.map((crumb) => crumb.label)).toEqual(["src"]);
    expect(hidden.at(-1)?.label).toBe("web");
  });

  it("层级本来就不多时一格都不折", () => {
    const shallow = breadcrumbs("src/nodes", "Armadra");
    expect(collapseCrumbs(shallow)).toEqual({
      root: { label: "Armadra", path: "." },
      hidden: [],
      tail: [
        { label: "src", path: "src" },
        { label: "nodes", path: "src/nodes" },
      ],
    });
  });

  it("中间只剩一级也不折——换成一个 `…` 既不省地方又多一次点击", () => {
    const three = breadcrumbs("a/b/c", "Armadra");
    const { hidden, tail } = collapseCrumbs(three, DEFAULT_TAIL);
    expect(hidden).toEqual([]);
    expect(tail.map((crumb) => crumb.label)).toEqual(["a", "b", "c"]);
  });

  it("在根目录时只有一格", () => {
    expect(collapseCrumbs(breadcrumbs(".", "Armadra"))).toEqual({
      root: { label: "Armadra", path: "." },
      hidden: [],
      tail: [],
    });
  });

  it("宽节点保留两级", () => {
    expect(tailSizeFor(340)).toBe(DEFAULT_TAIL);
    expect(tailSizeFor(undefined)).toBe(DEFAULT_TAIL);
  });
});
