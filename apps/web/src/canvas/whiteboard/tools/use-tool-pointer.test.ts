import { afterEach, describe, expect, it } from "vitest";

import {
  getBaseSize,
  getNextStyle,
  resetToolStore,
  setDefaultStyle,
  setNextStyle,
  setTool,
} from "../../interaction/tool-store";
import { applyDynamicSize } from "./use-tool-pointer";

/**
 * 「动态尺寸」的档位推导（React Flow 计划 §2.10）。
 *
 * 2026-09-06 用户反馈：缩小画一笔变粗之后，回到 100% 仍停在粗档。原因是
 * 上一笔缩放出来的档位被当成了下一笔的输入，档位因此只升不降，偏好里的
 * 默认粗细被永久盖掉。下面每一条都盯着「基准是谁」。
 */

afterEach(() => resetToolStore());

const size = () => getNextStyle().size;

describe("applyDynamicSize", () => {
  it("缩小时按基准推一档，不吃自己上一次的结果", () => {
    setDefaultStyle({ color: "black", size: "m" });

    applyDynamicSize(true, 0.5);
    expect(size()).toBe("l");
    // 基准没被改写：同一个缩放再来一次还是同一档，不会继续往上爬。
    expect(getBaseSize()).toBe("m");
    applyDynamicSize(true, 0.5);
    expect(size()).toBe("l");
  });

  it("回到 100% 就退回偏好里的档位", () => {
    setDefaultStyle({ color: "black", size: "m" });
    applyDynamicSize(true, 0.25);
    expect(size()).toBe("xl");

    applyDynamicSize(true, 1);
    expect(size()).toBe("m");
  });

  it("关掉开关时把档位放回基准，而不是留着最后一次缩放的结果", () => {
    setDefaultStyle({ color: "black", size: "m" });
    applyDynamicSize(true, 0.5);
    expect(size()).toBe("l");

    applyDynamicSize(false, 0.5);
    expect(size()).toBe("m");
  });

  it("样式面板手动改的档位是新基准，直到下一次工具切换", () => {
    setDefaultStyle({ color: "black", size: "s" });
    setTool("draw");
    setNextStyle({ size: "l" });
    expect(getBaseSize()).toBe("l");

    applyDynamicSize(true, 2);
    expect(size()).toBe("s");
    applyDynamicSize(true, 1);
    expect(size()).toBe("l");

    setTool("geo");
    expect(getBaseSize()).toBe("s");
    expect(size()).toBe("s");
  });

  it("改偏好会重置手动档位", () => {
    setDefaultStyle({ color: "black", size: "m" });
    setNextStyle({ size: "xl" });
    expect(getBaseSize()).toBe("xl");

    setDefaultStyle({ color: "black", size: "s" });
    expect(getBaseSize()).toBe("s");
    expect(size()).toBe("s");
  });
});
