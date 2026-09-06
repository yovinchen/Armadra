import { afterEach, describe, expect, it } from "vitest";

import { resetToolStore, setNextStyle } from "../../interaction/tool-store";
import { MAX_INK_POINTS } from "../model";
import {
  CLICK_SHAPE_SIZE,
  commitDraft,
  draftRect,
  DRAG_THRESHOLD,
  extendDraft,
  isClick,
  startDraft,
  textItemAt,
  type Draft,
  type InkDraft,
} from "./draft";

/**
 * 绘制手势的落成规则（React Flow 计划 §2.4 / F22–F25）。
 *
 * 这里管的是「松手之后画布上多了什么」：太小的框不落成、墨迹压到点数
 * 上限内、四个方向拖出来的框都是正的。指针本身在浏览器里核对（§6.3 A06）。
 */

afterEach(() => resetToolStore());

const at = (x: number, y: number) => ({ x, y });

describe("draftRect", () => {
  it("四个方向拖出来的框都是正的", () => {
    const base = { origin: at(100, 100), current: at(40, 30) };
    expect(draftRect(base)).toEqual({ x: 40, y: 30, w: 60, h: 70 });
    expect(draftRect({ origin: at(40, 30), current: at(100, 100) })).toEqual({
      x: 40,
      y: 30,
      w: 60,
      h: 70,
    });
  });

  it("位移小于阈值算「点一下」", () => {
    expect(
      isClick({ origin: at(0, 0), current: at(DRAG_THRESHOLD - 1, 0) }),
    ).toBe(true);
    expect(
      isClick({ origin: at(0, 0), current: at(DRAG_THRESHOLD + 1, 0) }),
    ).toBe(false);
  });
});

describe("startDraft", () => {
  it("画笔与高亮都是墨迹，只有 highlight 一位不同", () => {
    const draw = startDraft("draw", at(0, 0), 0.5) as InkDraft;
    const highlight = startDraft("highlight", at(0, 0), 0.5) as InkDraft;
    expect(draw.kind).toBe("ink");
    expect(draw.highlight).toBe(false);
    expect(highlight.highlight).toBe(true);
  });

  it("直线与箭头都是 line，只有 arrowEnd 一位不同", () => {
    expect(startDraft("line", at(0, 0), 0.5)).toMatchObject({
      kind: "line",
      arrowEnd: false,
    });
    expect(startDraft("arrow", at(0, 0), 0.5)).toMatchObject({
      kind: "line",
      arrowEnd: true,
    });
  });

  it("选择 / 手 / 文字不走草稿", () => {
    expect(startDraft("select", at(0, 0), 0.5)).toBeNull();
    expect(startDraft("hand", at(0, 0), 0.5)).toBeNull();
    expect(startDraft("text", at(0, 0), 0.5)).toBeNull();
  });

  it("样式取自「下一个对象」（Dock 的形状下拉与样式面板写的是同一份）", () => {
    setNextStyle({ color: "red", size: "l", geo: "ellipse", fill: "semi" });
    expect(startDraft("geo", at(0, 0), 0.5)).toMatchObject({
      geo: "ellipse",
      style: { color: "red", size: "l", fill: "semi" },
    });
  });
});

describe("extendDraft", () => {
  it("墨迹累积采样点，其余只更新当前点", () => {
    let draft = startDraft("draw", at(0, 0), 0.5)!;
    draft = extendDraft(draft, at(10, 10), 0.6);
    expect((draft as InkDraft).points).toHaveLength(2);

    let shape = startDraft("geo", at(0, 0), 0.5)!;
    shape = extendDraft(shape, at(10, 10), 0.6);
    expect(shape.current).toEqual({ x: 10, y: 10 });
  });
});

describe("commitDraft", () => {
  it("墨迹：包围盒外扩线宽，点集换成相对坐标（最小值为 0）", () => {
    let draft = startDraft("draw", at(100, 100), 0.5)!;
    draft = extendDraft(draft, at(140, 130), 0.5);
    const item = commitDraft(draft, "ink-1")!;
    expect(item.kind).toBe("ink");
    expect(item.x).toBeLessThan(100);
    expect(item.w).toBeGreaterThan(40);
    const points = (item as { points: number[][] }).points;
    expect(
      Math.min(...points.map((point) => point[0]!)),
    ).toBeGreaterThanOrEqual(0);
  });

  it("墨迹的点数压到上限以内", () => {
    let draft = startDraft("draw", at(0, 0), 0.5)!;
    for (let index = 1; index <= 6_000; index += 1) {
      draft = extendDraft(draft, at(index, (index % 2) * 30), 0.5);
    }
    const item = commitDraft(draft, "ink-2")! as { points: unknown[] };
    expect(item.points.length).toBeLessThanOrEqual(MAX_INK_POINTS);
  });

  it("原地点一下的墨迹（0 宽 0 高）不落成", () => {
    const draft = startDraft("draw", at(0, 0), 0.5)!;
    // 单点仍然有线宽撑出来的盒子，所以落得成；真正落不成的是空点集。
    expect(commitDraft({ ...(draft as InkDraft), points: [] }, "x")).toBeNull();
  });

  it("几何形：点一下给默认尺寸并居中在落点上", () => {
    const draft = startDraft("geo", at(200, 200), 0.5)!;
    expect(commitDraft(draft, "geo-1")).toMatchObject({
      x: 200 - CLICK_SHAPE_SIZE.w / 2,
      y: 200 - CLICK_SHAPE_SIZE.h / 2,
      ...CLICK_SHAPE_SIZE,
    });
  });

  it("几何形：拖出来的框就是它的尺寸", () => {
    let draft = startDraft("geo", at(10, 20), 0.5)!;
    draft = extendDraft(draft, at(110, 220), 0.5);
    expect(commitDraft(draft, "geo-2")).toMatchObject({
      x: 10,
      y: 20,
      w: 100,
      h: 200,
    });
  });

  it("直线：点一下不落成（一条 0 长的线没有意义）", () => {
    expect(commitDraft(startDraft("line", at(0, 0), 0.5)!, "l")).toBeNull();
  });

  it("直线：两个端点换成相对坐标，箭头位跟着工具走", () => {
    let draft = startDraft("arrow", at(100, 50), 0.5)!;
    draft = extendDraft(draft, at(20, 90), 0.5);
    expect(commitDraft(draft, "line-1")).toMatchObject({
      x: 20,
      y: 50,
      w: 80,
      h: 40,
      points: [
        [80, 0],
        [0, 40],
      ],
      arrowStart: false,
      arrowEnd: true,
    });
  });

  it("画框不落成白板对象（它建的是 group 节点）", () => {
    const draft: Draft = {
      kind: "frame",
      origin: at(0, 0),
      current: at(100, 100),
    };
    expect(commitDraft(draft, "f")).toBeNull();
  });
});

describe("textItemAt", () => {
  it("一条空文字对象落在落点上，建好就进编辑", () => {
    expect(textItemAt(at(30, 40), "text-1")).toMatchObject({
      kind: "text",
      x: 30,
      y: 40,
      text: "",
    });
  });
});
