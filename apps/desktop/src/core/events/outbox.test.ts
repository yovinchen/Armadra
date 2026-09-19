/**
 * outbox 的三个答案，以及「补发的那一帧就是当初那一帧」。
 *
 * 对照的是 `apps/host/internal/eventstream/catchup.go` 与
 * `apps/host/internal/storage/events.go`：状态语义、游标推进、保留下限的裁剪。
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { WorkspaceEvent } from "../bus";
import {
  MAX_CATCH_UP_EVENTS,
  appendEvent,
  catchUp,
  outboxReady,
  prune,
  watermark,
} from "./outbox";
import { WorkspaceEventStream } from "./stream";

const here = dirname(fileURLToPath(import.meta.url));
const migration = resolve(here, "../db/migrations/0018_event_outbox.sql");

function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE store_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), " +
      "host_id TEXT NOT NULL, event_floor INTEGER NOT NULL DEFAULT 0, " +
      "last_sequence INTEGER NOT NULL DEFAULT 0)",
  );
  database
    .prepare("INSERT INTO store_meta (singleton, host_id) VALUES (1, 'host')")
    .run();
  database.exec(readFileSync(migration, "utf8"));
  return database;
}

function board(id: string): WorkspaceEvent {
  return {
    type: "board.changed",
    boardId: id,
    updatedAt: "2026-09-20T00:00:00Z",
  };
}

function write(database: DatabaseSync, workspace: string, id: string): number {
  const event = board(id);
  return appendEvent(database, workspace, event, JSON.stringify(event));
}

describe("event outbox", () => {
  it("只在 0018 之后认自己在", () => {
    expect(outboxReady(new DatabaseSync(":memory:"))).toBe(false);
    expect(outboxReady(open())).toBe(true);
  });

  it("补发的帧与当初广播的那一帧逐字节相同", () => {
    const database = open();
    const first = write(database, "ws", "b1");
    const page = catchUp(database, "ws", 0);
    expect(page.status).toBe("ok");
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.seq).toBe(first);
    expect(page.records[0]?.frame).toBe(JSON.stringify(board("b1")));
    // 解出来还是那 21 个类型里的一个，不是一个重新拼过的近似物。
    expect(JSON.parse(page.records[0]?.frame ?? "null")).toEqual(board("b1"));
  });

  it("序号全库单调，游标跨过别的工作空间继续前进", () => {
    const database = open();
    write(database, "a", "b1");
    write(database, "b", "b2");
    const third = write(database, "a", "b3");
    const page = catchUp(database, "a", 0);
    expect(page.records.map((record) => record.seq)).toEqual([1, third]);
    // 没有更多历史时游标直接跳到水位——被过滤掉的那一条也算走过了，否则一条
    // 窄订阅会永远在同一段上来回扫。
    expect(page.nextCursor).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  it("游标低于保留下限是 SNAPSHOT_REQUIRED，不是空页", () => {
    const database = open();
    for (let index = 0; index < 20; index += 1)
      write(database, "ws", `b${index}`);
    prune(database, 5);
    const bounds = watermark(database);
    expect(bounds.floor).toBe(15);
    const page = catchUp(database, "ws", 3);
    expect(page.status).toBe("snapshotRequired");
    expect(page.records).toHaveLength(0);
    expect(page.nextCursor).toBe(0);
    expect(page.floor).toBe(15);
  });

  it("游标高于水位是 CURSOR_AHEAD，不倒回去", () => {
    const database = open();
    write(database, "ws", "b1");
    const page = catchUp(database, "ws", 99);
    expect(page.status).toBe("cursorAhead");
    expect(page.nextCursor).toBe(0);
    expect(page.watermark).toBe(1);
  });

  it("正好等于下限的游标还能续订", () => {
    const database = open();
    for (let index = 0; index < 20; index += 1)
      write(database, "ws", `b${index}`);
    prune(database, 5);
    const page = catchUp(database, "ws", 15);
    expect(page.status).toBe("ok");
    expect(page.records.map((record) => record.seq)).toEqual([
      16, 17, 18, 19, 20,
    ]);
  });

  it("一页有上限，剩下的用 hasMore 和游标继续", () => {
    const database = open();
    for (let index = 0; index < 7; index += 1)
      write(database, "ws", `b${index}`);
    const page = catchUp(database, "ws", 0, 3);
    expect(page.records).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(3);
    const rest = catchUp(database, "ws", page.nextCursor, MAX_CATCH_UP_EVENTS);
    expect(rest.records.map((record) => record.seq)).toEqual([4, 5, 6, 7]);
    expect(rest.hasMore).toBe(false);
  });

  it("裁剪只往前推，不会把下限拉回去", () => {
    const database = open();
    for (let index = 0; index < 20; index += 1)
      write(database, "ws", `b${index}`);
    prune(database, 5);
    prune(database, 18);
    expect(watermark(database).floor).toBe(15);
  });

  it("publish 同时写 outbox 与实时扇出，两边是同一帧", () => {
    const database = open();
    const stream = new WorkspaceEventStream();
    expect(stream.useOutbox(database)).toBe(true);
    const seen: string[] = [];
    stream.subscribe("ws", {
      send(frame, written) {
        seen.push(frame);
        written();
      },
    });
    stream.publish("ws", board("b1"));
    const page = catchUp(database, "ws", 0);
    expect(seen).toEqual([JSON.stringify(board("b1"))]);
    expect(page.records[0]?.frame).toBe(seen[0]);
  });

  it("没接 outbox 时照旧只有内存扇出", () => {
    const stream = new WorkspaceEventStream();
    const seen: string[] = [];
    stream.subscribe("ws", {
      send(frame, written) {
        seen.push(frame);
        written();
      },
    });
    expect(stream.publish("ws", board("b1"))).toBe(1);
    expect(seen).toHaveLength(1);
    expect(stream.durable).toBeUndefined();
  });

  it("只有带游标的订阅收到控制帧", () => {
    const database = open();
    const stream = new WorkspaceEventStream();
    stream.useOutbox(database);
    const plain: string[] = [];
    const cursored: string[] = [];
    const sink = (into: string[]) => ({
      send(frame: string, written: () => void) {
        into.push(frame);
        written();
      },
    });
    stream.subscribe("ws", sink(plain));
    stream.subscribe("ws", sink(cursored), { cursored: true });
    stream.publish("ws", board("b1"));
    expect(plain).toEqual([JSON.stringify(board("b1"))]);
    expect(cursored).toHaveLength(2);
    expect(JSON.parse(cursored[1] as string)).toMatchObject({
      type: "cursor",
      cursor: 1,
    });
  });
});
