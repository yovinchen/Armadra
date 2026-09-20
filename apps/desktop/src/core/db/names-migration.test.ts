import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { handlesFor } from "../canvas/handles";
import { openDatabase } from "./open";

/**
 * 0021 的回填：一个已经在用的库里，`node.data.handle` 搬进 `node_handles`。
 *
 * 夹具的搭法与 0019 那条一样，理由也一样：直接在空库上跑这条迁移只证明表建得
 * 出来。要证明的是**行**搬对了——尤其是撞名那一对，谁留下、谁的副本被清掉。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "migrations");

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // 已经关过了。
    }
  }
});

/** 一个只带 0021 之前那些迁移的目录（账本要的是一段连续前缀）。 */
function beforeNames(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-0021-overlay-"));
  for (const name of readdirSync(migrationsDir)) {
    if (Number(name.slice(0, 4)) >= 21) continue;
    copyFileSync(join(migrationsDir, name), join(directory, name));
  }
  return directory;
}

function open(file: string, directory: string) {
  const opened = openDatabase({ file, migrationsDir: directory });
  closing.push(opened.close);
  return opened;
}

describe("0021：data.handle → node_handles", () => {
  it("搬走合法的名字，撞名的留先到的那个，其余副本清掉", () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "armadra-0021-")),
      "canvas.db",
    );

    const old = open(file, beforeNames());
    old.database.exec(
      "INSERT INTO workspaces (id, name, root_path, permissions_json, created_at, updated_at) " +
        "VALUES ('w', 'w', '/tmp', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    const board = (id: string): void => {
      old.database
        .prepare(
          "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES (?, 'w', ?, ?, ?)",
        )
        .run(id, id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    };
    board("b1");
    board("b2");
    const node = (
      id: string,
      boardId: string,
      data: unknown,
      updatedAt: string,
    ): void => {
      old.database
        .prepare(
          "INSERT INTO nodes (id, board_id, type, x, y, title, data_json, created_at, updated_at) " +
            "VALUES (?, ?, 'terminal', 0, 0, ?, ?, '2026-01-01T00:00:00Z', ?)",
        )
        .run(id, boardId, id, JSON.stringify(data), updatedAt);
    };
    node(
      "n1",
      "b1",
      { kind: "terminal", handle: "Reviewer" },
      "2026-01-01T01:00:00Z",
    );
    // 同一块画布、同一个名字，晚一点起的：输家。
    node(
      "n2",
      "b1",
      { kind: "terminal", handle: "reviewer" },
      "2026-01-01T02:00:00Z",
    );
    // 另一块画布上可以再出现一次同一个名字。
    node(
      "n3",
      "b2",
      { kind: "terminal", handle: "reviewer" },
      "2026-01-01T03:00:00Z",
    );
    node(
      "n4",
      "b1",
      { kind: "terminal", handle: "has space" },
      "2026-01-01T04:00:00Z",
    );
    node("n5", "b1", { kind: "terminal" }, "2026-01-01T05:00:00Z");
    old.close();

    const upgraded = open(file, migrationsDir);
    const handles = handlesFor(upgraded.database, [
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    expect(handles.get("n1")).toBe("reviewer");
    expect(handles.has("n2")).toBe(false);
    expect(handles.get("n3")).toBe("reviewer");
    expect(handles.has("n4")).toBe(false);
    expect(handles.has("n5")).toBe(false);

    // 副本与表对得上：赢家折叠成表里的写法，没进表的一律清掉——不猜一个新名字。
    const copyOf = (id: string): string | undefined => {
      const row = upgraded.database
        .prepare("SELECT data_json FROM nodes WHERE id = ?")
        .get(id) as unknown as { data_json: string };
      return (JSON.parse(row.data_json) as { handle?: string }).handle;
    };
    expect(copyOf("n1")).toBe("reviewer");
    expect(copyOf("n2")).toBeUndefined();
    expect(copyOf("n3")).toBe("reviewer");
    expect(copyOf("n4")).toBeUndefined();
  });
});
