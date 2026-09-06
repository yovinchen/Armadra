// 第 7–8 步：经 HTTPS 把 settings 的纪元交还 Runtime，然后证明这是一次真正的回滚
// ——Host 在任期内写下的改动出现在 Runtime 自己的设置里，Runtime 也重新可写。
import {
  ownershipCli,
  refusal,
  runtimeCall,
  runtimeOrigin,
  startRuntime,
  step,
  stopRuntime,
} from "../harness.mjs";

export async function rollbackSettingsToRuntime({ driver }) {
  const window = JSON.parse(ownershipCli("window", ["--domain", "settings"]));
  step(
    "the control channel issued a maintenance window for the settings domain",
    typeof window.token === "string" &&
      window.token.length === 64 &&
      window.domain === "settings",
    `expires in ${Math.round((Number(window.expiresAtUnixMs) - Date.now()) / 1000)}s`,
  );
  const rolledBack = await driver.ownership("switchDomain", [
    {
      domain: "settings",
      target: "runtime",
      expectedEpoch: 2n,
      maintenanceToken: window.token,
    },
  ]);
  const reverseChecks = Object.fromEntries(
    (rolledBack.report?.checks ?? []).map((check) => [
      check.check,
      check.matched,
    ]),
  );
  step(
    "the HTTPS rollback handed the settings epoch back to the Runtime",
    rolledBack.ownership?.owner === 1 &&
      rolledBack.ownership?.epoch === 3n &&
      rolledBack.report?.matched === true,
    `owner=${rolledBack.ownership?.owner} epoch=${rolledBack.ownership?.epoch}${refusal(rolledBack)}`,
  );
  step(
    "the Runtime's own re-read was compared with the package the Host wrote",
    reverseChecks["settings.export"] === true &&
      reverseChecks["reverse.settings.document_sha256"] === true &&
      reverseChecks["reverse.settings.keys"] === true &&
      reverseChecks["reverse.settings.execution_hosts"] === true &&
      reverseChecks["reverse.event_sequence"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  /* --------------------- 8. what the Host wrote is what the Runtime now has */

  await stopRuntime();
  step(
    "the Runtime restarted after the rollback",
    await startRuntime(),
    runtimeOrigin,
  );
  const afterRollback = await runtimeCall("GET", "/api/settings");
  step(
    "the Runtime reads the change the Host made while it owned the domain",
    afterRollback.status === 200 &&
      afterRollback.json?.theme === "深色" &&
      afterRollback.json?.ssh?.hosts?.some(
        (entry) => entry.id === "second-box",
      ) &&
      afterRollback.json?.未知的键?.保留 === true,
    `theme=${afterRollback.json?.theme} hosts=${afterRollback.json?.ssh?.hosts?.length}`,
  );
  const writable = await runtimeCall("PATCH", "/api/settings", {
    terminal: { backend: "direct" },
  });
  step(
    "the Runtime writes settings again once the epoch is back",
    writable.status === 200 && writable.json?.terminal?.backend === "direct",
    `HTTP ${writable.status}`,
  );
  const settledAgain = await runtimeCall("GET", "/api/ownership/domains");
  step(
    "the settings record names the Runtime at the epoch it was handed",
    (settledAgain.json ?? []).some(
      (record) =>
        record.domain === "settings" &&
        record.owner === "runtime" &&
        record.epoch === "3",
    ),
    (settledAgain.json ?? [])
      .map((record) => `${record.domain}=${record.owner}@${record.epoch}`)
      .join(" "),
  );
}
