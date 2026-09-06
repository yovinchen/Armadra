import { describe, expect, it } from "vitest";

import { COMMANDS } from "./commands";
import { keybindingContext, SCOPE_ATTRIBUTE } from "./context";
import {
  evaluateWhen,
  isValidWhen,
  WHEN_KEYS,
  whenContexts,
  whenOverlaps,
  whenReferences,
  type WhenContext,
} from "./when";

const editor: WhenContext = {
  platform: "mac",
  terminalFocus: false,
  editorFocus: true,
  browserFocus: false,
  canvasFocus: false,
  editing: true,
};
const canvas: WhenContext = {
  platform: "windows",
  terminalFocus: false,
  editorFocus: false,
  browserFocus: false,
  canvasFocus: true,
  editing: false,
};

describe("when 表达式", () => {
  it("没有条件就是处处成立", () => {
    for (const empty of [undefined, "", "   "]) {
      expect(evaluateWhen(empty, editor)).toBe(true);
      expect(isValidWhen(empty)).toBe(true);
    }
  });

  it("认识标识符、取反、与、或与括号", () => {
    expect(evaluateWhen("editorFocus", editor)).toBe(true);
    expect(evaluateWhen("editorFocus", canvas)).toBe(false);
    expect(evaluateWhen("!editorFocus", canvas)).toBe(true);
    expect(evaluateWhen("canvasFocus && !editing", canvas)).toBe(true);
    expect(evaluateWhen("canvasFocus && !editing", editor)).toBe(false);
    expect(evaluateWhen("editorFocus || canvasFocus", canvas)).toBe(true);
    // && 比 || 紧：`a || b && c` 是 `a || (b && c)`。
    expect(evaluateWhen("canvasFocus || editorFocus && editing", canvas)).toBe(
      true,
    );
    expect(
      evaluateWhen("(canvasFocus || editorFocus) && editing", canvas),
    ).toBe(false);
  });

  it("比较的是短字符串，两边都能写", () => {
    expect(evaluateWhen("platform == mac", editor)).toBe(true);
    expect(evaluateWhen("platform == mac", canvas)).toBe(false);
    expect(evaluateWhen("platform != mac", canvas)).toBe(true);
    expect(evaluateWhen("editorFocus && platform == mac", editor)).toBe(true);
  });

  /**
   * 这一条是整个求值器最重要的性质：看不懂的条件让绑定**不生效**。
   * 反过来（当成真）会让一条写坏的条件在所有地方抢键。
   */
  it("语法错误一律为假，而不是一律为真", () => {
    for (const broken of [
      "editorFocus &&",
      "&& editorFocus",
      "(editorFocus",
      "editorFocus)",
      "platform ==",
      "platform == 'mac'",
      "editorFocus canvasFocus",
      "editorFocus @ canvasFocus",
      "!",
    ]) {
      expect(evaluateWhen(broken, editor), broken).toBe(false);
      expect(isValidWhen(broken), broken).toBe(false);
    }
  });

  it("没听说过的键求值为假，不会静默变成真", () => {
    expect(evaluateWhen("zenMode", editor)).toBe(false);
    expect(evaluateWhen("editorFocus && zenMode", editor)).toBe(false);
    // 但语法本身是对的，所以设置页要报的是「未知的键」而不是「写错了」。
    expect(isValidWhen("editorFocus && zenMode")).toBe(true);
    expect(whenReferences("editorFocus && zenMode").sort()).toEqual([
      "editorFocus",
      "zenMode",
    ]);
    expect(whenReferences("platform == mac")).toEqual(["platform"]);
  });

  it("穷举的上下文覆盖每一个已知键，且焦点互斥", () => {
    const contexts = whenContexts();
    for (const key of WHEN_KEYS)
      expect(
        contexts.some((context) => context[key] !== undefined),
        key,
      ).toBe(true);
    for (const context of contexts) {
      const focused = [
        "terminalFocus",
        "editorFocus",
        "browserFocus",
        "canvasFocus",
      ].filter((key) => context[key] === true);
      // 焦点同一时刻只有一处（或哪儿都不是）。
      expect(focused.length).toBeLessThanOrEqual(1);
    }
    // 「哪儿都不在焦点」也要在里面：一条 `!editorFocus` 的绑定在那种情况下
    // 也会触发，冲突检测必须看得到。
    expect(
      contexts.some((context) =>
        ["terminalFocus", "editorFocus", "browserFocus", "canvasFocus"].every(
          (key) => context[key] === false,
        ),
      ),
    ).toBe(true);
  });

  it("互斥的条件不算冲突，能同时成立的才算", () => {
    expect(whenOverlaps("editorFocus", "browserFocus")).toBe(false);
    expect(whenOverlaps("editorFocus", "!editorFocus")).toBe(false);
    expect(whenOverlaps("platform == mac", "platform == linux")).toBe(false);
    // 一边有条件、另一边没有：没条件的那条在编辑器里也生效，所以会撞。
    expect(whenOverlaps("editorFocus", undefined)).toBe(true);
    expect(whenOverlaps(undefined, undefined)).toBe(true);
    expect(whenOverlaps("editorFocus", "editing")).toBe(true);
    expect(whenOverlaps("editorFocus && platform == mac", "editorFocus")).toBe(
      true,
    );
    // 一条写坏的条件哪儿都不成立，因此和谁都不冲突。
    expect(whenOverlaps("editorFocus &&", undefined)).toBe(false);
  });

  it("命令表里的每条 when 都写得对，且只用已知的键", () => {
    for (const command of COMMANDS) {
      const when = "when" in command ? command.when : undefined;
      expect(isValidWhen(when), command.id).toBe(true);
      for (const key of whenReferences(when))
        expect(WHEN_KEYS as readonly string[], command.id).toContain(key);
    }
  });
});

