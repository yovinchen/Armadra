import { describe, expect, it } from "vitest";

import { browserPartition, isDesktopShell } from "./desktop";
import { allowGuestNavigation, searchOrUrl } from "./webview";

describe("isDesktopShell", () => {
  it("是 false，除非 preload 把 window.armadra 装上去了", () => {
    // jsdom 里没有壳。这一条同时钉住「浏览器与 Tauri 壳走旧路径」：判定为假
    // 时 `BrowserNode` 一个 `<webview>` 都不渲染。
    expect(isDesktopShell()).toBe(false);
    (window as unknown as { armadra?: unknown }).armadra = {};
    expect(isDesktopShell()).toBe(true);
    delete (window as unknown as { armadra?: unknown }).armadra;
  });
});

describe("browserPartition", () => {
  it("同一工作空间的用户节点共享一个 jar", () => {
    expect(browserPartition("ws-1", "user")).toBe(
      browserPartition("ws-1", "user"),
    );
    expect(browserPartition("ws-1", "user")).toBe(
      "persist:armadra-browser-ws-1",
    );
  });

  it("Agent 的 jar 与人的分开，跨工作空间也分开", () => {
    expect(browserPartition("ws-1", "agent")).toBe(
      "persist:armadra-agent-browser-ws-1",
    );
    expect(browserPartition("ws-1", "user")).not.toBe(
      browserPartition("ws-2", "user"),
    );
    expect(browserPartition("ws-1", "user")).not.toBe(
      browserPartition("ws-1", "agent"),
    );
  });

  it("全部带 persist: 前缀——关掉应用再开还是同一个登录态", () => {
    for (const driver of ["user", "agent"] as const) {
      expect(browserPartition(undefined, driver).startsWith("persist:")).toBe(
        true,
      );
    }
  });
});

describe("searchOrUrl", () => {
  it("带 scheme 的原样放行", () => {
    expect(searchOrUrl("https://github.com/x")).toBe("https://github.com/x");
    expect(searchOrUrl("  http://a.test/b  ")).toBe("http://a.test/b");
  });

  it("主机名形状补 https，localhost 与 IP 补 http", () => {
    expect(searchOrUrl("github.com")).toBe("https://github.com");
    expect(searchOrUrl("example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(searchOrUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(searchOrUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  });

  it("其余当搜索词——判定偏向搜索是有意的", () => {
    expect(searchOrUrl("rust async trait")).toContain("q=rust%20async%20trait");
    expect(searchOrUrl("todo")).toContain("duckduckgo");
  });

  it("空串什么都不做", () => {
    expect(searchOrUrl("   ")).toBe("");
  });
});

describe("allowGuestNavigation", () => {
  it("只放行 http(s) 与 about:blank", () => {
    expect(allowGuestNavigation("https://a.test")).toBe(true);
    expect(allowGuestNavigation("http://a.test")).toBe(true);
    expect(allowGuestNavigation("about:blank")).toBe(true);
  });

  it("file:// 一律拒——远程页面不能把 guest 导航到本地文件", () => {
    expect(allowGuestNavigation("file:///etc/passwd")).toBe(false);
    expect(allowGuestNavigation("file://localhost/etc/hosts")).toBe(false);
  });

  it("其余 scheme 与解析不出来的一律拒", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "chrome://settings",
      "armadra://x",
      "",
      "not a url",
    ]) {
      expect(allowGuestNavigation(url)).toBe(false);
    }
  });
});
