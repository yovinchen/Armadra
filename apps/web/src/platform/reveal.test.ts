import { afterEach, describe, expect, it, vi } from "vitest";

import { openExternal, revealPath } from "./index";

/**
 * 「显示数据目录」那条路的两端。
 *
 * 以前它是 `openExternal("file://…")`：壳的 scheme 白名单只认 http/https，
 * 所以那个按钮**必然**失败，而且失败被 `console.error` 吞掉，用户点下去
 * 什么也不发生。这里钉住的是修好之后的两件事——壳里走自己的那条通道，
 * 浏览器里退回剪贴板——以及失败能被调用处看见。
 */

function installBridge(shell: Record<string, unknown>): void {
  Object.defineProperty(window, "armadra", {
    value: { shell },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    "armadra",
  );
  vi.restoreAllMocks();
});

describe("revealPath", () => {
  it("在壳里走 show-item-in-folder，而不是 file:// 外链", async () => {
    const showItemInFolder = vi.fn(async () => ({ ok: true }));
    const openExternalSpy = vi.fn(async () => undefined);
    installBridge({ showItemInFolder, openExternal: openExternalSpy });

    await expect(revealPath("/data/Armadra")).resolves.toBe("revealed");
    expect(showItemInFolder).toHaveBeenCalledWith("/data/Armadra");
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it("壳拒绝时报 failed，调用处才有东西可提示", async () => {
    installBridge({
      showItemInFolder: vi.fn(async () => {
        throw new Error("path_not_allowed: nope");
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(revealPath("/etc/passwd")).resolves.toBe("failed");
  });

  it("浏览器里把路径复制到剪贴板", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await expect(revealPath("/data/Armadra")).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith("/data/Armadra");
  });

  it("剪贴板也用不了就是 failed", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
      configurable: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(revealPath("/data/Armadra")).resolves.toBe("failed");
  });
});

describe("openExternal", () => {
  it("壳按 scheme 白名单拒绝时返回 false", async () => {
    installBridge({
      openExternal: vi.fn(async () => {
        throw new Error("scheme_not_allowed: only http and https");
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(openExternal("file:///data")).resolves.toBe(false);
  });

  it("打开成功返回 true", async () => {
    installBridge({ openExternal: vi.fn(async () => undefined) });
    await expect(openExternal("https://example.test")).resolves.toBe(true);
  });
});
