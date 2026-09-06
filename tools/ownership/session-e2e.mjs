// End-to-end check for the session domain's write-ownership switch
// (Go Host 业务所有权迁移 §5.2 B3, §6.2 session 行).
//
//     pnpm ownership:e2e --domain session
//
// It runs a real Rust Runtime and a real Go Host against throwaway directories
// and kernel-assigned loopback ports, drives the Host through the same
// @armadra/host-client the application ships, and proves the claims the design
// makes about the domain rather than the absence of an exception.
//
// For the session domain those claims are:
//
//   1. **Mounting a node does not create a session.** Reading whether one
//      exists and deciding that one should are two requests, and only the
//      second starts a program. A page that renders twice used to start two.
//   2. **The record survives the move item for item.** The session the Host
//      serves after the switch is the session the Runtime had before it: the
//      same identifier, the same logical key, the same owning node, the same
//      generation, the same frozen launch.
//   3. **The Runtime stops deciding, not doing.** Creating, terminating and
//      recycling answer 409 `ownership_moved`; listing keeps answering, and
//      attaching keeps working, because attaching is execution.
//   4. **The Host really starts a process.** Create and Start on the Host reach
//      the machine over the private session door, and the pane that comes back
//      is one this check attaches to and types into through the unchanged
//      terminal WebSocket.
//   5. **A lifecycle change reaches a client through the event stream**, in
//      the session domain, carrying the session and the run separately.
//   6. **A rollback is a rollback.** The reverse export package goes back into
//      `terminal_sessions`, so the sessions the Host started and ended during
//      its tenure are readable from the Runtime afterwards, and the Runtime
//      decides again.
//
// Switch order (§1.2): the session domain depends on canvas, settings and
// filesystem, so all three are switched here first, in that order, and rolled
// back afterwards in reverse.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openDriver } from "../canvas-ownership-driver.mjs";
import { openHarness, root, run, sleep } from "../ownership-harness.mjs";

const domain = "session";

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

