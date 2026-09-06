// 第 1–2 步：Runtime 自己写下一份设置文档并按盘上字节取摘要，然后证明跳过依赖
// 顺序的切换会被拒绝——settings 依赖 canvas，canvas 还没落到 Host 上时这一步必须
// 整条拒绝，而不是做一半。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  digestOf,
  hostBinary,
  hostData,
  hostEnv,
  loadLocalSettingPaths,
  ownershipCli,
  runtimeCall,
  runtimeDiagnostics,
  runtimeOrigin,
  runtimeRoot,
  runtimeSettings,
  runtimeTarget,
  settingsFileDigest,
  settingsShape,
  startRuntime,
  step,
  stopRuntime,
  tryRun,
} from "../harness.mjs";

export async function prepareSettings() {
  step(
    "the Runtime started on a kernel-assigned loopback port",
    await startRuntime(),
    `${runtimeOrigin} ${runtimeDiagnostics}`.trim(),
  );

  // Which keys stay on this machine, straight from the side that enforces it.
  // Every digest below is over the account's half only, because that is the
  // only half a switch moves.
  const localPaths = await loadLocalSettingPaths();
  step(
    "the Runtime names the settings that stay on this execution host",
    localPaths.includes("terminal.backend") &&
      localPaths.includes("power.policy"),
    localPaths.join(", "),
  );

  const domains = await runtimeCall("GET", "/api/ownership/domains");
  step(
    "a fresh database starts with the Runtime owning all six domains",
    domains.status === 200 &&
      domains.json?.length === 6 &&
      domains.json.every(
        (record) => record.owner === "runtime" && record.epoch === "1",
      ),
    (domains.json ?? []).map((record) => record.domain).join(", "),
  );

  const created = await runtimeCall("POST", "/api/workspaces", {
    name: "设置所有权端到端",
    rootPath: runtimeRoot,
  });
  step(
    "the Runtime created a workspace for the canvas the settings switch depends on",
    created.status === 200 && typeof created.json?.id === "string",
    created.json?.id ?? created.text,
  );
  const workspaceId = created.json.id;

  // A document with something from every layer the settings page writes: a
  // terminal choice, a per-platform keybinding, an execution host, and a key
  // nothing in this build knows about, which must survive untouched.
  const written = await runtimeCall("PATCH", "/api/settings", {
    terminal: { backend: "tmux", detachedGraceMinutes: 60 },
    keymap: { mac: { "canvas.tidy": "Mod+Shift+K" } },
    ssh: {
      hosts: [
        {
          id: "build_box",
          name: "构建机",
          host: "example.com",
          user: "ada",
          port: 2222,
          worker: { path: "/opt/armadra/armadra-runtime" },
        },
      ],
    },
    未知的键: { 保留: true },
  });
  step(
    "the Runtime stored a settings document with every layer the page writes",
    written.status === 200 &&
      written.json?.terminal?.backend === "tmux" &&
      written.json?.ssh?.hosts?.length === 1 &&
      written.json?.未知的键?.保留 === true,
    `HTTP ${written.status}`,
  );
  const runtimeDocument = settingsShape(written.json);
  const runtimeDigest = digestOf(runtimeDocument);
  const fileDigest = settingsFileDigest();
  const onDisk = JSON.parse(readFileSync(runtimeSettings, "utf8"));
  step(
    "the document on disk is the one the Runtime answered with, minus its local half",
    fileDigest.length === 64 &&
      digestOf(settingsShape(onDisk)) === runtimeDigest,
    `file sha256=${fileDigest.slice(0, 16)}`,
  );
  // The split is a property of the files, not of the comparison above: a
  // `settings.json` that still carried `terminal.backend` would pass that
  // digest and then hand the Host a key belonging to one machine.
  const localOnDisk = JSON.parse(
    readFileSync(
      join(dirname(runtimeSettings), "worker-settings.json"),
      "utf8",
    ),
  );
  step(
    "the local half is in worker-settings.json and nowhere else",
    onDisk.terminal?.backend === undefined &&
      localOnDisk.terminal?.backend === "tmux" &&
      localOnDisk.ssh === undefined,
    `shared=${Object.keys(onDisk).join(",")} local=${Object.keys(localOnDisk).join(",")}`,
  );

  /* -------------------------- 2. the dependency order refuses to be skipped */

  await stopRuntime();
  const tooEarly = tryRun(
    hostBinary,
    [
      "ownership",
      "switch",
      "--domain",
      "settings",
      "--import-id",
      "settings-too-early",
      "--data-dir",
      hostData,
      "--output",
      "json",
      ...runtimeTarget,
    ],
    { env: hostEnv },
  );
  step(
    "switching settings before the canvas has settled on the Host is refused",
    !tooEarly.ok &&
      /a domain this one depends on has not settled/i.test(tooEarly.output),
    tooEarly.ok ? "accepted" : tooEarly.output.trim().split("\n").pop(),
  );
  const stillRuntime = JSON.parse(
    ownershipCli("status", ["--domain", "settings"]),
  );
  step(
    "the refused switch left the settings record exactly where it was",
    stillRuntime.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      stillRuntime.ownership?.epoch === "1" &&
      stillRuntime.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED",
    `owner=${stillRuntime.ownership?.owner} epoch=${stillRuntime.ownership?.epoch}`,
  );

  return { workspaceId, runtimeDigest };
}
