import { describe, expect, it } from "vitest";

import { NODE_BODY, NODE_META } from "./registry";

/**
 * 节点体必须是懒加载的（§17「代码分割」）。
 *
 * 这张表一旦有一条写回顶层 import，空画布就又要加载那一种节点体的全部依赖：
 * 终端的 xterm、编辑器的 CodeMirror 与语言服务、对比的三方合并、便签的
 * react-markdown——实测合计 2.8 MB，而画布上一个节点都没有。产物里看不出
 * 这件事（chunk 照样分着），只有渲染进程的 RSS 上会多出来。
 *
 * `NODE_META` 反过来必须是同步的：新建一个节点要立刻知道默认尺寸，等不了
 * 一次 `import()`。
 */

/** React 给 `lazy()` 的标记。 */
const LAZY = Symbol.for("react.lazy");

describe("节点体的加载时刻", () => {
  it("除分组外每一种节点体都是 lazy 的", () => {
    const eager = Object.entries(NODE_BODY)
      .filter(([type]) => type !== "group")
      .filter(
        ([, component]) =>
          (component as { $$typeof?: symbol }).$$typeof !== LAZY,
      )
      .map(([type]) => type);
    expect(eager).toEqual([]);
  });

  it("分组没有节点体：它由 GroupNode 自己画", () => {
    expect((NODE_BODY.group as { $$typeof?: symbol }).$$typeof).not.toBe(LAZY);
  });

  it("尺寸与图标仍然是同步读的", () => {
    for (const meta of Object.values(NODE_META)) {
      expect(meta.defaultSize.width).toBeGreaterThan(0);
      expect(typeof meta.icon).not.toBe("undefined");
    }
  });
});
