import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture } from "../agent/fixture";
import { upsertAgentStatus } from "../hook/store";
import { DirectBackend } from "./direct";
import type { EnvPairs } from "./environment";
import { Hibernator } from "./hibernator";
import { TerminalManager } from "./manager";

/**
 * 一个真 PTY 上的假 `claude`：休眠真的结束它，接回来时它真的收到
 * `--resume <同一个 id>`。
 *
 * 假 CLI 是一段 sh：把自己的参数追加进一个文件，然后一直睡。它的名字就叫
 * `claude`，所以前台门、进程树判据看见的与真 CLI 一样。
 */

const describeUnix = process.platform === "win32" ? describe.skip : describe;

let fixture: AgentFixture;
let manager: TerminalManager;
let backend: DirectBackend;

beforeEach(() => {
  fixture = agentFixture();
  backend = new DirectBackend();
  manager = new TerminalManager({
    database: fixture.database,
    backends: new Map([["direct", backend]]),
    effective: "direct",
  });
});

afterEach(async () => {
  // 先经管理器结束：它先标记已退出，随后到来的退出通知就不会去写一个已经关掉
  // 的库。
  for (const record of manager.liveRecords()) {
    await manager.terminate(record.id, "session").catch(() => {});
  }
  await backend.detachAll();
  fixture.close();
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeUnix("假 CLI 上的休眠与接回", () => {
  it("结束进程，再用 --resume 接回同一段对话", async () => {
    const bin = join(fixture.directory, "bin");
    const log = join(fixture.directory, "argv.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\necho "$*" >> '${log}'\nwhile :; do sleep 1; done\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const env: EnvPairs = [["PATH", `${bin}:${process.env.PATH ?? ""}`]];

    const nodeId = fixture.agentNode("Agent", "claude");
    const session = await manager.spawn({
      workspaceId: fixture.workspaceId,
      cwd: fixture.directory,
      shell: "/bin/sh",
      ownerNodeId: nodeId,
      agentId: "claude",
      env,
    });
    await manager.input(session.id, 1, "claude --session-id prov-7\r");
    await until(() => existsSync(log));
    upsertAgentStatus(fixture.database, {
      nodeId,
      workspaceId: fixture.workspaceId,
      agentId: "claude",
      state: "done",
      stateSource: "hook",
      unread: false,
      sessionId: "prov-7",
      pendingId: undefined,
      verified: true,
      transcriptPath: undefined,
      sessionPhase: undefined,
      errored: undefined,
      interrupted: undefined,
      lastEventAt: new Date().toISOString(),
    });

    const hibernator = new Hibernator({
      database: fixture.database,
      manager,
      settings: () => fixture.collab.settings,
      // 阈值 0：这里要证明的是进程真的没了、又真的回来了，不是计时。
      policy: () => ({ enabled: true, idleMinutes: 0 }),
      environment: () => env,
      program: () => ({ path: "claude" }),
    });
    const pidBefore = manager.pid(session.id);
    expect(await hibernator.tick()).toEqual([session.id]);
    expect(manager.session(session.id).hibernation).toBe("hibernated");
    expect(manager.isAlive(session.id)).toBe(false);
    // 进程真的没了（收尸可能晚一拍，等它一下）。
    await until(() => {
      try {
        process.kill(pidBefore as number, 0);
        return false;
      } catch {
        return true;
      }
    });

    const woken = await hibernator.wake(nodeId, "focus");
    expect(woken).toEqual({ sessionId: session.id, generation: 2 });
    await until(() => readFileSync(log, "utf8").includes("--resume prov-7"));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--session-id prov-7",
      "--resume prov-7",
    ]);
    expect(manager.session(session.id)).toMatchObject({
      status: "running",
      generation: 2,
      hibernation: null,
    });
  }, 30_000);
});
