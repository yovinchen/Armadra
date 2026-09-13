// 第 8 步：集成是**执行**，不是记录（docs/design/agent-integration.md §2、§5）。
//
// Hook 与技能都是执行主机上的文件，Host 一个字节也不写：它认人、认权限，然后
// 转发给那台机器上的 Worker，并把答案原样带回来。这一段要证的正是这一点——
// 一次读、一次装、一次卸、一次修复，全都跑真 Worker，改动只落在这次运行自己的
// 临时目录里。
//
// 之所以要单独证：装 Hook 是唯一一个「Host 有权限做、但没有能力做」的动作。
// 一个把它办在自己这边的 Host 会写进一份它读不回来的配置，而错误要到下一次
// 那个 CLI 起会话时才看得出来。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { refusal, step } from "../report.mjs";

/** 旧产品名留下的那种条目，写成用户真实报上来的形状。 */
function seedLegacyEntries(configHome) {
  mkdirSync(configHome, { recursive: true });
  writeFileSync(
    join(configHome, "settings.json"),
    JSON.stringify(
      {
        model: "opus",
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "/usr/local/bin/aicc-hook claude" },
              ],
            },
            {
              hooks: [{ type: "command", command: "/usr/local/bin/notify.sh" }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}

export async function integrationIsForwarded(
  harness,
  { driver, claudeConfigHome },
) {
  seedLegacyEntries(claudeConfigHome);

  const before = await driver.agent("getIntegration", [{ agentId: "claude" }]);
  step(
    "the Host forwards the integration read to the machine that runs the CLI",
    before?.mode === "launch" && before.hook?.installed === false,
    `mode=${before?.mode} hook=${before?.hook?.installed}${refusal(before)}`,
  );
  // 启动时注入的 CLI，旧残留仍然在用户自己的文件里。读只报，不改。
  step(
    "an older install is reported by the read and left exactly where it is",
    before?.legacy?.some((entry) => entry.detail?.includes("aicc-hook")) ===
      true &&
      readFileSync(join(claudeConfigHome, "settings.json"), "utf8").includes(
        "aicc-hook",
      ),
    `legacy=${before?.legacy?.length ?? 0}`,
  );

  const installed = await driver.agent("installIntegration", [
    { operationId: "agent/claude/integration/install", agentId: "claude" },
  ]);
  step(
    "installing wrote both halves as one unit",
    installed?.hook?.installed === true && installed.skill?.installed === true,
    `hook=${installed?.hook?.installed} skill=${installed?.skill?.installed}${refusal(installed)}`,
  );
  // 一个修订，两半合成。装完就是当前版，所以 `stale` 必须是假。
  step(
    "one revision covers both halves, and a fresh install is not stale",
    installed?.stale === false &&
      installed.installedRevision === installed.revision,
    `installed=${installed?.installedRevision} current=${installed?.revision}`,
  );
  // 启动注入的那一个要把自己的 argv 说出来，否则会话起来就是没有 Hook。
  step(
    "a launch-injected CLI reports the argv its session has to carry",
    installed?.launchArgs?.[0] === "--settings" &&
      existsSync(installed.launchArgs[1] ?? ""),
    `argv=${(installed?.launchArgs ?? []).join(" ")}`,
  );
  // 而且没写进用户自己的配置：那正是 launch 这一档的定义。
  step(
    "nothing of ours went into the CLI's own settings file",
    !readFileSync(join(claudeConfigHome, "settings.json"), "utf8").includes(
      "armadra-hook",
    ),
    claudeConfigHome,
  );
  step(
    "the skill landed in the directory that CLI actually reads",
    existsSync(join(claudeConfigHome, "skills", "armadra", "SKILL.md")),
    installed?.skill?.path ?? "(no path)",
  );

  const repaired = await driver.agent("repairIntegration", [
    { operationId: "agent/claude/integration/repair", agentId: "claude" },
  ]);
  step(
    "repair removed the entry it recognised, kept the one it did not, and backed the file up",
    repaired?.removed?.length === 1 &&
      repaired.kept?.some((entry) => entry.includes("notify.sh")) === true &&
      repaired.backups?.length === 1,
    `removed=${repaired?.removed?.length} kept=${repaired?.kept?.length} backups=${repaired?.backups?.length}${refusal(repaired)}`,
  );
  const afterRepair = readFileSync(
    join(claudeConfigHome, "settings.json"),
    "utf8",
  );
  step(
    "the user's own hook survived the repair byte for byte",
    !afterRepair.includes("aicc-hook") && afterRepair.includes("notify.sh"),
    afterRepair.replace(/\s+/g, " ").slice(0, 120),
  );

  const removed = await driver.agent("uninstallIntegration", [
    { operationId: "agent/claude/integration/uninstall", agentId: "claude" },
  ]);
  step(
    "uninstalling took both halves away, and the skill file with them",
    removed?.hook?.installed === false &&
      removed.skill?.installed === false &&
      !existsSync(join(claudeConfigHome, "skills", "armadra", "SKILL.md")),
    `hook=${removed?.hook?.installed} skill=${removed?.skill?.installed}${refusal(removed)}`,
  );
}
