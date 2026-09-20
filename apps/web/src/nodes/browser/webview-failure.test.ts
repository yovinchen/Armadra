import { describe, expect, it } from "vitest";

import {
  ERR_ABORTED,
  failureKind,
  failureOf,
  snapshotDataUrl,
} from "./webview";

/**
 * 加载失败与占位图。
 *
 * 单独一个文件而不是并进 `webview.test.ts`：那一份测的是「这行输入是网址
 * 还是搜索词」与导航门，判定对象是字符串；这一份的判定对象是 guest 的生命
 * 周期事件，两组之间没有共享的 fixture。
 */

describe("failureOf", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    errorCode: -105,
    errorDescription: "ERR_NAME_NOT_RESOLVED",
    validatedURL: "https://nope.test/",
    isMainFrame: true,
    ...over,
  });

  it("主框架的真失败变成一条记录", () => {
    expect(failureOf(event())).toEqual({
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
      url: "https://nope.test/",
    });
  });

  it("子框架失败不是这一页的失败", () => {
    // 一张图、一个广告 iframe 加载不出来，主页面照样是好的。
    expect(failureOf(event({ isMainFrame: false }))).toBeNull();
  });

  it("ERR_ABORTED 不是失败", () => {
    // 按停止、加载中途点了另一个链接、大量 SPA 的正常导航都报它。
    expect(failureOf(event({ errorCode: ERR_ABORTED }))).toBeNull();
    expect(failureOf(event({ errorCode: 0 }))).toBeNull();
    expect(failureOf(event({ errorCode: undefined }))).toBeNull();
  });

  it("没有地址就没有可画的错误页", () => {
    expect(failureOf(event({ validatedURL: "" }))).toBeNull();
    expect(failureOf(event({ validatedURL: undefined }))).toBeNull();
  });
});

describe("failureKind", () => {
  const of = (description: string) =>
    failureKind({ code: -1, description, url: "https://x.test/" });

  it("断网与域名解析不了都是「连不上」", () => {
    expect(of("ERR_INTERNET_DISCONNECTED")).toBe("offline");
    expect(of("ERR_NAME_NOT_RESOLVED")).toBe("offline");
    expect(of("ERR_ADDRESS_UNREACHABLE")).toBe("offline");
  });

  it("证书类单独一句：人要做的事不一样", () => {
    expect(of("ERR_CERT_AUTHORITY_INVALID")).toBe("certificate");
    expect(of("ERR_SSL_PROTOCOL_ERROR")).toBe("certificate");
  });

  it("连上了但对方不响应", () => {
    expect(of("ERR_CONNECTION_REFUSED")).toBe("notFound");
    expect(of("ERR_CONNECTION_TIMED_OUT")).toBe("notFound");
    expect(of("ERR_EMPTY_RESPONSE")).toBe("notFound");
  });

  it("认不出来的不硬猜", () => {
    expect(of("ERR_BLOCKED_BY_CLIENT")).toBe("unknown");
    expect(of("")).toBe("unknown");
  });
});

describe("snapshotDataUrl", () => {
  const small = {
    isEmpty: () => false,
    resize: () => small,
    toDataURL: () => "data:image/png;base64,SMALL",
  };
  const image = (over: Record<string, unknown> = {}) => ({
    isEmpty: () => false,
    resize: () => small,
    toDataURL: () => "data:image/png;base64,BIG",
    ...over,
  });

  it("缩到固定宽度再取 data URL", () => {
    // 原图是节点那么大，几百 KB 的字符串常驻在 state 里——回收的目的是省内
    // 存，占位图不能是新的内存问题。
    expect(snapshotDataUrl(image())).toBe("data:image/png;base64,SMALL");
  });

  it("空图不当占位", () => {
    // 已经停止绘制的 guest 会回一张 0×0 的图，贴上去是一块更难解释的空白。
    expect(snapshotDataUrl(image({ isEmpty: () => true }))).toBe("");
    expect(snapshotDataUrl(undefined)).toBe("");
  });

  it("拿不到就空串，不抛", () => {
    expect(
      snapshotDataUrl({
        isEmpty: () => false,
        resize: () => {
          throw new Error("gone");
        },
        toDataURL: () => "x",
      }),
    ).toBe("");
  });
});
