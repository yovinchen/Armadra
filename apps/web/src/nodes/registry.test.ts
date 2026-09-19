import { describe, expect, it } from "vitest";
import { NODE_TYPES, DEFAULT_NODE_COLOR } from "@armadra/shared";

import { t } from "@/app/preferences-store";
import {
  NODE_BODY,
  NODE_META,
  COLLAPSED_HEIGHT,
  defaultNodeSize,
  minNodeSize,
  nodeMeta,
} from "./registry";
import { HEADER_HEIGHT, NODE_BORDER_WIDTH } from "./geometry";
import { COLLAPSED_HEIGHT as STORED_COLLAPSED_HEIGHT } from "../store/defaults";

/** 计划书 §3.4 的尺寸表，逐字抄一遍作为回归基线。 */
const EXPECTED = {
  terminal: { default: [960, 600], min: [320, 200] },
  sticky: { default: [280, 220], min: [160, 120] },
  group: { default: [800, 560], min: [200, 140] },
  editor: { default: [960, 640], min: [320, 200] },
  diff: { default: [1200, 700], min: [420, 220] },
  files: { default: [360, 640], min: [220, 160] },
  browser: { default: [1280, 800], min: [480, 320] },
  automation: { default: [360, 260], min: [260, 180] },
  agentActivity: { default: [340, 240], min: [240, 160] },
} as const;

describe("node registry", () => {
  it("covers every node type exactly once", () => {
    expect(Object.keys(NODE_META).sort()).toEqual([...NODE_TYPES].sort());
    expect(Object.keys(NODE_BODY).sort()).toEqual([...NODE_TYPES].sort());
  });

  it("answers metadata lookups for every type", () => {
    for (const type of NODE_TYPES) {
      expect(nodeMeta(type).labelKey).toBe(`node.${type}`);
      expect(defaultNodeSize(type).width).toBeGreaterThan(0);
      expect(minNodeSize(type).width).toBeGreaterThan(0);
    }
  });

  it("gives the browser node a standard 1280×800 viewport (§3.4)", () => {
    expect(NODE_META.browser.defaultSize).toEqual({ width: 1280, height: 800 });
  });

  it("matches the §3.4 size table", () => {
    for (const type of NODE_TYPES) {
      const meta = NODE_META[type];
      const expected = EXPECTED[type];
      expect([meta.defaultSize.width, meta.defaultSize.height]).toEqual([
        ...expected.default,
      ]);
      expect([meta.minSize.width, meta.minSize.height]).toEqual([
        ...expected.min,
      ]);
    }
  });

  it("never lets the default size fall below the minimum", () => {
    for (const type of NODE_TYPES) {
      const meta = NODE_META[type];
      expect(meta.defaultSize.width).toBeGreaterThanOrEqual(meta.minSize.width);
      expect(meta.defaultSize.height).toBeGreaterThanOrEqual(
        meta.minSize.height,
      );
    }
  });

  it("gives bridge handles to every type but group (§21)", () => {
    const withoutHandles = NODE_TYPES.filter(
      (type) => !NODE_META[type].hasBridgeHandles,
    );
    // 分组只是画框；两张 Host 侧卡片的内容都在 Host 上，连过去读不到东西。
    expect(withoutHandles).toEqual(["group", "automation", "agentActivity"]);
  });

  it("defaults to the palette blue, sticky to the palette yellow", () => {
    expect(NODE_META.sticky.defaultColor).toBe("#ffd60a");
    for (const type of NODE_TYPES) {
      if (type === "sticky") continue;
      expect(NODE_META[type].defaultColor).toBe(DEFAULT_NODE_COLOR);
    }
  });

  it("collapses to the header height from §3.4", () => {
    expect(COLLAPSED_HEIGHT).toBe(40);
    expect(COLLAPSED_HEIGHT).toBe(HEADER_HEIGHT + NODE_BORDER_WIDTH * 2);
    expect(STORED_COLLAPSED_HEIGHT).toBe(COLLAPSED_HEIGHT);
  });

  it("has a translatable label key and an icon for every type", () => {
    for (const type of NODE_TYPES) {
      expect(NODE_META[type].labelKey).toBe(`node.${type}`);
      expect(t(NODE_META[type].labelKey)).toMatch(/[一-龥]/);
      expect(NODE_META[type].icon).toBeTypeOf("object");
    }
  });
});
