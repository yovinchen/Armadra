// End-to-end check for one business domain's write-ownership switch
// (Go Host 业务所有权迁移 §5.2, §6.2).
//
//     pnpm ownership:e2e --domain filesystem
//
// It runs a real Rust Runtime and a real Go Host against throwaway directories
// and kernel-assigned loopback ports, drives the Host through the same
// @armadra/host-client the application ships, and proves the claims the design
// makes about the domain rather than the absence of an exception.
//
// For the filesystem domain those claims are:
//
//   1. **Nothing about the files moves.** The switch moves the *decision* —
//      where a workspace's files are and who may touch them. Reading and
//      writing files keeps working through the Runtime the whole time, at every
//      phase of the switch, and this check writes a file under Host ownership
//      to prove it.
//   2. **The registration survives the move item for item.** The root the Host
//      serves after the switch is the root the Runtime had before it: the same
//      path, the same execution host, the same three permission bits.
//   3. **The Runtime stops deciding.** Registering a workspace or changing its
//      permissions answers 409 `ownership_moved`; every read keeps answering.
//   4. **A permission change reaches a client through the event stream**, in
//      the filesystem domain, carrying the root it changed.
//   5. **The Host also stops deciding for the Runtime.** Once a permission is
//      revoked on the Host, the Host's own proxy refuses the forwarded file
//      request — it narrows against its record, not against the Runtime's row,
//      which is the record the switch retired.
//   6. **A rollback is a rollback.** The reverse export package goes back into
//      the Runtime's own rows, so the change the Host made during its tenure is
//      readable from the Runtime afterwards and the Runtime writes again.
//
// Switch order (§1.2): the filesystem domain depends on canvas and settings.
// The canvas is switched here first. The settings domain has no projector on
// this Host yet, so it cannot be switched at all — the state machine skips a
// dependency it could never satisfy, which is what lets one domain land before
// the domain in front of it has been built. The step below states that
// explicitly rather than leaving it to be inferred from a passing run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openDriver } from "../canvas-ownership-driver.mjs";
import { openHarness, root, run, sleep } from "../ownership-harness.mjs";

const domain = "filesystem";

