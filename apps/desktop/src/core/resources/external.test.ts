import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus } from "../bus";
import { openDatabase } from "../db/open";
import { createWorkspace } from "../workspaces/table";
import {
  SHELL_REPORT_TTL_MS,
  reportShellProcesses,
  resetExternalProcesses,
  setBrowserProcessSource,
  shellComponents,
  shellProcesses,
} from "./platform";
import { Sampler, type ProcessRow } from "./sample";
import { ResourceService } from "./service";

/**
 * 平台组件里那两类 core 之外的来源：headless 浏览器登记的 pid，以及桌面壳经
 * drive 通道报上来的它自己的进程。
 */

const here = dirname(fileURLToPath(import.meta.url));

function row(
  pid: number,
  parent: number,
  rssBytes: number,
  name = "proc",
): ProcessRow {
  return {
    pid,
    parent,
    rssBytes,
    cpuMs: 0,
    startTimeUnixMs: 1_000,
    state: "sleeping",
    name,
    path: `/bin/${name}`,
  };
}

afterEach(() => {
  resetExternalProcesses();
});

describe("the shell's report", () => {
  it("keeps only well-formed rows of known kinds", () => {
    reportShellProcesses(
      [
        { pid: 10, kind: "shellMain", startTimeUnixMs: 1, memoryBytes: 5 },
        { pid: -1, kind: "shellGpu" },
        { pid: 11, kind: "somethingElse" },
        { pid: 12, kind: "browserGuest", memoryBytes: Number.NaN },
        "junk",
      ],
      1_000,
    );
    expect(shellProcesses(1_000)).toEqual([
      {
        pid: 10,
        kind: "shellMain",
        startTimeUnixMs: 1,
        memoryBytes: 5,
        cpuPercent: null,
      },
      {
        pid: 12,
        kind: "browserGuest",
        startTimeUnixMs: null,
        memoryBytes: null,
        cpuPercent: null,
      },
    ]);
  });

  it("goes stale when the shell stops reporting", () => {
    reportShellProcesses([{ pid: 10, kind: "shellMain" }], 1_000);
    expect(shellProcesses(1_000 + SHELL_REPORT_TTL_MS + 1)).toEqual([]);
    // 一份形状不对的报告被忽略，不会冲掉上一份。
    reportShellProcesses("not an array", 2_000);
    expect(shellProcesses(2_000)).toHaveLength(1);
  });

  it("prefers the local process table, and falls back to the shell's numbers", () => {
    const table = new Map([[10, row(10, 1, 8_000, "Electron")]]);
    const rows = shellComponents({
      reports: [
        {
          pid: 20,
          kind: "browserGuest",
          startTimeUnixMs: null,
          memoryBytes: 3_000,
          cpuPercent: 2,
        },
        {
          pid: 10,
          kind: "shellMain",
          startTimeUnixMs: 1_000,
          memoryBytes: 1,
          cpuPercent: 1,
        },
        {
          pid: 99,
          kind: "shellRenderer",
          startTimeUnixMs: null,
          memoryBytes: 1,
          cpuPercent: null,
        },
      ],
      table,
      previousTable: undefined,
      elapsedMs: 0,
      selfPid: 99,
    });
    expect(rows.map((each) => [each.kind, each.process.pid])).toEqual([
      ["shellMain", 10],
      ["browserGuest", 20],
    ]);
    expect(rows[0]!.process.memoryBytes).toBe(8_000);
    expect(rows[0]!.process.name).toBe("Electron");
    expect(rows[1]!.process.memoryBytes).toBe(3_000);
    expect(rows.every((each) => each.tree === false)).toBe(true);
  });
});

describe("the resource snapshot", () => {
  it("lists the headless browser as a tree and the shell's processes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "armadra-resources-ext-"));
    const db = openDatabase({
      file: join(dataDir, "canvas.db"),
      migrationsDir: resolve(here, "../db/migrations"),
    });
    try {
      const workspace = createWorkspace(db.database, {
        name: "一",
        rootPath: dataDir,
      });
      const table = new Map<number, ProcessRow>([
        [process.pid, row(process.pid, 1, 4_096, "node")],
        [500, row(500, process.pid, 100_000, "chromium")],
        [501, row(501, 500, 50_000, "chromium-renderer")],
      ]);
      setBrowserProcessSource(() => [{ pid: 500, startTimeUnixMs: 1_000 }]);
      reportShellProcesses([
        { pid: 700, kind: "shellGpu", memoryBytes: 42, cpuPercent: 0 },
      ]);
      const service = new ResourceService({
        database: db.database,
        settings: undefined,
        bus: new EventBus(),
        dataDir,
        sampler: new Sampler(
          () => 1_000_000,
          () => table,
        ),
      });
      const snapshot = service.snapshot(workspace.id);
      const kinds = snapshot.components.map((each) => each.kind);
      expect(kinds).toEqual(["runtime", "browserWorker", "shellGpu"]);
      const browser = snapshot.components[1]!;
      expect(browser.tree).toBe(true);
      expect(browser.process.memoryBytes).toBe(150_000);
      expect(browser.childCount).toBe(1);
      expect(snapshot.components[2]!.process.memoryBytes).toBe(42);
      service.stop();
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
