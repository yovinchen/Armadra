import { afterEach, describe, expect, it, vi } from "vitest";

import { onFileDrop, type FileDropPosition } from "./index";

/**
 * 系统级拖放的 Electron 那一半。
 *
 * 这条路和 Tauri 那条**口径不同**，所以值得钉住：Electron 收到的是普通的
 * DOM `drop`，`clientX/Y` 已经是 CSS 像素（Tauri 给的是物理设备像素，要按
 * `devicePixelRatio` 换算），绝对路径由 `window.armadra.pathForFile(file)`
 * 取而不是由事件带过来。测试里把两点都验一遍：换算别又被加回来，拿不到
 * 路径的 File 别被当成路径喂给 Runtime。
 */

type Bridge = { pathForFile: (file: File) => string };

function installBridge(pathForFile: (file: File) => string): void {
  (window as { armadra?: Bridge }).armadra = { pathForFile };
}

/** jsdom 的 DragEvent 没有 dataTransfer，自己造一个够用的。 */
function dropEvent(files: File[], at: { x: number; y: number }): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { files, types: ["Files"] } },
    clientX: { value: at.x },
    clientY: { value: at.y },
  });
  return event;
}

function file(name: string): File {
  return new File(["x"], name);
}

afterEach(() => {
  delete (window as { armadra?: Bridge }).armadra;
  vi.restoreAllMocks();
});

describe("onFileDrop in the Electron shell", () => {
  it("取绝对路径，落点直接用 CSS 像素", () => {
    installBridge((dropped) => `/Users/me/${dropped.name}`);
    // 换算被删掉了：一个 2x 屏上再除一次 ratio 会让落点跑到左上角去。
    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });
    const seen: { paths: string[]; at: FileDropPosition }[] = [];
    const stop = onFileDrop((paths, at) => seen.push({ paths, at }));

    window.dispatchEvent(
      dropEvent([file("a.md"), file("b.png")], { x: 300, y: 120 }),
    );

    expect(seen).toEqual([
      {
        paths: ["/Users/me/a.md", "/Users/me/b.png"],
        at: { x: 300, y: 120 },
      },
    ]);
    stop();
  });

  it("退订之后不再收", () => {
    installBridge((dropped) => `/tmp/${dropped.name}`);
    const seen: string[][] = [];
    const stop = onFileDrop((paths) => seen.push(paths));
    stop();
    window.dispatchEvent(dropEvent([file("a.md")], { x: 1, y: 1 }));
    expect(seen).toEqual([]);
  });

  it("拿不到路径的 File 不进这条路", () => {
    // 浏览器节点里生成的 Blob 没有磁盘路径；把空串当路径交给 Runtime 就是
    // 一次必然失败的打开。这类拖放归画布自己的 DataTransfer 分支。
    installBridge(() => {
      throw new Error("no path for a blob");
    });
    const seen: string[][] = [];
    const stop = onFileDrop((paths) => seen.push(paths));
    window.dispatchEvent(dropEvent([file("blob")], { x: 5, y: 5 }));
    expect(seen).toEqual([]);
    stop();
  });

  it("没有文件的拖放不触发", () => {
    installBridge((dropped) => `/tmp/${dropped.name}`);
    const seen: string[][] = [];
    const stop = onFileDrop((paths) => seen.push(paths));
    window.dispatchEvent(dropEvent([], { x: 5, y: 5 }));
    expect(seen).toEqual([]);
    stop();
  });

  it("不在壳里时什么也不订阅", () => {
    const seen: string[][] = [];
    const stop = onFileDrop((paths) => seen.push(paths));
    window.dispatchEvent(dropEvent([file("a.md")], { x: 5, y: 5 }));
    expect(seen).toEqual([]);
    stop();
  });
});