const results = [];
function step(name, ok, detail = "") {
  results.push({ name, ok });
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark}${name}${detail ? `  — ${detail}` : ""}`);
}
function note(text) {
  console.log(`  note  ${text}`);
}
function refusal(value) {
  return value?.error
    ? ` (${value.error.failure} HTTP ${value.error.httpStatus})`
    : "";
}

const harness = await openHarness({ label: "ownership-e2e" });
let failure = null;
try {
  for (const binary of [harness.runtimeBinary, harness.hostBinary]) {
    if (!existsSync(binary))
      throw new Error(
        `${binary} is missing. Build both first:\n  cargo build -p armadra-runtime\n  go -C apps/host build -o ../../target/armadra-host ./cmd/armadra-host`,
      );
  }
  if (!existsSync(join(root, "packages/host-client/dist/index.js")))
    throw new Error("run `pnpm libs:build` first");
  const protocol = await import(
    pathToFileURL(join(root, "packages/protocol/dist/index.js")).href
  );

  /* ------------------------------------------- 1. a workspace with real files */

  step("the Runtime started", await harness.startRuntime(), harness.workspace);
  mkdirSync(join(harness.project, "src"), { recursive: true });
  writeFileSync(join(harness.project, "src", "笔记.txt"), "第一版\n");

  const created = await harness.runtimeCall("POST", "/api/workspaces", {
    name: "项目",
    rootPath: harness.project,
    permissions: { read: true, write: true, execute: false },
  });
  const workspaceId = created.json?.id;
  step(
    "the Runtime registered a workspace root",
    created.status === 200 && typeof workspaceId === "string",
    `HTTP ${created.status} root=${created.json?.rootPath}`,
  );

  // Everything the switch has to preserve, reduced to one comparable shape.
  const shapeOf = (source) => ({
    rootPath: source.rootPath,
    executionHostId: source.executionHostId ?? "",
    read: source.permissions.read,
    write: source.permissions.write,
    execute: source.permissions.execute,
  });
  const before = shapeOf(created.json);

  // An overwrite carries the content version the editor read, so a save that
  // raced another writer is refused rather than applied blind.
  const readBefore = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent("src/笔记.txt")}`,
  );
  const wrote = await harness.runtimeCall(
    "PUT",
    `/api/workspaces/${workspaceId}/file`,
    {
      path: "src/笔记.txt",
      content: "第二版\n",
      expectedSha256: readBefore.json?.sha256,
    },
  );
  step(
    "a file write through the Runtime lands before the switch",
    readBefore.status === 200 && wrote.status === 200,
    `read ${readBefore.status}, write ${wrote.status}`,
  );

  /* ------------------------------------------- 2. export, import, two switches */

  // The export reads the database file and the ownership command drives a
  // Worker that writes to it. Stopping the Runtime first is the maintenance
  // window: no second writer while the epoch moves.
  await harness.stopRuntime();
  const exportDirectory = join(harness.workspace, "export");
  const exported = JSON.parse(
    run(
      harness.runtimeBinary,
      [
        "export",
        "--database",
        harness.runtimeDatabase,
        "--destination",
        exportDirectory,
        "--output",
        "json",
      ],
      { env: harness.runtimeEnv },
    ),
  );
  const imported = JSON.parse(
    harness.hostCli([
      "import",
      "--bundle",
      exportDirectory,
      "--output",
      "json",
    ]),
  );
  step(
    "the Host staged the Runtime's export",
    typeof imported.importId === "string" &&
      imported.exportId === exported.exportId &&
      imported.state === "staged",
    `importId=${imported.importId?.slice(0, 8)} entities=${imported.entityCount}`,
  );

  const switchDomain = (name) =>
    JSON.parse(
      harness.hostCli([
        "ownership",
        "switch",
        "--domain",
        name,
        "--import-id",
        imported.importId,
        "--runtime-binary",
        harness.runtimeBinary,
        "--runtime-database",
        harness.runtimeDatabase,
        "--output",
        "json",
      ]),
    );

  // The canvas has to settle on the Host first: the filesystem's roots are
  // projected from workspace rows the canvas switch staged.
  const canvas = switchDomain("canvas");
  step(
    "the canvas moved to the Host first, as the switch order requires",
    canvas.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST",
    `epoch=${canvas.ownership?.epoch}`,
  );
  note(
    "the settings domain has no projector on this Host yet, so it cannot be switched; " +
      "the state machine skips a dependency it could never satisfy (§1.2)",
  );

  const switched = switchDomain("filesystem");
  const checks = Object.fromEntries(
    (switched.report?.checks ?? []).map((check) => [check.check, check]),
  );
  step(
    "the filesystem domain moved to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  step(
    "every consistency check matched, with no differences reported",
    switched.report?.matched === true &&
      Object.keys(checks).length >= 3 &&
      Object.values(checks).every((check) => !check.differences?.length),
    Object.keys(checks).join(", "),
  );
  // The switch verified the dependency it could, and only that one.
  step(
    "the plan reports the dependency it actually verified",
    (switched.plan?.dependencies ?? []).length === 1 &&
      switched.plan.dependencies[0].domain ===
        "WRITE_OWNERSHIP_DOMAIN_CANVAS" &&
      switched.plan.dependencies[0].owner === "CANVAS_OWNERSHIP_OWNER_HOST",
    (switched.plan?.dependencies ?? [])
      .map((entry) => `${entry.domain}=${entry.owner}`)
      .join(" "),
  );

  /* ----------------------------------- 3. the Runtime stops deciding, not doing */

  step(
    "the Runtime restarted under the moved epoch",
    await harness.startRuntime(),
    "",
  );
  const refusedPermissions = await harness.runtimeCall(
    "PATCH",
    `/api/workspaces/${workspaceId}`,
    { permissions: { read: true, write: true, execute: true } },
  );
  const refusedRegistration = await harness.runtimeCall(
    "POST",
    "/api/workspaces",
    { name: "第二个", rootPath: join(harness.workspace, "another") },
  );
  step(
    "the Runtime refuses registration and permission writes with ownership_moved",
    refusedPermissions.status === 409 &&
      refusedPermissions.json?.code === "ownership_moved" &&
      refusedRegistration.status === 409 &&
      refusedRegistration.json?.code === "ownership_moved",
    `permissions ${refusedPermissions.status} ${refusedPermissions.json?.code}, registration ${refusedRegistration.status} ${refusedRegistration.json?.code}`,
  );
  const listed = await harness.runtimeCall("GET", "/api/workspaces");
  step(
    "the Runtime still answers reads, unchanged",
    listed.status === 200 &&
      JSON.stringify(shapeOf(listed.json?.[0] ?? {})) ===
        JSON.stringify(before),
    `HTTP ${listed.status}`,
  );
  // The whole point of the domain: the machine keeps executing.
  const current = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent("src/笔记.txt")}`,
  );
  const stillWriting = await harness.runtimeCall(
    "PUT",
    `/api/workspaces/${workspaceId}/file`,
    {
      path: "src/笔记.txt",
      content: "Host 拥有期间写入\n",
      expectedSha256: current.json?.sha256,
    },
  );
  const stillReading = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent("src/笔记.txt")}`,
  );
  step(
    "files are still read and written while the Host owns the domain",
    stillWriting.status === 200 &&
      stillReading.status === 200 &&
      stillReading.json?.content === "Host 拥有期间写入\n",
    `write ${stillWriting.status}, read ${stillReading.status}`,
  );

  /* ------------------------------------------------ 4. the Host serves the root */

  step("the Host started", await harness.startHost(), harness.appOrigin);
  const { driver } = await openDriver({
    root,
    workspace: harness.workspace,
    appOrigin: harness.appOrigin,
    driverFile: join(harness.workspace, "driver.js"),
    skipApplication: true,
    nodeTransport: () => harness.transport(),
    run,
  });
  const hello = await driver.hello();
  step(
    "Hello advertises the filesystem surface",
    hello.capabilities?.includes("filesystem.roots.v1") === true,
    hello.capabilities?.join(", "),
  );
  const ticket = JSON.parse(
    harness.hostCli([
      "pair",
      "--origin",
      harness.appOrigin,
      "--device-name",
      "ownership-e2e",
    ]),
  );
  await driver.pair(JSON.stringify(ticket));
  await driver.connect(workspaceId);

  const hostRoot = await driver.filesystem("getRoot", []);
  step(
    "the root the Host serves is the root the Runtime had",
    JSON.stringify(
      shapeOf({
        rootPath: hostRoot.canonicalPath,
        executionHostId: hostRoot.executionHostId,
        permissions: hostRoot.permissions,
      }),
    ) === JSON.stringify(before),
    `${hostRoot.canonicalPath ?? refusal(hostRoot)} revision=${hostRoot.revision}`,
  );

  /* ------------------------------ 5. a permission change, on the stream and the proxy */

  const stream = await harness.openStream(protocol);
  step(
    "the client opened the Host's event stream",
    stream.upgraded,
    stream.handshake,
  );
  stream.send({
    payload: {
      case: "subscribe",
      value: {
        afterSequence: 0n,
        workspaceIds: [workspaceId],
        pageBytes: 65536,
      },
    },
  });
  // Drain the catch-up pages so the next one is the change made below.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entry = await stream.next(1_000);
    if (!entry) break;
    const page = entry.frame?.payload?.value;
    if (entry.frame?.payload?.case === "page" && page?.hasMore === false) break;
  }

  const readOnly = await driver.filesystem("updateRoot", [
    {
      operationId: `filesystem/${workspaceId}/revoke-write`,
      permissions: { read: true, write: false, execute: false },
      expectedRevision: hostRoot.revision,
    },
  ]);
  step(
    "the Host accepted a permission change under its own epoch",
    readOnly.permissions?.write === false &&
      readOnly.revision === hostRoot.revision + 1n,
    `revision ${hostRoot.revision} → ${readOnly.revision}${refusal(readOnly)}`,
  );

  let delivered = null;
  const deadline = Date.now() + 5_000;
  while (!delivered && Date.now() < deadline) {
    const entry = await stream.next(Math.max(1, deadline - Date.now()));
    if (!entry) break;
    if (entry.frame?.payload?.case !== "page") continue;
    delivered = (entry.frame.payload.value.events ?? []).find(
      (event) => event.domain === protocol.EventDomain.FILESYSTEM,
    );
  }
  step(
    "the permission change reached the client on the filesystem event stream",
    delivered?.kind === "root" &&
      delivered.entityId === workspaceId &&
      delivered.entity?.case === "filesystemRoot" &&
      delivered.entity.value.permissions?.write === false,
    delivered
      ? `sequence=${delivered.sequence} kind=${delivered.kind}`
      : "no filesystem event arrived",
  );

  // The Host narrows a forwarded file request against its own record now. The
  // Runtime's row still says write is allowed, and that row is exactly the one
  // the switch retired.
  const proxied = await harness.hostApi(
    "GET",
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent("src/笔记.txt")}`,
  );
  const stale = await harness.runtimeCall("GET", `/api/workspaces`);
  step(
    "the Host's proxy narrows against the Host's record, not the Runtime's row",
    proxied.status === 200 && stale.json?.[0]?.permissions?.write === true,
    `proxied read ${proxied.status}, Runtime row still says write=${stale.json?.[0]?.permissions?.write}`,
  );

  const revoked = await driver.filesystem("updateRoot", [
    {
      operationId: `filesystem/${workspaceId}/revoke-read`,
      permissions: { read: false, write: false, execute: false },
      expectedRevision: readOnly.revision,
    },
  ]);
  const refused = await harness.hostApi(
    "GET",
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent("src/笔记.txt")}`,
  );
  step(
    "revoking read on the Host refuses the forwarded request",
    revoked.permissions?.read === false && refused.status === 403,
    `HTTP ${refused.status}${refusal(revoked)}`,
  );
  // Restore something worth carrying back, so the rollback has a change to
  // prove rather than a no-op.
  const granted = await driver.filesystem("updateRoot", [
    {
      operationId: `filesystem/${workspaceId}/grant-execute`,
      permissions: { read: true, write: true, execute: true },
      expectedRevision: revoked.revision,
    },
  ]);
  step(
    "the Host granted execute while it owned the domain",
    granted.permissions?.execute === true,
    `revision=${granted.revision}${refusal(granted)}`,
  );
  stream.close();

  /* ------------------------------------------------------------ 6. the rollback */

  await harness.stopRuntime();
  await harness.stopHost();
  const reverse = join(harness.workspace, "reverse");
  const rolledBack = JSON.parse(
    harness.hostCli([
      "ownership",
      "rollback",
      "--domain",
      "filesystem",
      "--export",
      reverse,
      "--runtime-binary",
      harness.runtimeBinary,
      "--runtime-database",
      harness.runtimeDatabase,
      "--output",
      "json",
    ]),
  );
  const reverseChecks = Object.fromEntries(
    (rolledBack.report?.checks ?? []).map((check) => [
      check.check,
      check.matched === true,
    ]),
  );
  step(
    "the rollback handed the epoch back without accepting an export-only reversal",
    rolledBack.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      rolledBack.ownership?.epoch === "3",
    `owner=${rolledBack.ownership?.owner} epoch=${rolledBack.ownership?.epoch}`,
  );
  step(
    "the Runtime's own re-read was compared with the package, and the Worker's roots with it",
    reverseChecks["reverse.import"] === true &&
      reverseChecks["reverse.workspaces"] === true &&
      reverseChecks["filesystem.worker_roots"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  // The canvas follows the filesystem back: a workspace patch touches both
  // domains, so leaving the canvas on the Host would refuse it for a reason
  // this section is not about.
  const canvasBack = JSON.parse(
    harness.hostCli([
      "ownership",
      "rollback",
      "--domain",
      "canvas",
      "--export",
      join(harness.workspace, "reverse-canvas"),
      "--runtime-binary",
      harness.runtimeBinary,
      "--runtime-database",
      harness.runtimeDatabase,
      "--output",
      "json",
    ]),
  );
  step(
    "the canvas followed the filesystem back to the Runtime",
    canvasBack.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME",
    `epoch=${canvasBack.ownership?.epoch}`,
  );

  step(
    "the Runtime restarted after the reversal",
    await harness.startRuntime(),
  );
  const after = await harness.runtimeCall("GET", "/api/workspaces");
  step(
    "the Runtime reads back the permission the Host changed during its tenure",
    after.status === 200 &&
      after.json?.[0]?.permissions?.execute === true &&
      after.json?.[0]?.rootPath === before.rootPath,
    `execute=${after.json?.[0]?.permissions?.execute} root=${after.json?.[0]?.rootPath}`,
  );
  const writesAgain = await harness.runtimeCall(
    "PATCH",
    `/api/workspaces/${workspaceId}`,
    { permissions: { read: true, write: true, execute: false } },
  );
  step(
    "the Runtime decides again after the rollback",
    writesAgain.status === 200 &&
      writesAgain.json?.permissions?.execute === false,
    `HTTP ${writesAgain.status}`,
  );
  const readsFile = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent("src/笔记.txt")}`,
  );
  step(
    "the file written under Host ownership is still there, unchanged",
    readsFile.status === 200 &&
      readsFile.json?.content === "Host 拥有期间写入\n",
    `HTTP ${readsFile.status}`,
  );
} catch (error) {
  failure = error;
} finally {
  await harness.stopRuntime?.().catch?.(() => {});
  await harness.stopHost?.().catch?.(() => {});
  await sleep(50);
  harness.teardown();
}

if (failure) {
  console.error(`\n  FAIL  ${failure.message}`);
  const diagnostics = harness.diagnostics();
  if (diagnostics.runtime) console.error(`\nRuntime:\n${diagnostics.runtime}`);
  if (diagnostics.host) console.error(`\nHost:\n${diagnostics.host}`);
  process.exit(1);
}
const failed = results.filter((entry) => !entry.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed for the ${domain} domain`,
);
if (failed.length > 0) {
  const diagnostics = harness.diagnostics();
  if (diagnostics.runtime) console.error(`\nRuntime:\n${diagnostics.runtime}`);
  if (diagnostics.host) console.error(`\nHost:\n${diagnostics.host}`);
  process.exit(1);
}
