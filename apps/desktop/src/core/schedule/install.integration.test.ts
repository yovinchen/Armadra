/**
 * 装配级验收：起一个真的 core，页面那条路走得通。
 *
 * 两件事，每一件都是页面在打开自动化面板之前会做的：
 *
 *   1. `GET /api/identity/hello` 的能力名里有 `automation.plans.v1`。没有它，
 *      `apps/web/src/host/automation-session.ts` 直接停在 `unsupported`，一次
 *      请求都不会发。
 *   2. `/api/automations/plans` 由这个域接住，答的是这一面自己的 JSON 信封。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";
import { AUTOMATION_CAPABILITY } from "./capabilities";
import { scheduleDomain } from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];

afterEach(async () => {
  scheduleDomain()?.stop();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start(): Promise<{ core: RunningCore; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-schedule-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
  });
  running.push(core);
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return { core, base: `http://${tcp.host}:${tcp.port}` };
}

describe("自动化域的装配", () => {
  it("Hello 报出自动化能力，页面据此打开面板", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/identity/hello`, {
      headers: { origin: base },
    });
    expect(response.status).toBe(200);
    const hello = (await response.json()) as { capabilities?: string[] };
    expect(hello.capabilities).toContain(AUTOMATION_CAPABILITY);
  });

  it("这一面在同一个 core 上答 JSON 信封", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/automations/plans`, {
      headers: { origin: base },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("调度循环跟着 core 起来，也跟着 core 停下", async () => {
    await start();
    const domain = scheduleDomain();
    expect(domain).toBeDefined();
    domain?.stop();
    expect(scheduleDomain()).toBeUndefined();
  });
});