describe("焦点上下文", () => {
  function contextFor(html: string, selector: string, mac = true) {
    document.body.innerHTML = html;
    const target = document.querySelector(selector);
    return keybindingContext({ target, mac });
  }

  it("终端优先于「正在打字」", () => {
    // xterm 的输入面就是一个 textarea，两边都成立；终端赢。
    const context = contextFor(
      `<div class="xterm"><textarea id="t"></textarea></div>`,
      "#t",
    );
    expect(context.terminalFocus).toBe(true);
    expect(context.editing).toBe(false);
    expect(context.canvasFocus).toBe(false);
  });

  it("节点作用域从 data 属性读出来", () => {
    const inEditor = contextFor(
      `<div ${SCOPE_ATTRIBUTE}="editor"><div contenteditable="true" id="c"></div></div>`,
      "#c",
    );
    expect(inEditor.editorFocus).toBe(true);
    expect(inEditor.editing).toBe(true);
    expect(inEditor.browserFocus).toBe(false);

    const inBrowser = contextFor(
      `<div ${SCOPE_ATTRIBUTE}="browser"><textarea id="k"></textarea></div>`,
      "#k",
    );
    expect(inBrowser.browserFocus).toBe(true);
    expect(inBrowser.editorFocus).toBe(false);

    // 认不出来的值不会变成某个作用域。
    const unknown = contextFor(
      `<div ${SCOPE_ATTRIBUTE}="whatever"><textarea id="k"></textarea></div>`,
      "#k",
    );
    expect(unknown.editorFocus).toBe(false);
    expect(unknown.browserFocus).toBe(false);
  });

  it("画布是「哪儿都不在」，一个普通输入框不是", () => {
    expect(contextFor(`<div id="c"></div>`, "#c").canvasFocus).toBe(true);
    const input = contextFor(`<input id="i" />`, "#i");
    expect(input.editing).toBe(true);
    expect(input.canvasFocus).toBe(false);
  });

  it("平台名跟着 mac 判定走", () => {
    expect(contextFor(`<div id="c"></div>`, "#c", true).platform).toBe("mac");
    expect(contextFor(`<div id="c"></div>`, "#c", false).platform).toBe(
      "windows",
    );
  });
});
