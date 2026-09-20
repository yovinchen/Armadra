import { describe, expect, it } from "vitest";
import {
  MAX_FILES,
  MAX_QUOTE_CHARS,
  MAX_SUMMARY_BYTES,
  digestTranscript,
  renderSummary,
  stateLabel,
} from "./transcript-summary";

/** 一行 JSONL。 */
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function user(text: string): string {
  return line({ type: "user", message: { role: "user", content: text } });
}

function assistant(blocks: unknown[]): string {
  return line({
    type: "assistant",
    message: { role: "assistant", content: blocks },
  });
}

function tool(name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", name, input };
}

const FACTS = {
  title: "codex-1",
  handle: "codex-1",
  state: "busy",
  pendingApproval: false,
  origin: "转录文件 /tmp/t.jsonl",
} as const;

describe("摘要提取", () => {
  it("取最后一条人类提示与最后一条助手回复", () => {
    const text =
      user("第一件事") +
      assistant([{ type: "text", text: "先看看" }]) +
      user("第二件事") +
      assistant([{ type: "text", text: "做完了" }]);
    const digest = digestTranscript(text);
    expect(digest.lastUser).toBe("第二件事");
    expect(digest.lastAssistant).toBe("做完了");
    expect(digest.entries).toBe(4);
  });

  it("数工具调用，并抽出 file_path / path", () => {
    const text =
      assistant([
        tool("Read", { file_path: "/repo/a.ts" }),
        tool("Grep", { pattern: "x" }),
      ]) +
      assistant([tool("Edit", { path: "/repo/b.ts" })]) +
      assistant([tool("Read", { file_path: "/repo/a.ts" })]);
    const digest = digestTranscript(text);
    expect(digest.toolCalls).toBe(4);
    expect(digest.files).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it(`文件路径最多 ${MAX_FILES} 条，超出时说得出来`, () => {
    const blocks = Array.from({ length: MAX_FILES + 5 }, (_value, index) =>
      tool("Read", { file_path: `/repo/f${index}.ts` }),
    );
    const digest = digestTranscript(assistant(blocks));
    expect(digest.files.length).toBe(MAX_FILES);
    expect(digest.filesTruncated).toBe(true);
  });

  it("tool_result 的正文一个字都不带进来", () => {
    const huge = "x".repeat(50_000);
    const text = assistant([
      { type: "tool_result", content: [{ type: "text", text: huge }] },
    ]);
    const digest = digestTranscript(text);
    expect(digest.lastAssistant).toBeUndefined();
  });

  it(`长提示截到 ${MAX_QUOTE_CHARS} 个字符`, () => {
    const digest = digestTranscript(user("啊".repeat(2_000)));
    expect([...(digest.lastUser ?? "")].length).toBe(MAX_QUOTE_CHARS + 1);
    expect(digest.lastUser?.endsWith("…")).toBe(true);
  });

  it("认 Codex 的 {type, payload} 外壳", () => {
    const text = line({
      type: "response_item",
      payload: { type: "message", role: "user", content: "来自 Codex" },
    });
    expect(digestTranscript(text).lastUser).toBe("来自 Codex");
  });

  it("认整份 JSON 数组与 {messages: []}", () => {
    const array = JSON.stringify([{ role: "user", content: "数组" }]);
    expect(digestTranscript(array).lastUser).toBe("数组");
    const document = JSON.stringify({
      messages: [{ role: "assistant", content: "文档" }],
    });
    expect(digestTranscript(document).lastAssistant).toBe("文档");
  });

  it("认不出来的行跳过，不报错", () => {
    const text = `不是 JSON\n${user("有效")}{"half":\n`;
    expect(digestTranscript(text).lastUser).toBe("有效");
  });

  it("空转录给一份空摘要", () => {
    const digest = digestTranscript("");
    expect(digest.entries).toBe(0);
    expect(digest.files).toEqual([]);
    expect(digest.toolCalls).toBe(0);
  });
});

describe("摘要渲染", () => {
  it("头一行有名字、状态与来源", () => {
    const out = renderSummary(FACTS, digestTranscript(user("做点什么")));
    expect(out).toContain("「codex-1」");
    expect(out).toContain("名字=codex-1");
    expect(out).toContain(stateLabel("busy"));
    expect(out).toContain("转录文件 /tmp/t.jsonl");
  });

  it("有待审批时头一行说出来", () => {
    const out = renderSummary(
      { ...FACTS, pendingApproval: true },
      digestTranscript(""),
    );
    expect(out).toContain("待审批");
  });

  it("列出碰过的文件", () => {
    const out = renderSummary(
      FACTS,
      digestTranscript(assistant([tool("Read", { file_path: "/repo/a.ts" })])),
    );
    expect(out).toContain("/repo/a.ts");
    expect(out).toContain("工具调用 1 次");
  });

  /** 这是整件事的目的：一次读取不该再是十几万 token。 */
  it(`再长的转录，摘要也不超过 ${MAX_SUMMARY_BYTES} 字节`, () => {
    let text = "";
    for (let index = 0; index < 400; index += 1) {
      text += user("提示".repeat(300));
      text += assistant([
        { type: "text", text: "回复".repeat(300) },
        tool("Read", { file_path: `/repo/very/long/path/number-${index}.ts` }),
      ]);
    }
    const out = renderSummary(FACTS, digestTranscript(text));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(
      MAX_SUMMARY_BYTES,
    );
  });

  it("摘要也过脱敏", () => {
    const out = renderSummary(
      FACTS,
      digestTranscript(user("用 ghp_0123456789abcdefghijklmnopqrstuvwxyz 推")),
    );
    expect(out).not.toContain("ghp_0123456789");
    expect(out).toContain("[已脱敏]");
  });

  it("没有对话时说清楚，而不是给一段空白", () => {
    const out = renderSummary(FACTS, digestTranscript(""));
    expect(out).toContain("还没有可读的对话");
  });

  it("末尾指路到原文读取", () => {
    const out = renderSummary(FACTS, digestTranscript(user("x")));
    expect(out).toContain("context transcript");
    expect(out).toContain("--since");
  });

  it("五态各有一句中文", () => {
    for (const state of [
      "starting",
      "idle",
      "busy",
      "awaiting-approval",
      "exited",
    ] as const) {
      expect(stateLabel(state)).not.toBe("");
    }
  });
});
