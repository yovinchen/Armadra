// 第 9 步：同一套状态机，改由 HTTPS 驱动。Host 这次是开着的，维护窗口是本机同用户
// 控制通道签发的一次性令牌——只有「有人在这台机器前」的证明变了，状态机没有变。令牌
// 不能用第二次，反向导出的落盘位置由 Host 自己决定，而不是客户端指名。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refusal } from "../../../canvas-ownership-shapes.mjs";
import {
  appOrigin,
  hostBinary,
  hostData,
  hostDiagnostics,
  hostEnv,
  run,
  runtimeBinary,
  runtimeCall,
  runtimeDatabase,
  runtimeEnv,
  runtimeOrigin,
  startHost,
  startRuntime,
  step,
  stopRuntime,
  workspace,
} from "../harness.mjs";

export async function switchOverHttps({
  client,
  workspaceId,
  canvasId,
  documentPath,
}) {
  // Everything above moved the epoch with the Host stopped: the data directory
  // lock was the maintenance window. This section does it the other way round —
  // the Host serving, the switch arriving over HTTPS, and the window made of a
  // token issued at this machine over the same-user control channel. Only the
  // proof that someone is at the machine changes; the state machine does not.
  await stopRuntime();
  const secondExport = join(workspace, "export-2");
  const exportedAgain = JSON.parse(
    run(
      runtimeBinary,
      [
        "export",
        "--database",
        runtimeDatabase,
        "--destination",
        secondExport,
        "--output",
        "json",
      ],
      { env: runtimeEnv },
    ),
  );
  const importedAgain = JSON.parse(
    run(
      hostBinary,
      [
        "import",
        "--bundle",
        secondExport,
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the post-rollback canvas exports and stages again",
    importedAgain.exportId === exportedAgain.exportId &&
      importedAgain.state === "staged",
    `importId=${importedAgain.importId?.slice(0, 8)} entities=${importedAgain.entityCount}`,
  );

  step(
    "the Host restarted with the Runtime database it may hand the epoch to",
    await startHost(),
    hostDiagnostics,
  );
  const onlineTicket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "canvas-e2e-https",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const onlineHello = await client.driver.hello();
  step(
    "Hello advertises the ownership surface",
    onlineHello.capabilities?.includes("ownership.domains.v1") === true,
    onlineHello.capabilities?.join(", "),
  );
  await client.driver.pair(JSON.stringify(onlineTicket));
  await client.driver.connect(workspaceId);

  const listed = await client.driver.ownership("list", []);
  step(
    "the authenticated client is told which side writes each of the six domains",
    Array.isArray(listed) &&
      listed.length === 6 &&
      listed[0].domain === "canvas" &&
      listed[0].owner === "runtime" &&
      listed[0].epoch === 3n &&
      listed
        .slice(1)
        .every((entry) => entry.owner === "runtime" && entry.epoch === 1n),
    Array.isArray(listed)
      ? listed.map((entry) => `${entry.domain}=${entry.owner}`).join(" ")
      : refusal(listed),
  );

  const refusedWithoutWindow = await client.driver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "host",
      expectedEpoch: 3n,
      importId: importedAgain.importId,
      maintenanceToken: "0123456789abcdef0123456789abcdef",
    },
  ]);
  step(
    "a switch carrying a token this Host never issued is refused",
    refusedWithoutWindow.error?.failure === "permission",
    `${refusedWithoutWindow.error?.failure ?? "accepted"} HTTP ${refusedWithoutWindow.error?.httpStatus ?? 200}`,
  );

  // The token comes from the control channel, which only a same-user process on
  // this machine can reach. A browser cannot ask for one; an operator can.
  const window = JSON.parse(
    run(
      hostBinary,
      [
        "ownership",
        "window",
        "--domain",
        "canvas",
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the control channel issued a maintenance window for the canvas domain",
    typeof window.token === "string" &&
      window.token.length === 64 &&
      window.domain === "canvas" &&
      Number(window.expiresAtUnixMs) > Date.now(),
    `expires in ${Math.round((Number(window.expiresAtUnixMs) - Date.now()) / 1000)}s`,
  );

  const switchedOnline = await client.driver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "host",
      expectedEpoch: 3n,
      importId: importedAgain.importId,
      maintenanceToken: window.token,
    },
  ]);
  step(
    "the HTTPS switch moved the epoch to the Host",
    switchedOnline.ownership?.owner === 2 &&
      switchedOnline.ownership?.epoch === 4n &&
      switchedOnline.report?.matched === true,
    `owner=${switchedOnline.ownership?.owner} epoch=${switchedOnline.ownership?.epoch}${refusal(switchedOnline)}`,
  );
  const replayedWindow = await client.driver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "runtime",
      expectedEpoch: 4n,
      maintenanceToken: window.token,
    },
  ]);
  step(
    "the same token cannot open a second window",
    replayedWindow.error?.failure === "permission",
    `${replayedWindow.error?.failure ?? "accepted"} HTTP ${replayedWindow.error?.httpStatus ?? 200}`,
  );

  step(
    "the Runtime restarted under the Host-owned epoch",
    await startRuntime(),
    runtimeOrigin,
  );
  const movedOnline = await runtimeCall("GET", "/api/ownership");
  step(
    "the Runtime agrees the Host owns the canvas at the epoch it was handed",
    movedOnline.json?.owner === "host" && movedOnline.json?.epoch === "4",
    `owner=${movedOnline.json?.owner} epoch=${movedOnline.json?.epoch}`,
  );
  const refusedOnline = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "HTTPS 切换后不应创建" },
  );
  step(
    "the Runtime refuses canvas writes after the HTTPS switch, and still reads",
    refusedOnline.status === 409 &&
      refusedOnline.json?.code === "ownership_moved" &&
      (await runtimeCall("GET", documentPath)).status === 200,
    `HTTP ${refusedOnline.status} ${refusedOnline.json?.code}`,
  );

  // A change that exists only on the Host, so the reverse import below has
  // something the Runtime cannot already have.
  const onlineDocument = await client.driver.call("getDocument", [canvasId]);
  const onlineEdit = await client.driver.call("saveDocument", [
    {
      operationId: `canvas/${workspaceId}/${canvasId}/https-1`,
      canvas: { ...onlineDocument.canvas, name: "HTTPS 期间只在 Host 上改名" },
      expectedRevision: onlineDocument.canvas.revision,
      nodes: onlineDocument.nodes,
      edges: onlineDocument.edges,
      annotations: onlineDocument.annotations,
    },
  ]);
  step(
    "the Host accepted a write under the epoch it was handed over HTTPS",
    onlineEdit.document?.canvas?.name === "HTTPS 期间只在 Host 上改名" &&
      onlineEdit.document?.canvas?.revision ===
        onlineDocument.canvas.revision + 1n,
    `revision ${onlineDocument.canvas?.revision} → ${onlineEdit.document?.canvas?.revision}${refusal(onlineEdit)}`,
  );

  // Rolling back over HTTPS names no directory: a browser must not choose paths
  // on this machine, so the Host allocates one under its own data directory.
  // It is otherwise the same handback the CLI ran in section 7 — the package
  // goes to the Runtime, the Runtime re-reads its rows, and the epoch moves
  // only if the digests agree. No --accept-export-only anywhere.
  await stopRuntime();
  const rollbackWindow = JSON.parse(
    run(
      hostBinary,
      [
        "ownership",
        "window",
        "--domain",
        "canvas",
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  const rolledBackOnline = await client.driver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "runtime",
      expectedEpoch: 4n,
      maintenanceToken: rollbackWindow.token,
    },
  ]);
  step(
    "the HTTPS rollback handed the epoch back to the Runtime",
    rolledBackOnline.ownership?.owner === 1 &&
      rolledBackOnline.ownership?.epoch === 5n,
    `owner=${rolledBackOnline.ownership?.owner} epoch=${rolledBackOnline.ownership?.epoch}${refusal(rolledBackOnline)}`,
  );
  const onlineChecks = Object.fromEntries(
    (rolledBackOnline.report?.checks ?? []).map((check) => [
      check.check,
      check.matched === true,
    ]),
  );
  step(
    "the HTTPS rollback moved the epoch on the Runtime's own re-read too",
    onlineChecks["reverse.import"] === true &&
      onlineChecks["reverse.workspaces"] === true &&
      onlineChecks["reverse.unsupported_entity"] === true,
    Object.keys(onlineChecks).join(", "),
  );
  const exportRoot = join(hostData, "ownership-exports");
  const packages = existsSync(exportRoot)
    ? readdirSync(exportRoot).filter((name) => name.startsWith("canvas-"))
    : [];
  const onlinePackage = packages.at(0);
  const onlineIndex = onlinePackage
    ? JSON.parse(
        readFileSync(join(exportRoot, onlinePackage, "export.json"), "utf8"),
      )
    : null;
  step(
    "the Host wrote its reverse export where it chose, not where a client asked",
    packages.length === 1 &&
      onlineIndex?.formatVersion === 2 &&
      onlineIndex?.domain === "canvas" &&
      onlineIndex?.epoch === 4 &&
      (onlineIndex?.files?.length ?? 0) >= 1 &&
      onlineIndex.files.every((file) =>
        /^[0-9a-f]{64}$/.test(file.contentSha256 ?? ""),
      ),
    `${packages.join(", ")} epoch=${onlineIndex?.epoch}`,
  );

  step(
    "the Runtime restarted after the HTTPS reversal",
    await startRuntime(),
    runtimeOrigin,
  );
  // The whole point of doing this over HTTPS rather than with a danger switch:
  // what the Host wrote while it owned the canvas is in the Runtime's own rows.
  const afterHttpsRollback = await runtimeCall("GET", documentPath);
  step(
    "the Runtime reads back the edit the Host made under the HTTPS epoch",
    afterHttpsRollback.status === 200 &&
      afterHttpsRollback.json?.board?.name === "HTTPS 期间只在 Host 上改名",
    `name=${afterHttpsRollback.json?.board?.name} HTTP ${afterHttpsRollback.status}`,
  );
  const afterOnline = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "HTTPS 回滚之后" },
  );
  step(
    "a canvas write to the Runtime succeeds again after the HTTPS rollback",
    afterOnline.status === 200,
    `HTTP ${afterOnline.status}`,
  );
  const finalDomains = await client.driver.ownership("list", []);
  step(
    "every domain reads back as the Runtime's, each on its own epoch",
    Array.isArray(finalDomains) &&
      finalDomains.every((entry) => entry.owner === "runtime") &&
      finalDomains[0].epoch === 5n &&
      finalDomains.slice(1).every((entry) => entry.epoch === 1n),
    Array.isArray(finalDomains)
      ? finalDomains.map((entry) => `${entry.domain}@${entry.epoch}`).join(" ")
      : refusal(finalDomains),
  );
}
