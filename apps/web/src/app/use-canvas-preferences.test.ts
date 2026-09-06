import { afterEach, describe, expect, it } from "vitest";

import {
  CANVAS_FOCUS_ATTRIBUTE,
  WHITEBOARD_BACKGROUND_COLORS,
  applyCanvasBackground,
  applyCanvasFocusMode,
  canvasBackgroundVars,
  canvasColorScheme,
  canvasDotColor,
  luminance,
} from "./use-canvas-preferences";
import { WHITEBOARD_BACKGROUNDS } from "./preferences/whiteboard";

/**
 * 画布偏好的单向映射（React Flow 计划 §2.10）。
 *
 * 旧引擎那份测试里一半是「editor 写回偏好」的防环断言，那条通道整条删了
 * （偏好现在是唯一真相）。留下的是真正的换算：底色 → 点阵色、底色 →
 * 明暗档、写根元素变量，加上新接的专注模式属性。
 */

afterEach(() => {
  applyCanvasBackground(null);
  applyCanvasFocusMode(false);
});

describe("背景色表", () => {
  it("除「跟随主题」外每一档都有色值", () => {
    for (const background of WHITEBOARD_BACKGROUNDS) {
      if (background === "theme") continue;
      expect(WHITEBOARD_BACKGROUND_COLORS[background]).toMatch(
        /^#[0-9a-f]{6}$/,
      );
    }
  });
});

describe("luminance", () => {
  it("纯黑 0、纯白 1", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("绿的权重最高（Rec. 709）", () => {
    expect(luminance("#00ff00")).toBeGreaterThan(luminance("#ff0000"));
    expect(luminance("#ff0000")).toBeGreaterThan(luminance("#0000ff"));
  });
});

describe("canvasDotColor", () => {
  it("亮底上的点往黑里压", () => {
    expect(luminance(canvasDotColor("#ffffff"))).toBeLessThan(
      luminance("#ffffff"),
    );
  });

  it("暗底上的点往白里提", () => {
    expect(luminance(canvasDotColor("#000000"))).toBeGreaterThan(
      luminance("#000000"),
    );
  });

  /** 暗底上的点更容易糊掉，所以提的比压的多一档（0.3 vs 0.2）。 */
  it("暗底提得比亮底压得多", () => {
    const lift = luminance(canvasDotColor("#000000"));
    const press = luminance("#ffffff") - luminance(canvasDotColor("#ffffff"));
    expect(lift).toBeGreaterThan(press);
  });
});

describe("canvasColorScheme", () => {
  it("「跟随主题」原样返回应用主题", () => {
    expect(canvasColorScheme("theme", "dark")).toBe("dark");
    expect(canvasColorScheme("theme", "light")).toBe("light");
  });

  /**
   * 墨色跟**底色**的明暗走，而不是跟应用主题走：深色应用里选「纸色」，
   * 画出来的线必须是深色的，否则在米白底上看不见。
   */
  it("固定底色时按底色的明暗定，与应用主题无关", () => {
    expect(canvasColorScheme("white", "dark")).toBe("light");
    expect(canvasColorScheme("paper", "dark")).toBe("light");
    expect(canvasColorScheme("black", "light")).toBe("dark");
    expect(canvasColorScheme("slate", "light")).toBe("dark");
  });
});

describe("canvasBackgroundVars", () => {
  it("「跟随主题」不写变量，落回 tokens.css", () => {
    expect(canvasBackgroundVars("theme")).toBeNull();
  });

  it("其余四档给出一对变量", () => {
    const vars = canvasBackgroundVars("black");
    expect(vars?.["--canvas-bg"]).toBe("#000000");
    expect(vars?.["--canvas-dot"]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("applyCanvasBackground", () => {
  it("写进根元素的内联样式，传 null 时清掉", () => {
    applyCanvasBackground(canvasBackgroundVars("white"));
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--canvas-bg")).toBe("#ffffff");
    applyCanvasBackground(null);
    expect(root.style.getPropertyValue("--canvas-bg")).toBe("");
    expect(root.style.getPropertyValue("--canvas-dot")).toBe("");
  });
});

describe("applyCanvasFocusMode", () => {
  /** 专注模式的显隐是 CSS 的事（`styles/canvas.css`），这里只管属性。 */
  it("开时在根元素上留一个属性，关时摘掉", () => {
    applyCanvasFocusMode(true);
    expect(document.documentElement.getAttribute(CANVAS_FOCUS_ATTRIBUTE)).toBe(
      "true",
    );
    applyCanvasFocusMode(false);
    expect(document.documentElement.hasAttribute(CANVAS_FOCUS_ATTRIBUTE)).toBe(
      false,
    );
  });
});
