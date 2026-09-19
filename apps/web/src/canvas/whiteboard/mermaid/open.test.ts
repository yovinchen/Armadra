import { beforeEach, describe, expect, it } from "vitest";

import {
  closeMermaidImport,
  getMermaidDialog,
  openMermaidImport,
  resetMermaidDialog,
} from "./open";

/**
 * 导入对话框的开关（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §4.2）。
 *
 * 四个入口共用这一份状态，所以「带进来的预填文本与落点必须原样留住」
 * 是这里唯一要钉的事——粘贴那条路全靠它把剪贴板内容递进对话框。
 */

beforeEach(resetMermaidDialog);

describe("openMermaidImport", () => {
  it("默认打开一个空的对话框，落点交给视口中心", () => {
    openMermaidImport();
    expect(getMermaidDialog()).toEqual({ open: true, text: "", at: null });
  });

  it("预填文本与落点原样留住（粘贴与拖放靠它传内容）", () => {
    const at = { x: 12, y: -34 };
    openMermaidImport({ text: "flowchart LR\n A-->B", at });
    const state = getMermaidDialog();
    expect(state.open).toBe(true);
    expect(state.text).toBe("flowchart LR\n A-->B");
    expect(state.at).toEqual(at);
  });

  it("再开一次会换掉上一次的内容，不残留", () => {
    openMermaidImport({ text: "first", at: { x: 1, y: 1 } });
    openMermaidImport({ text: "second" });
    expect(getMermaidDialog().text).toBe("second");
    expect(getMermaidDialog().at).toBeNull();
  });
});

describe("closeMermaidImport", () => {
  it("关掉之后文本与落点一起清空", () => {
    openMermaidImport({ text: "x", at: { x: 1, y: 2 } });
    closeMermaidImport();
    expect(getMermaidDialog()).toEqual({ open: false, text: "", at: null });
  });

  it("本来就关着时是空操作", () => {
    const before = getMermaidDialog();
    closeMermaidImport();
    expect(getMermaidDialog()).toBe(before);
  });
});
