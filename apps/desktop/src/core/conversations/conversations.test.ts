import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { migrationsDir } from "../agent/fixture";
import * as claude from "./claude";
import * as codex from "./codex";
import {
  commandFromCapture,
  count,
  listConversations,
  refresh,
  transcriptTitle,
} from "./index";
import { clamp, collapse, readLines } from "./scan";

/** Ported from `apps/runtime/src/index/tests.rs`. */

let directory: string;
let database: DatabaseSync;
let close: () => void;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-index-"));
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir: migrationsDir(),
  });
  database = opened.database;
  close = () => opened.close();
});

afterEach(() => {
  close();
  rmSync(directory, { recursive: true, force: true });
});

function claudeRoot(): string {
  const root = join(directory, "claude", "projects");
  mkdirSync(join(root, "-Users-me-project"), { recursive: true });
  return root;
}

function writeClaude(sessionId: string, lines: unknown[]): string {
  const root = claudeRoot();
  const path = join(root, "-Users-me-project", `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

describe("the Claude scanner", () => {
  it("takes the first real user message as the title", () => {
    const parsed = claude.parseLines("s-1", [
      JSON.stringify({
        type: "user",
        cwd: "/Users/me/project",
        message: { content: "<command-name>/clear" },
      }),
      JSON.stringify({ type: "assistant", message: { content: "hi" } }),
      JSON.stringify({
        type: "user",
        message: { content: "  port the   index  " },
      }),
    ]);
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.cwd).toBe("/Users/me/project");
    // CLI machinery is skipped and whitespace is collapsed.
    expect(parsed.title).toBe("port the index");
  });

  it("reads a block array and skips a turn that is only a tool result", () => {
    const parsed = claude.parseLines("s-2", [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "x" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "the real one" }] },
      }),
    ]);
    expect(parsed.title).toBe("the real one");
  });

  it("leaves the title empty rather than guessing, and offers a fallback", () => {
    const parsed = claude.parseLines("s-3", [
      JSON.stringify({
        type: "assistant",
        cwd: "/a/b",
        message: { content: "x" },
      }),
    ]);
    expect(parsed.title).toBe("");
    // The indexer fills it in; `suggest-title` must not.
    expect(claude.fallbackTitle("/Users/me/project")).toBe("project");
    expect(claude.fallbackTitle("")).toBe("");
  });

  it("indexes one file per session and nothing deeper", () => {
    const root = claudeRoot();
    writeClaude("s-1", [
      { type: "user", cwd: "/a", message: { content: "one" } },
    ]);
    // A sub-agent transcript is not a session a human resumes.
    mkdirSync(join(root, "-Users-me-project", "s-1", "subagents"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "-Users-me-project", "s-1", "subagents", "sub.jsonl"),
      `${JSON.stringify({ type: "user", message: { content: "sub" } })}\n`,
    );
    expect(claude.candidates(root)).toHaveLength(1);
  });
});

describe("the Codex scanner", () => {
  it("reads the session id out of the file name", () => {
    const stem =
      "rollout-2026-09-04T02-06-15-01a06873-346b-73e1-b3b6-2224a11ce547";
    expect(codex.sessionIdFromStem(stem)).toBe(
      "01a06873-346b-73e1-b3b6-2224a11ce547",
    );
    expect(codex.sessionIdFromStem("rollout-short")).toBeUndefined();
  });

  it("takes the meta record's cwd and the first non-synthetic user turn", () => {
    const parsed = codex.parseLines("rollout-x", [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/w" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_instructions>noise" }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "the real ask" },
      }),
    ]);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.cwd).toBe("/w");
    expect(parsed.title).toBe("the real ask");
  });

  it("falls back to the stem when no record names a session", () => {
    const parsed = codex.parseLines("rollout-x", []);
    expect(parsed.sessionId).toBe("rollout-x");
  });
});

describe("the index", () => {
  it("writes a row per session and lists it newest first", () => {
    writeClaude("s-1", [
      { type: "user", cwd: "/Users/me/project", message: { content: "first" } },
    ]);
    const roots = [["claude", claudeRoot()]] as const;
    const report = refresh(database, roots);
    expect(report).toMatchObject({ scanned: 1, indexed: 1, total: 1 });
    const rows = listConversations(database, undefined, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude",
      sessionId: "s-1",
      title: "first",
      cwd: "/Users/me/project",
    });
  });

  it("does not reopen a file whose mtime has not moved", () => {
    writeClaude("s-1", [
      { type: "user", cwd: "/a", message: { content: "x" } },
    ]);
    const roots = [["claude", claudeRoot()]] as const;
    refresh(database, roots);
    const second = refresh(database, roots);
    // Still scanned (one `stat`), but nothing was read or written.
    expect(second).toMatchObject({ scanned: 1, indexed: 0, removed: 0 });
  });

  it("drops a row whose file is gone, and every row when the root is", () => {
    const path = writeClaude("s-1", [
      { type: "user", cwd: "/a", message: { content: "x" } },
    ]);
    const roots = [["claude", claudeRoot()]] as const;
    refresh(database, roots);
    rmSync(path);
    expect(refresh(database, roots)).toMatchObject({ removed: 1 });
    expect(count(database)).toBe(0);

    writeClaude("s-2", [
      { type: "user", cwd: "/a", message: { content: "y" } },
    ]);
    refresh(database, roots);
    expect(count(database)).toBe(1);
    // An absent root means the CLI was uninstalled or its home moved.
    rmSync(join(directory, "claude"), { recursive: true, force: true });
    expect(refresh(database, roots)).toMatchObject({ removed: 1 });
    expect(count(database)).toBe(0);
  });

  it("searches the title and the cwd, and escapes LIKE metacharacters", () => {
    writeClaude("s-1", [
      {
        type: "user",
        cwd: "/Users/me/alpha",
        message: { content: "100% done" },
      },
    ]);
    writeClaude("s-2", [
      { type: "user", cwd: "/Users/me/beta", message: { content: "other" } },
    ]);
    refresh(database, [["claude", claudeRoot()]]);
    expect(listConversations(database, "alpha", 50)).toHaveLength(1);
    expect(listConversations(database, "DONE", 50)).toHaveLength(1);
    // A user typing `100%` is searching for a literal percent sign.
    expect(listConversations(database, "100%", 50)).toHaveLength(1);
    expect(listConversations(database, "%", 50)).toHaveLength(1);
    expect(listConversations(database, "nothing", 50)).toHaveLength(0);
    // The limit limits the work, not just the output.
    expect(listConversations(database, undefined, 1)).toHaveLength(1);
  });
});

describe("suggesting a title", () => {
  it("reads the transcript's first message, clamped to a header's width", () => {
    const path = writeClaude("s-1", [
      { type: "user", cwd: "/a", message: { content: "x".repeat(200) } },
    ]);
    expect(transcriptTitle("claude", path)).toHaveLength(40);
    expect(
      transcriptTitle("claude", join(directory, "nope.jsonl")),
    ).toBeUndefined();
  });

  it("reads the last command out of a terminal capture", () => {
    expect(commandFromCapture("$ ls -la\nREADME.md\n")).toBe("ls -la");
    expect(commandFromCapture("~/project % pnpm test\n")).toBe("pnpm test");
    expect(commandFromCapture("user@host ❯ cargo build\n")).toBe("cargo build");
    // Output lines carry no prompt marker, so a stack trace is never offered.
    expect(
      commandFromCapture("thread panicked at src/a.rs:1\n"),
    ).toBeUndefined();
    // A root prompt and a comment look the same, so `#` is not a marker.
    expect(commandFromCapture("# a comment\n")).toBeUndefined();
  });
});

describe("the bounded reads", () => {
  it("drops a trailing partial line rather than parsing a fragment", () => {
    const path = join(directory, "partial.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2');
    expect(readLines(path, 1024, 10)).toEqual(['{"a":1}']);
  });

  it("stops at the line budget even when the byte budget is generous", () => {
    const path = join(directory, "many.jsonl");
    writeFileSync(path, "x\n".repeat(100));
    expect(readLines(path, 1024 * 1024, 3)).toHaveLength(3);
  });

  it("clamps by character, not by byte", () => {
    expect(collapse("  a   b  ")).toBe("a b");
    // These titles are frequently Chinese, where a byte cut lands
    // mid-character.
    expect(clamp("中文标题很长很长", 4)).toBe("中文标题");
  });
});