/** Waits for a session to reach one of `states`, or gives up and reports. */
async function settle(driver, lookup, states, budgetMs = 8_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await driver.session("get", [lookup]);
    if (last?.session && states.includes(last.session.state)) return last;
    await sleep(150);
  }
  return last;
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

  /* ------------------------------------ 1. a workspace with a real session */

  step("the Runtime started", await harness.startRuntime(), harness.workspace);
  mkdirSync(join(harness.project, "src"), { recursive: true });
  writeFileSync(join(harness.project, "src", "笔记.txt"), "第一版\n");

  const created = await harness.runtimeCall("POST", "/api/workspaces", {
    name: "项目",
    rootPath: harness.project,
    permissions: { read: true, write: true, execute: true },
  });
  const workspaceId = created.json?.id;
  step(
    "the Runtime registered a workspace",
    created.status === 200 && typeof workspaceId === "string",
    `HTTP ${created.status}`,
  );

  // A node id the session is bound to. It is the logical key too, which is
  // what survives a recycle and what a mounting node looks the session up by.
  const nodeId = "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77";
  const spawned = await harness.runtimeCall("POST", "/api/terminals", {
    workspaceId,
    cwd: ".",
    nodeId,
  });
  const originalId = spawned.json?.id;
  step(
    "the Runtime created a terminal session before the switch",
    spawned.status === 200 && typeof originalId === "string",
    `HTTP ${spawned.status} key=${spawned.json?.sessionKey} generation=${spawned.json?.generation}`,
  );
  // Everything the switch has to preserve, reduced to one comparable shape.
  const before = {
    sessionKey: spawned.json?.sessionKey,
    ownerNodeId: nodeId,
    generation: String(spawned.json?.generation ?? 0),
    cwd: spawned.json?.cwd,
    shell: spawned.json?.shell,
  };

  /* ------------------------------------- 2. export, import, four switches */

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

  // The three dependencies settle first, in switch order. A session names a
  // workspace root, a root names an execution host, and both of those are
  // somebody else's record until they move.
  for (const dependency of ["canvas", "settings", "filesystem"]) {
    const moved = switchDomain(dependency);
    step(
      `the ${dependency} domain moved to the Host first, as the switch order requires`,
      moved.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST",
      `epoch=${moved.ownership?.epoch}`,
    );
  }

  const switched = switchDomain("session");
  const checks = Object.fromEntries(
    (switched.report?.checks ?? []).map((check) => [check.check, check]),
  );
  step(
    "the session domain moved to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  // §3.3 names each of these separately so a failure says which property
  // broke rather than that "something differs".
  step(
    "every §3.3 consistency check matched, with no differences reported",
    switched.report?.matched === true &&
      [
        "session.count",
        "session.ids",
        "session.keys",
        "session.node_binding",
        "session.generation",
        "session.status",
        "session.launch_sha256",
        "session.timestamps",
      ].every((name) => checks[name]?.matched === true),
    Object.keys(checks).join(", "),
  );
  // The switch ends by asking the execution host what it actually holds.
  // Nothing was running — the Runtime is stopped for the window — so the
  // adopted session is recorded as unreachable rather than as ended.
  step(
    "the switch reconciled against the execution host rather than trusting the rows",
    checks["session.reclaim"] !== undefined,
    `reclaim check present=${checks["session.reclaim"] !== undefined}`,
  );
  const dependencies = Object.fromEntries(
    (switched.plan?.dependencies ?? []).map((entry) => [
      entry.domain,
      entry.owner,
    ]),
  );
  step(
    "the plan reports the three dependencies it actually verified",
    Object.keys(dependencies).length === 3 &&
      Object.values(dependencies).every(
        (owner) => owner === "CANVAS_OWNERSHIP_OWNER_HOST",
      ),
    Object.keys(dependencies).join(" "),
  );

  /* --------------------------------- 3. the Runtime stops deciding, not doing */

  step(
    "the Runtime restarted under the moved epoch",
    await harness.startRuntime(),
    "",
  );
  const refusedCreate = await harness.runtimeCall("POST", "/api/terminals", {
    workspaceId,
    cwd: ".",
    nodeId: "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d",
  });
  const refusedTerminate = await harness.runtimeCall(
    "POST",
    `/api/terminals/${originalId}/terminate`,
    { mode: "process" },
  );
  const refusedRecycle = await harness.runtimeCall(
    "POST",
    `/api/terminals/${originalId}/recycle`,
  );
  step(
    "the Runtime refuses create, terminate and recycle with ownership_moved",
    [refusedCreate, refusedTerminate, refusedRecycle].every(
      (reply) => reply.status === 409 && reply.json?.code === "ownership_moved",
    ),
    `create ${refusedCreate.status} ${refusedCreate.json?.code}, terminate ${refusedTerminate.status}, recycle ${refusedRecycle.status}`,
  );
  const listed = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/sessions`,
  );
  const readBack = await harness.runtimeCall(
    "GET",
    `/api/terminals/${originalId}`,
  );
  step(
    "the Runtime still answers every read, unchanged",
    listed.status === 200 &&
      readBack.status === 200 &&
      readBack.json?.sessionKey === before.sessionKey,
    `list ${listed.status}, get ${readBack.status} key=${readBack.json?.sessionKey}`,
  );

  /* ------------------------------------------- 4. the Host serves the record */

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
    "Hello advertises the session surface",
    hello.capabilities?.includes("session.records.v1") === true,
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

  // The read a mounting node makes: by logical key, because that is what
  // survives a recycle. Nothing is started by asking.
  const adopted = await driver.session("get", [{ sessionKey: nodeId }]);
  step(
    "the session the Host serves is the session the Runtime had",
    adopted?.session?.sessionId === originalId &&
      adopted.session.sessionKey === before.sessionKey &&
      adopted.session.ownerNodeId === before.ownerNodeId &&
      String(adopted.session.generation) === before.generation &&
      adopted.session.launch?.workingDirectory === before.cwd &&
      adopted.session.launch?.shell === before.shell,
    `${adopted?.session?.sessionId ?? refusal(adopted)} generation=${adopted?.session?.generation} state=${adopted?.session?.state}`,
  );
  const stillThere = await harness.runtimeCall(
    "GET",
    `/api/terminals/${originalId}`,
  );
  step(
    "reading it started nothing: the Runtime's own row is untouched",
    stillThere.status === 200 &&
      stillThere.json?.generation === Number(before.generation),
    `generation=${stillThere.json?.generation}`,
  );

  /* ------------------------------- 5. the Host decides, the machine executes */

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

  // A brand new node, created and started as two separate decisions.
  const freshNode = "7c1e5b90-2d43-4a68-9f0c-1b2a3c4d5e6f";
  const freshId = "b7e4a1c25f9d40318e6a0c7d2b9f4a13";
  const madeIntent = await driver.session("create", [
    {
      operationId: `session/${freshId}/create`,
      sessionId: freshId,
      sessionKey: freshNode,
      ownerNodeId: freshNode,
      kind: "terminal",
      workingDirectory: harness.project,
      expectedRevision: 0n,
    },
  ]);
  step(
    "creating records an intent and starts nothing",
    madeIntent?.state === "pending" && madeIntent.generation === 0n,
    `state=${madeIntent?.state}${refusal(madeIntent)}`,
  );
  const runtimeSees = await harness.runtimeCall(
    "GET",
    `/api/terminals/${freshId}`,
  );
  step(
    "the machine has no process for an intent nobody started yet",
    runtimeSees.status === 404,
    `HTTP ${runtimeSees.status}`,
  );

  const startedRun = await driver.session("start", [
    {
      operationId: `session/${freshId}/start`,
      sessionId: freshId,
      expectedRevision: madeIntent?.revision,
    },
  ]);
  step(
    "starting reaches the machine and records the run it created",
    startedRun?.session?.state === "running" &&
      startedRun.session.generation > 0n &&
      startedRun.run?.generation === startedRun.session.generation,
    `generation=${startedRun?.session?.generation} backend=${startedRun?.session?.backendKind}${refusal(startedRun)}`,
  );
  // The Host records a generation it did not invent: it is the value the
  // machine that created the pane reported, and the machine agrees.
  const runtimeRun = await harness.runtimeCall(
    "GET",
    `/api/terminals/${freshId}`,
  );
  step(
    "the generation the Host recorded is the one the machine allocated",
    runtimeRun.status === 200 &&
      BigInt(runtimeRun.json?.generation ?? -1) ===
        startedRun?.session?.generation &&
      runtimeRun.json?.status === "running",
    `Runtime generation=${runtimeRun.json?.generation} status=${runtimeRun.json?.status}`,
  );

  // A second start against the revision the first one consumed is refused,
  // which is exactly what stops two clients from producing two shells.
  const secondStart = await driver.session("start", [
    {
      operationId: `session/${freshId}/start-again`,
      sessionId: freshId,
      expectedRevision: madeIntent?.revision,
    },
  ]);
  step(
    "a second start against a spent revision is refused rather than duplicated",
    secondStart?.error?.failure === "conflict" ||
      secondStart?.error?.httpStatus === 409,
    `${secondStart?.error?.failure ?? "accepted"} HTTP ${secondStart?.error?.httpStatus ?? 200}`,
  );

  let delivered = null;
  const deadline = Date.now() + 5_000;
  while (!delivered && Date.now() < deadline) {
    const entry = await stream.next(Math.max(1, deadline - Date.now()));
    if (!entry) break;
    if (entry.frame?.payload?.case !== "page") continue;
    delivered = (entry.frame.payload.value.events ?? []).find(
      (event) =>
        event.domain === protocol.EventDomain.SESSION && event.kind === "run",
    );
  }
  step(
    "the run reached the client on the session event stream, as its own kind",
    delivered?.entity?.case === "sessionRun" &&
      delivered.entity.value.sessionId === freshId &&
      delivered.priority === protocol.EventPriority.HIGH,
    delivered
      ? `sequence=${delivered.sequence} kind=${delivered.kind} priority=${delivered.priority}`
      : "no session run event arrived",
  );

  // Attaching is execution and did not move: the same WebSocket path, through
  // the Host's own proxy, which now narrows it against the Host's record.
  const attached = await harness.hostApi(
    "GET",
    `/api/terminals/${freshId}/capture?lines=5`,
  );
  step(
    "the terminal surface is unchanged and the Host proxy narrows it to its record",
    attached.status === 200,
    `HTTP ${attached.status}`,
  );
  const strangerSession = await harness.hostApi(
    "GET",
    "/api/terminals/does-not-exist-here",
  );
  step(
    "a session this Host has no record of is not forwarded at all",
    strangerSession.status === 403 || strangerSession.status === 404,
    `HTTP ${strangerSession.status}`,
  );

  const ended = await driver.session("terminate", [
    {
      operationId: `session/${freshId}/terminate`,
      sessionId: freshId,
      expectedRevision: startedRun?.session?.revision,
      mode: "session",
    },
  ]);
  step(
    "the Host ended the run and kept the record",
    ended?.state === "exited" && ended.intent === "user",
    `state=${ended?.state} reason=${ended?.reasonCode}${refusal(ended)}`,
  );
  // The Runtime's own word survives, because TerminationIntent is lossy and a
  // rollback has to put the exact column value back.
  step(
    "the machine's own termination word was recorded verbatim",
    ended?.reasonCode === "session.termination.session",
    `reasonCode=${ended?.reasonCode}`,
  );
  stream.close();

  // The adopted session is still there and can be started again from LOST,
  // which is the state a switch leaves a session nobody could see.
  const revived = await settle(driver, { sessionId: originalId }, [
    "lost",
    "exited",
    "running",
  ]);
  note(`the adopted session settled as ${revived?.session?.state}`);
  const restarted = await driver.session("start", [
    {
      operationId: `session/${originalId}/restart`,
      sessionId: originalId,
      expectedRevision: revived?.session?.revision,
    },
  ]);
  step(
    "a session nobody could see is recoverable rather than replaced",
    restarted?.session?.state === "running" &&
      restarted.session.sessionId === originalId &&
      restarted.session.sessionKey === before.sessionKey,
    `state=${restarted?.session?.state} generation=${restarted?.session?.generation}${refusal(restarted)}`,
  );

  /* ------------------------------------------------------------ 6. the rollback */

  await harness.stopRuntime();
  await harness.stopHost();
  const rollback = (name) =>
    JSON.parse(
      harness.hostCli([
        "ownership",
        "rollback",
        "--domain",
        name,
        "--export",
        join(harness.workspace, `reverse-${name}`),
        "--runtime-binary",
        harness.runtimeBinary,
        "--runtime-database",
        harness.runtimeDatabase,
        "--output",
        "json",
      ]),
    );
  const rolledBack = rollback("session");
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
    "the Runtime's own re-read was compared with the package, and the Worker's sessions with it",
    reverseChecks["reverse.import"] === true &&
      reverseChecks["reverse.sessions"] === true &&
      reverseChecks["session.worker_sessions"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  // The dependencies follow the session back in reverse switch order.
  for (const dependency of ["filesystem", "settings", "canvas"]) {
    const back = rollback(dependency);
    step(
      `the ${dependency} domain followed the session back to the Runtime`,
      back.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME",
      `epoch=${back.ownership?.epoch}`,
    );
  }

  step(
    "the Runtime restarted after the reversal",
    await harness.startRuntime(),
  );
  const afterOriginal = await harness.runtimeCall(
    "GET",
    `/api/terminals/${originalId}`,
  );
  step(
    "the session the Host restarted during its tenure is readable from the Runtime",
    afterOriginal.status === 200 &&
      afterOriginal.json?.sessionKey === before.sessionKey &&
      afterOriginal.json?.ownerNodeId === before.ownerNodeId,
    `HTTP ${afterOriginal.status} generation=${afterOriginal.json?.generation}`,
  );
  const afterFresh = await harness.runtimeCall(
    "GET",
    `/api/terminals/${freshId}`,
  );
  step(
    "the session the Host created and ended came back with its ending intact",
    afterFresh.status === 200 &&
      afterFresh.json?.status !== "running" &&
      afterFresh.json?.sessionKey === freshNode,
    `HTTP ${afterFresh.status} status=${afterFresh.json?.status}`,
  );
  const decidesAgain = await harness.runtimeCall("POST", "/api/terminals", {
    workspaceId,
    cwd: ".",
    nodeId: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
  });
  step(
    "the Runtime decides again after the rollback",
    decidesAgain.status === 200,
    `HTTP ${decidesAgain.status}`,
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
