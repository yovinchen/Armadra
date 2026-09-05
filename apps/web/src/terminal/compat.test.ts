import { describe, expect, it } from "vitest";

import {
  appChordsInTerminal,
  forgetOscTitle,
  keyDisposition,
  rememberOscTitle,
  shouldApplyOscTitle,
  shouldRefit,
  titleIsAuto,
  type KeyLike,
} from "./compat";

/* --------------------------------- fit 守卫 -------------------------------- */

describe("fit 守卫（§18.2 规则 2）", () => {
  const current = { cols: 120, rows: 30 };

  it("算出来的尺寸没变就不 fit、也不发 resize", () => {
    expect(shouldRefit({ cols: 120, rows: 30 }, current)).toBe(false);
  });

  it("亚像素抖动四舍五入之后落回同一组整数，也不 fit", () => {
    expect(shouldRefit({ cols: 120.4, rows: 29.6 }, current)).toBe(false);
    // 119.5 也 round 回 120：只有整数真的差一列时才算变化
    expect(shouldRefit({ cols: 119.5, rows: 30.2 }, current)).toBe(false);
    expect(shouldRefit({ cols: 119.4, rows: 30.2 }, current)).toBe(true);
  });

  it("真的变了才 fit", () => {
    expect(shouldRefit({ cols: 121, rows: 30 }, current)).toBe(true);
    expect(shouldRefit({ cols: 120, rows: 31 }, current)).toBe(true);
  });

  it("容器还没量出尺寸（null / 0 / NaN）时一律不动", () => {
    expect(shouldRefit(null, current)).toBe(false);
    expect(shouldRefit(undefined, current)).toBe(false);
    expect(shouldRefit({ cols: 0, rows: 0 }, current)).toBe(false);
    expect(shouldRefit({ cols: Number.NaN, rows: 30 }, current)).toBe(false);
  });
});

/* -------------------------------- 按键策略 -------------------------------- */

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    type: "keydown",
    ...partial,
  };
}

describe("按键策略（§18.3 键盘行）", () => {
  const chords = appChordsInTerminal(undefined, true);
  const plain = { mac: true, hasSelection: false };
  const selected = { mac: true, hasSelection: true };

  it("注册表里 allowInTerminal 的壳级快捷键归应用", () => {
    const app: KeyLike[] = [
      key({ key: "k", metaKey: true }), // ⌘K 命令面板
      key({ key: ",", metaKey: true }), // ⌘, 设置
      key({ key: "L", metaKey: true, shiftKey: true }), // ⌘⇧L 会话
      key({ key: "E", metaKey: true, shiftKey: true }), // ⌘⇧E 资源管理器
      key({ key: "G", metaKey: true, shiftKey: true }), // ⌘⇧G 源代码管理
      key({ key: "w", metaKey: true }), // ⌘W 原生关闭窗口
      key({ key: "q", metaKey: true }), // ⌘Q 原生退出
      key({ key: "f", metaKey: true }), // ⌘F 终端搜索
    ];
    for (const event of app) {
      expect(keyDisposition(event, plain, chords)).toBe("app");
    }
  });

  it("Windows CtrlQ继续送往CLI", () => {
    expect(
      keyDisposition(
        key({ key: "q", ctrlKey: true }),
        { mac: false, hasSelection: false },
        new Set(),
      ),
    ).toBe("terminal");
  });

  it("其余组合键一律进终端", () => {
    const terminal: KeyLike[] = [
      key({ key: "c", ctrlKey: true }), // Ctrl+C
      key({ key: "z", ctrlKey: true }),
      key({ key: "d", ctrlKey: true }),
      key({ key: "r", ctrlKey: true }),
      key({ key: "ArrowUp" }),
      key({ key: "ArrowLeft", shiftKey: true }),
      key({ key: "F5" }),
      key({ key: "F12" }),
      key({ key: "Home" }),
      key({ key: "End" }),
      key({ key: "Tab" }),
      key({ key: "Escape" }),
      // 画布快捷键：allowInTerminal=false，所以焦点在终端里就归终端
      key({ key: "t", metaKey: true }),
      key({ key: "z", metaKey: true }),
      key({ key: "Backspace" }),
    ];
    for (const event of terminal) {
      expect(keyDisposition(event, plain, chords)).toBe("terminal");
    }
  });

  it("⌘C 只在有选区时是复制，否则进终端（SIGINT 路径不能被抢）", () => {
    const copy = key({ key: "c", metaKey: true });
    expect(keyDisposition(copy, selected, chords)).toBe("copy");
    expect(keyDisposition(copy, plain, chords)).toBe("terminal");
  });

  it("⌘V 永远是粘贴", () => {
    const paste = key({ key: "v", metaKey: true });
    expect(keyDisposition(paste, plain, chords)).toBe("paste");
    expect(keyDisposition(paste, selected, chords)).toBe("paste");
  });

  it("非 mac 上主键是 Ctrl+Shift，Ctrl+C 仍然进终端", () => {
    const other = appChordsInTerminal(undefined, false);
    const context = { mac: false, hasSelection: true };
    expect(
      keyDisposition(key({ key: "c", ctrlKey: true }), context, other),
    ).toBe("terminal");
    expect(
      keyDisposition(
        key({ key: "c", ctrlKey: true, shiftKey: true }),
        context,
        other,
      ),
    ).toBe("copy");
    expect(
      keyDisposition(key({ key: "k", ctrlKey: true }), context, other),
    ).toBe("app");
  });

  it("输入法合成中的按键永远进终端", () => {
    expect(keyDisposition(key({ key: "Process" }), plain, chords)).toBe(
      "terminal",
    );
    expect(keyDisposition(key({ key: "Unidentified" }), plain, chords)).toBe(
      "terminal",
    );
  });
});

