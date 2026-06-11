import { describe, expect, it } from "vitest";
import {
  hasPendingPermission,
  parsePermissionCommand,
  parsePermissionOptions,
  parsePermissionTitle,
  parseUpdate,
  reduceTimeline,
  TIMELINE_CAP,
  type TimelineItem,
} from "./timeline";

const ids = () => {
  let n = 0;
  return () => ++n;
};

const fold = (events: Parameters<typeof reduceTimeline>[1][]) => {
  const nextId = ids();
  return events.reduce<TimelineItem[]>(
    (items, event) => reduceTimeline(items, event, nextId),
    [],
  );
};

describe("parseUpdate", () => {
  it("reads every normalised runtime shape", () => {
    expect(parseUpdate({ kind: "message", text: "hi" })).toEqual({
      kind: "message",
      text: "hi",
    });
    expect(
      parseUpdate({
        kind: "tool",
        toolCallId: "t1",
        title: "读取文件",
        status: "in_progress",
        toolKind: "read",
        detail: "src/a.ts",
      }),
    ).toMatchObject({ kind: "tool", toolCallId: "t1", status: "in_progress" });
    expect(
      parseUpdate({ kind: "usage", inputTokens: 10, outputTokens: 4 }),
    ).toEqual({ kind: "usage", inputTokens: 10, outputTokens: 4 });
  });

  it("rejects junk and unknown kinds instead of throwing", () => {
    expect(parseUpdate(null)).toBeNull();
    expect(parseUpdate({ kind: "unknown" })).toBeNull();
    expect(parseUpdate({ kind: "tool" })).toBeNull();
    expect(parseUpdate({ kind: "message", text: "" })).toBeNull();
  });

  it("falls back to pending for an unknown tool status", () => {
    expect(
      parseUpdate({ kind: "tool", toolCallId: "t", status: "weird" }),
    ).toMatchObject({ status: "pending", title: "工具调用" });
  });
});

describe("reduceTimeline", () => {
  it("merges consecutive chunks of the same kind into one bubble", () => {
    const items = fold([
      { type: "update", update: { kind: "message", text: "Hel" } },
      { type: "update", update: { kind: "message", text: "lo" } },
      { type: "update", update: { kind: "thinking", text: "why" } },
      { type: "update", update: { kind: "message", text: "!" } },
    ]);
    expect(
      items.map((item) => [item.kind, "text" in item && item.text]),
    ).toEqual([
      ["assistant", "Hello"],
      ["thinking", "why"],
      ["assistant", "!"],
    ]);
  });

  it("updates a tool row in place by toolCallId and keeps its id", () => {
    const items = fold([
      {
        type: "update",
        update: {
          kind: "tool",
          toolCallId: "t1",
          title: "执行命令",
          status: "pending",
          toolKind: "execute",
          detail: "npm test",
        },
      },
      { type: "update", update: { kind: "message", text: "working" } },
      {
        type: "update",
        update: {
          kind: "tool",
          toolCallId: "t1",
          title: "执行命令",
          status: "completed",
          toolKind: "execute",
          detail: "npm test",
        },
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 1,
      kind: "tool",
      status: "completed",
    });
  });

  it("replaces the plan checklist rather than appending a second one", () => {
    const items = fold([
      {
        type: "update",
        update: {
          kind: "plan",
          entries: [{ content: "a", status: "pending" }],
        },
      },
      {
        type: "update",
        update: {
          kind: "plan",
          entries: [{ content: "a", status: "completed" }],
        },
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "plan",
      entries: [{ content: "a", status: "completed" }],
    });
  });

  it("records a permission once and marks it decided on resolution", () => {
    const permission = {
      type: "permission" as const,
      requestId: "r1",
      title: "执行命令",
      command: "npm test",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    let items = fold([permission, permission]);
    expect(items).toHaveLength(1);
    expect(hasPendingPermission(items)).toBe(true);

    items = reduceTimeline(
      items,
      {
        type: "permission_resolved",
        requestId: "r1",
        resolution: "selected:allow",
      },
      ids(),
    );
    expect(items[0]).toMatchObject({ decision: "selected:allow" });
    expect(hasPendingPermission(items)).toBe(false);
  });

  it("drops the oldest items past the cap", () => {
    const nextId = ids();
    let items: TimelineItem[] = [];
    for (let index = 0; index < TIMELINE_CAP + 20; index += 1) {
      items = reduceTimeline(
        items,
        { type: "status", text: `s${index}` },
        nextId,
      );
      // Alternate so consecutive statuses are not merged away.
      items = reduceTimeline(
        items,
        {
          type: "update",
          update: {
            kind: "tool",
            toolCallId: `t${index}`,
            title: "x",
            status: "completed",
            toolKind: null,
            detail: null,
          },
        },
        nextId,
      );
    }
    expect(items).toHaveLength(TIMELINE_CAP);
  });

  it("ignores usage updates — tokens live outside the timeline", () => {
    expect(
      fold([
        {
          type: "update",
          update: { kind: "usage", inputTokens: 1, outputTokens: 2 },
        },
      ]),
    ).toEqual([]);
  });
});

describe("permission request parsing", () => {
  const request = {
    toolCall: {
      title: "执行命令",
      kind: "execute",
      rawInput: { command: "npm test -- login" },
    },
    options: [
      { optionId: "a", name: "Allow once", kind: "allow_once" },
      { optionId: "b", name: "Reject", kind: "reject_once" },
      { name: "broken" },
    ],
  };

  it("reads the title, the command and only well-formed options", () => {
    expect(parsePermissionTitle(request)).toBe("执行命令");
    expect(parsePermissionCommand(request)).toBe("npm test -- login");
    expect(parsePermissionOptions(request)).toEqual([
      { optionId: "a", name: "Allow once", kind: "allow_once" },
      { optionId: "b", name: "Reject", kind: "reject_once" },
    ]);
  });

  it("falls back to the tool title when rawInput carries no command", () => {
    expect(
      parsePermissionCommand({ toolCall: { title: "读取文件", rawInput: {} } }),
    ).toBe("读取文件");
    expect(parsePermissionCommand({})).toBe("");
    expect(parsePermissionOptions(null)).toEqual([]);
  });
});
