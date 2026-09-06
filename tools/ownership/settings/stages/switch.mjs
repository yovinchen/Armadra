// 第 3–4 步：canvas 先落到 Host，settings 才被允许跟上；随后 Runtime 只读——写入
// 回 409 `ownership_moved`，读还照常回答，这正是回滚可行的前提。
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  digestOf,
  hostBinary,
  hostData,
  hostEnv,
  ownershipCli,
  run,
  runtimeBinary,
  runtimeCall,
  runtimeDatabase,
  runtimeEnv,
  runtimeOrigin,
  runtimeTarget,
  settingsShape,
  startRuntime,
  step,
  workspace,
} from "../harness.mjs";

export async function switchSettingsToHost({ runtimeDigest }) {
  const exportDirectory = join(workspace, "export");
  const exported = JSON.parse(
    run(
      runtimeBinary,
      [
        "export",
        "--database",
        runtimeDatabase,
        "--destination",
        exportDirectory,
        "--output",
        "json",
      ],
      { env: runtimeEnv },
    ),
  );
  const imported = JSON.parse(
    run(
      hostBinary,
      [
        "import",
        "--bundle",
        exportDirectory,
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the canvas domain was exported and staged so settings has its prerequisite",
    imported.exportId === exported.exportId && imported.state === "staged",
    `importId=${imported.importId?.slice(0, 8)} entities=${imported.entityCount}`,
  );
  const canvasSwitched = JSON.parse(
    ownershipCli("switch", [
      "--domain",
      "canvas",
      "--import-id",
      imported.importId,
      ...runtimeTarget,
    ]),
  );
  step(
    "the canvas domain settled on the Host",
    canvasSwitched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      canvasSwitched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED",
    `epoch=${canvasSwitched.ownership?.epoch}`,
  );

  const settingsImportId = `settings-${randomUUID().replaceAll("-", "")}`;
  const switched = JSON.parse(
    ownershipCli("switch", [
      "--domain",
      "settings",
      "--import-id",
      settingsImportId,
      ...runtimeTarget,
    ]),
  );
  const switchChecks = switched.report?.checks ?? [];
  const named = switchChecks.map((check) => check.check);
  step(
    "the settings switch moved the epoch to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  step(
    "the switch compared the document, its keys and its execution hosts",
    switched.report?.matched === true &&
      named.includes("settings.document_sha256") &&
      named.includes("settings.keys") &&
      named.includes("settings.execution_hosts") &&
      switchChecks.every((check) => !check.differences?.length),
    named.join(", "),
  );

  /* ------------------ 4. the Runtime refuses settings writes, still reads */

  step(
    "the Runtime restarted after the maintenance window",
    await startRuntime(),
    runtimeOrigin,
  );
  const refused = await runtimeCall("PATCH", "/api/settings", {
    terminal: { backend: "direct" },
  });
  step(
    "the Runtime refuses settings writes with ownership_moved",
    refused.status === 409 && refused.json?.code === "ownership_moved",
    `HTTP ${refused.status} ${refused.json?.code}`,
  );
  const readBack = await runtimeCall("GET", "/api/settings");
  step(
    "the Runtime still answers settings reads, unchanged by the refusal",
    readBack.status === 200 &&
      digestOf(settingsShape(readBack.json)) === runtimeDigest,
    `sha256=${digestOf(settingsShape(readBack.json ?? {})).slice(0, 16)}`,
  );
  const canvasStillWritable = await runtimeCall(
    "GET",
    "/api/ownership/domains",
  );
  step(
    "only the two switched domains moved; the other four still name the Runtime",
    (canvasStillWritable.json ?? []).filter((record) => record.owner === "host")
      .length === 2,
    (canvasStillWritable.json ?? [])
      .map((record) => `${record.domain}=${record.owner}`)
      .join(" "),
  );
}
