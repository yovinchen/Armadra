import { describe, expect, it } from "vitest";

import {
  WHITEBOARD_COLORS,
  WHITEBOARD_SIZES,
} from "@/app/preferences/whiteboard";
import {
  colorHex,
  dashArray,
  fillOpacity,
  fontSize,
  scaledSize,
  strokeWidth,
  WHITEBOARD_PALETTE,
} from "./palette";

/**
 * 色板与线宽（React Flow 计划 §2.4）。
 *
 * 这张表被三处读：SVG 节点、样式面板、栅格化。少一个颜色名就意味着某种
 * 颜色的墨迹在导出的 PNG 里变成黑色，所以先钉「表是全的」。
 */

describe("色板", () => {
  it("13 个颜色名一个不少，两套色值都是六位十六进制", () => {
    expect(Object.keys(WHITEBOARD_PALETTE).sort()).toEqual(
      [...WHITEBOARD_COLORS].sort(),
    );
    for (const color of WHITEBOARD_COLORS) {
      for (const scheme of ["light", "dark"] as const) {
        expect(WHITEBOARD_PALETTE[color][scheme], `${color}.${scheme}`).toMatch(
          /^#[0-9a-f]{6}$/u,
        );
      }
    }
  });

  it("同一个名字在两套里是同一支笔，只是亮度换一档", () => {
    expect(colorHex("black", "light")).toBe("#1d1d1d");
    expect(colorHex("black", "dark")).toBe("#e8e8e8");
  });

  it("未知颜色名退回黑色那一支，不返回 undefined", () => {
    expect(colorHex("chartreuse", "light")).toBe(
      WHITEBOARD_PALETTE.black.light,
    );
  });
});

describe("线宽与字号", () => {
  it("四档线宽 2 / 3.5 / 5 / 10（§2.4）", () => {
    expect(WHITEBOARD_SIZES.map(strokeWidth)).toEqual([2, 3.5, 5, 10]);
  });

  it("字号随档位单调递增", () => {
    const sizes = WHITEBOARD_SIZES.map(fontSize);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it("未知档位退回 m", () => {
    expect(strokeWidth("xxl")).toBe(strokeWidth("m"));
    expect(fontSize("xxl")).toBe(fontSize("m"));
  });
});

describe("动态尺寸", () => {
  it("缩放为 1 时不动", () => {
    expect(scaledSize("m", 1)).toBe("m");
  });

  it("缩小时挑粗一档，放大时挑细一档", () => {
    // s 是 2px：缩到 0.4 想要 5px，正好是 l；缩到 0.25 想要 8px，最近的是 xl。
    expect(scaledSize("s", 0.4)).toBe("l");
    expect(scaledSize("s", 0.25)).toBe("xl");
    // xl 是 10px：放大 5 倍想要 2px，正好是 s。
    expect(scaledSize("xl", 5)).toBe("s");
  });

  it("非法缩放原样返回，绝不产生第五档", () => {
    expect(scaledSize("m", 0)).toBe("m");
    expect(scaledSize("m", Number.NaN)).toBe("m");
  });
});

describe("虚实与填充", () => {
  it('实线不设 dasharray（写 "none" 有的浏览器当无效值）', () => {
    expect(dashArray("solid", 4)).toBeUndefined();
    expect(dashArray(undefined, 4)).toBeUndefined();
  });

  it("虚线与点线按线宽成比例，缩放时看起来一致", () => {
    expect(dashArray("dashed", 2)).not.toEqual(dashArray("dashed", 10));
    expect(dashArray("dotted", 4)).toMatch(/^\d/u);
  });

  it("填充三档：无 / 半透明 / 实心", () => {
    expect(fillOpacity("none")).toBe(0);
    expect(fillOpacity(undefined)).toBe(0);
    expect(fillOpacity("semi")).toBeGreaterThan(0);
    expect(fillOpacity("semi")).toBeLessThan(1);
    expect(fillOpacity("solid")).toBe(1);
  });
});