/* --------------------------------- 标题 ----------------------------------- */

describe("OSC 标题（§18.3 标题行）", () => {
  const defaults = ["终端", "Claude Code"];

  it("还是默认名时算自动", () => {
    expect(titleIsAuto("终端", defaults)).toBe(true);
    expect(titleIsAuto("Claude Code", defaults)).toBe(true);
    expect(titleIsAuto("", defaults)).toBe(true);
    expect(titleIsAuto("我的构建", defaults)).toBe(false);
  });

  it("用户改过名之后 OSC 不再覆盖", () => {
    forgetOscTitle("node-1");
    expect(shouldApplyOscTitle("node-1", "终端", defaults)).toBe(true);
    expect(shouldApplyOscTitle("node-1", "我的构建", defaults)).toBe(false);
  });

  it("OSC 自己写过的标题可以被下一条 OSC 继续更新", () => {
    forgetOscTitle("node-2");
    rememberOscTitle("node-2", "vim README.md");
    expect(shouldApplyOscTitle("node-2", "vim README.md", defaults)).toBe(true);
    // 用户在那之后又手动改了名
    expect(shouldApplyOscTitle("node-2", "别动我", defaults)).toBe(false);
  });

  it("这份记忆写进 localStorage，刷新之后 OSC 还能继续跟随标题", () => {
    // 这个测试环境是 node，没有 localStorage：源码里是 `?.` 可选调用，
    // 所以补一份最小的实现就能把落盘那条路跑出来。
    const store = new Map<string, string>();
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    try {
      forgetOscTitle("node-3");
      rememberOscTitle("node-3", "pnpm dev");
      const read = () =>
        JSON.parse(store.get("armadra.oscTitles") ?? "{}") as Record<
          string,
          string
        >;
      expect(read()["node-3"]).toBe("pnpm dev");
      // 忘掉之后也要落盘，否则重开又「记得」一个早就删掉的节点
      forgetOscTitle("node-3");
      expect(read()["node-3"]).toBeUndefined();
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});
