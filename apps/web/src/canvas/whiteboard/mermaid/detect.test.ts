import { describe, expect, it } from "vitest";

import {
  firstMeaningfulLine,
  isMermaidFileName,
  looksLikeMermaid,
  MAX_MERMAID_TEXT,
} from "./detect";

/**
 * 粘贴识别（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §4.3）。
 *
 * 这条判据决定「粘贴一段文本时要不要弹导入框」。宁可漏也不可滥：命中之后
 * 走的是确认对话框，所以误判的代价是多一次点击；但如果 `graph` 开头的散文
 * 被当成图**直接落地**，用户的文本就没了——所以这一层只负责「值得问一句」。
 */

describe("firstMeaningfulLine", () => {
  it("跳过空行、`%%` 注释与 `%%{init}%%` 指令块", () => {
    const text = `
%%{init: {"theme":"dark"}}%%
%% 这是一条注释

flowchart LR
  A --> B`;
    expect(firstMeaningfulLine(text)).toBe("flowchart LR");
  });

  it("跳过 Markdown 的 ```mermaid 围栏", () => {
    expect(firstMeaningfulLine("```mermaid\ngraph TD\n A-->B\n```")).toBe(
      "graph TD",
    );
  });

  it("全是空白时返回空串", () => {
    expect(firstMeaningfulLine("\n  \n\t\n")).toBe("");
  });
});

describe("looksLikeMermaid 正样本", () => {
  const positives = [
    "graph TD\n A --> B",
    "flowchart LR\n A --> B",
    "sequenceDiagram\n Alice->>Bob: hi",
    "classDiagram\n class A",
    "stateDiagram-v2\n [*] --> S",
    "stateDiagram\n [*] --> S",
    "erDiagram\n A ||--o{ B : has",
    "gantt\n title x",
    "pie\n title x",
    "mindmap\n root",
    "timeline\n title x",
    "journey\n title x",
    "gitGraph\n commit",
    "quadrantChart\n title x",
    "C4Context\n title x",
    "%%{init: {}}%%\nflowchart TD\n A-->B",
    "  \n\ngraph LR\n A-->B",
  ];

  it.each(positives)("认得出 %j", (text) => {
    expect(looksLikeMermaid(text)).toBe(true);
  });
});

describe("looksLikeMermaid 反样本", () => {
  const negatives = [
    "",
    "   ",
    "hello world",
    // 关键字必须是整词：`graphql` 与 `piece` 不算。
    "graphql query { a }",
    "pieces of the puzzle",
    "flowcharts are great",
    "const graph = new Graph()",
    // 关键字不在首个有意义的行上。
    "some prose\nflowchart LR\n A --> B",
    '{"kind":"armadra/canvas@1"}',
    "# Markdown 标题\n\n正文",
  ];

  it.each(negatives)("不认 %j", (text) => {
    expect(looksLikeMermaid(text)).toBe(false);
  });

  it("null / undefined 安全", () => {
    expect(looksLikeMermaid(null)).toBe(false);
    expect(looksLikeMermaid(undefined)).toBe(false);
  });

  it("超长文本一律不认（把日志粘进来时不该弹框）", () => {
    expect(looksLikeMermaid(`graph TD\n${"x".repeat(MAX_MERMAID_TEXT)}`)).toBe(
      false,
    );
  });
});

describe("isMermaidFileName", () => {
  it("认 .mmd 与 .mermaid，大小写无关", () => {
    expect(isMermaidFileName("chart.mmd")).toBe(true);
    expect(isMermaidFileName("chart.MERMAID")).toBe(true);
    expect(isMermaidFileName("/a/b/c.mmd")).toBe(true);
  });

  it("不认其它扩展名与无扩展名", () => {
    expect(isMermaidFileName("chart.md")).toBe(false);
    expect(isMermaidFileName("mmd")).toBe(false);
    expect(isMermaidFileName(".mmd")).toBe(false);
  });
});
