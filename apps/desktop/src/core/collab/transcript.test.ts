import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardLog } from "./board-log";
import { Args, collapseNewlines, stripControl, truncate } from "./refusals";
import { findUnder, readTail, render, renderEntry } from "./transcript";

/**
 * Ported from `apps/runtime/src/collab/transcript.rs`, `board_log.rs` and the
 * `Args` helpers in `collab/mod.rs`.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-transcript-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("rendering a transcript", () => {
  it("labels each role and skips what it does not recognise", () => {
    const lines = render(
      [
        JSON.stringify({ type: "user", message: { content: "ask" } }),
        JSON.stringify({ type: "assistant", message: { content: "answer" } }),
        JSON.stringify({ type: "system", content: "note" }),
        JSON.stringify({ type: "summary", content: "ignored" }),
        "not json",
        "",
      ].join("\n"),
    );
    expect(lines).toEqual(["[用户] ask", "[助手] answer", "[系统] note"]);
  });

  it("unwraps a codex payload once and renders the message inside", () => {
    expect(
      renderEntry({
        type: "response_item",
        payload: {
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      }),
    ).toBe("[用户] hi");
  });

  it("quotes a tool's one interesting argument rather than dumping it", () => {
    expect(
      renderEntry({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "a.ts", extra: 1 },
            },
          ],
        },
      }),
    ).toBe("[工具 Read a.ts]");
    expect(
      renderEntry({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "  lots  of  output " }],
        },
      }),
    ).toBe("[结果 lots of output]");
    // Thinking is the model talking to itself, not somebody else's context.
    expect(
      renderEntry({
        type: "assistant",
        message: { content: [{ type: "thinking", text: "hmm" }] },
      }),
    ).toBeUndefined();
  });

  it("reads a whole-document transcript as well as JSONL", () => {
    expect(
      render(
        JSON.stringify({
          messages: [{ role: "user", content: "from a document" }],
        }),
      ),
    ).toEqual(["[用户] from a document"]);
    expect(
      render(JSON.stringify([{ role: "user", content: "array" }])),
    ).toEqual(["[用户] array"]);
  });

  it("never starts the tail in the middle of a line", () => {
    const path = join(directory, "long.jsonl");
    const first = JSON.stringify({ type: "user", message: { content: "old" } });
    const second = JSON.stringify({
      type: "user",
      message: { content: "new" },
    });
    writeFileSync(path, `${first}\n${second}\n`);
    // A window that lands inside the first line drops it rather than handing
    // the parser a fragment.
    const tail = readTail(path, second.length + 5);
    expect(tail.trim()).toBe(second);
    expect(readTail(path, 1024 * 1024)).toContain("old");
  });
});

describe("finding a transcript by name", () => {
  it("answers the newest match and stops at the depth bound", () => {
    mkdirSync(join(directory, "2026", "09"), { recursive: true });
    const older = join(directory, "2026", "09", "rollout-a.jsonl");
    const newer = join(directory, "2026", "09", "rollout-b.jsonl");
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    const now = Date.now();
    // `utimesSync` takes seconds; ten seconds apart is unambiguous.
    utimesSync(older, now / 1000 - 10, now / 1000 - 10);
    expect(findUnder(directory, (name) => name.startsWith("rollout-"))).toBe(
      newer,
    );
    expect(findUnder(directory, () => false)).toBeUndefined();
    expect(findUnder(join(directory, "nope"), () => true)).toBeUndefined();
  });
});

describe("the board log", () => {
  it("writes to the workspace when it can, and to the ring when it cannot", () => {
    const log = new BoardLog();
    expect(
      log.record(directory, {
        traceId: "t-1",
        source: "a",
        target: "b",
        outcome: "interrupted",
        receipt: "escape",
        bodyChars: 0,
      }),
    ).toBe("file");
    expect(log.snapshot()).toHaveLength(0);

    const memory = new BoardLog();
    expect(
      memory.record(undefined, {
        traceId: "t-2",
        source: "a",
        target: "b",
        outcome: "refused",
        bodyChars: 0,
      }),
    ).toBe("memory");
    // The body is never written; only how many characters it had.
    expect(memory.snapshot()[0]).toMatchObject({
      traceId: "t-2",
      outcome: "refused",
      bodyChars: 0,
      traced: "memory",
    });
    expect(JSON.stringify(memory.snapshot())).not.toContain('"body"');
  });
});

describe("the flag reader", () => {
  it("never reads a value as a bare flag, or a bare flag as a value", () => {
    const args = new Args({
      title: "Build",
      bare: true,
      spelled: "yes",
      empty: "   ",
      repeated: ["", "first", "second"],
      lines: "40",
      count: 7,
    });
    expect(args.text("title")).toBe("Build");
    expect(args.text("bare")).toBeUndefined();
    expect(args.text("empty")).toBeUndefined();
    expect(args.text("repeated")).toBe("first");
    // `--title Build` must not read as `flag("title") === true`.
    expect(args.flag("title")).toBe(false);
    expect(args.flag("bare")).toBe(true);
    expect(args.flag("spelled")).toBe(true);
    expect(args.flag("missing")).toBe(false);
    expect(args.count(["lines", "n"])).toBe(40);
    expect(args.count(["count"])).toBe(7);
    expect(args.count(["missing"])).toBeUndefined();
  });

  it("splits a repeatable flag on commas as well as repetition", () => {
    expect(new Args({ after: "a, b ,,c" }).list("after")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(new Args({ after: ["a", "b,c"] }).list("after")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(new Args({}).list("after")).toEqual([]);
  });

  it("collapses line breaks and strips the escapes a body may not carry", () => {
    expect(collapseNewlines("a\nb\r\nc  d")).toBe("a b c d");
    expect(stripControl("a[2Jb\tc\nd")).toBe("a[2Jb\tc\nd");
    expect(truncate("short", 100)).toBe("short");
    const cut = truncate("中".repeat(100), 30);
    expect(cut).toContain("（已截断）");
    expect(cut).not.toContain("�");
  });
});
