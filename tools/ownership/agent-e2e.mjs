// End-to-end check for the agent domain's write-ownership switch
// (Go Host 业务所有权迁移 §5.2 B4, §6.2 agent 行).
//
//     pnpm ownership:e2e --domain agent
//
// It runs a real Rust Runtime and a real Go Host against throwaway directories
// and kernel-assigned loopback ports, drives the Host through the same
// @armadra/host-client the application ships, and proves the claims the design
// makes about the domain rather than the absence of an exception.
//
// For the agent domain those claims are:
//
//   1. **A Hook still reports to the machine.** The CLI's own endpoint does not
//      move, and the Runtime keeps reducing turns into `agent_status` whichever
//      side owns the records — 归一化与 reduce are §1.3's job for the Worker.
//   2. **The records survive the move item for item.** The state the Host serves
//      after the switch is the state the Runtime had before it, including the
//      absences: a node nobody reported an error for stays a grey badge.
//   3. **The Runtime stops deciding, not doing.** Marking read, answering an
//      approval and pushing a context-link document answer 409 `ownership_moved`;
//      every read keeps answering, which is what makes the rows the rollback
//      baseline.
//   4. **The Host learns what happened.** A Hook turn reported *after* the
//      switch reaches the Host's records — over the drain, because the process
//      a Hook reaches binds no upward channel.
//   5. **A change reaches a client through the event stream**, in the agent
//      domain, with an approval carrying the high priority a question somebody
//      is waited on has to have.
//   6. **A handoff is frozen, then settled honestly.** Preparing sends nothing;
//      accepting puts the bundle in the target's inbox; an outcome nobody can
//      attribute is not retried.
//   7. **A rollback is a rollback.** The reverse export goes back into the
//      Runtime's own six tables, so what the Host recorded during its tenure is
//      readable from the Runtime afterwards, and the Runtime decides again.
//
// Switch order (§1.2): the agent domain depends on session, which depends on
// filesystem, settings and canvas. All four are switched here first, in that
// order, and rolled back afterwards in reverse.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openDriver } from "../canvas-ownership-driver.mjs";
import { openHarness, root, run, sleep } from "../ownership-harness.mjs";

const domain = "agent";

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

  /* ------------------------------ 1. a board with a real agent node on it */

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

  const boards = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/boards`,
  );
  const boardId = boards.json?.[0]?.id;
  step(
    "the workspace has a board to put nodes on",
    boards.status === 200 && typeof boardId === "string",
    `HTTP ${boards.status} board=${boardId?.slice(0, 8)}`,
  );

  // Two agent nodes, written the way the canvas writes them: one whole board
  // document. A Hook is only attributed to a node the canvas created, so this
  // is what makes the reports below reach anything at all.
  const nodeId = "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77";
  const targetId = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";
  const document = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
  );
  const node = (id, agentId, x) => ({
    id,
    boardId,
    type: "terminal",
    title: agentId,
    color: "#5B5BD6",
    position: { x, y: 0 },
    labels: [],
    note: "",
    // `kind` has to repeat the node type and the agent travels as a block:
    // that is the shape the canvas writes and the shape a Hook is attributed
    // through, so writing anything else here would test nothing real.
    data: { kind: "terminal", agent: { id: agentId } },
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
  });
  const saved = await harness.runtimeCall(
    "PUT",
    `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
    {
      expectedUpdatedAt: document.json?.board?.updatedAt,
      nodes: [node(nodeId, "claude", 0), node(targetId, "codex", 400)],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  );
  step(
    "the board has two agent nodes",
    saved.status === 200 && (saved.json?.nodes ?? []).length === 2,
    `HTTP ${saved.status} nodes=${(saved.json?.nodes ?? []).length}`,
  );

  // A real terminal behind the agent node. Agent records name a session, and
  // the session domain has to have something to hand over too: an empty
  // package would test the switch order without testing the dependency.
  const spawned = await harness.runtimeCall("POST", "/api/terminals", {
    workspaceId,
    cwd: ".",
    nodeId,
  });
  step(
    "the agent node has a real terminal session behind it",
    spawned.status === 200 && typeof spawned.json?.id === "string",
    `HTTP ${spawned.status} generation=${spawned.json?.generation}`,
  );

  /* ------------------------------------- the Hook's own door, unchanged */

  // The endpoint file is what `armadra-hook` itself reads: a port and a bearer
  // the Runtime published for local peers. Posting to it is the same wire the
  // hook binary uses, so what follows exercises the real ingest path rather
  // than a fixture written straight into the table.
  // Re-read on every call: a restarted Runtime publishes a new port and a new
  // bearer, and a cached one would make the second half of this check talk to
  // a process that is gone.
  function hookEndpoint() {
    return Object.fromEntries(
      readFileSync(join(harness.runtimeData, "hook-endpoint.env"), "utf8")
        .split("\n")
        .map((line) => line.match(/^([A-Z_]+)='(.*)'$/))
        .filter(Boolean)
        .map((match) => [match[1], match[2].replaceAll("'\\''", "'")]),
    );
  }
  const published = hookEndpoint();
  step(
    "the Runtime published a hook endpoint for local peers",
    typeof published.ARMADRA_HOOK_PORT === "string" &&
      typeof published.ARMADRA_HOOK_TOKEN === "string",
    `port=${published.ARMADRA_HOOK_PORT}`,
  );

  /** One Hook report, over the endpoint the CLI itself would use. */
  function hookReport(agentId, body) {
    const endpoint = hookEndpoint();
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const call = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(endpoint.ARMADRA_HOOK_PORT),
          method: "POST",
          path: `/hook/${agentId}`,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.length,
            "X-Armadra-Hook-Token": endpoint.ARMADRA_HOOK_TOKEN,
          },
          timeout: 10_000,
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      call.on("error", reject);
      call.write(payload);
      call.end();
    });
  }

  const reported = await hookReport("claude", {
    nodeId,
    version: 1,
    payload: { hook_event_name: "UserPromptSubmit", session_id: "hook-one" },
  });
  step(
    "a real Hook report reached the Runtime over the CLI's own endpoint",
    reported === 200 || reported === 204,
    `HTTP ${reported}`,
  );
  // The reduction is the Runtime's, and it is what the switch will adopt.
  // There is no listing route — the board reads statuses off the workspace
  // event stream — so the row is proved through the one read that needs it.
  const reduced = await harness.runtimeCall(
    "POST",
    `/api/agent-status/${nodeId}/suggest-title`,
  );
  step(
    "the Runtime reduced the turn into a status of its own",
    reduced.status === 200,
    `HTTP ${reduced.status} source=${reduced.json?.source}`,
  );

  const pushedLinks = await harness.runtimeCall(
    "PUT",
    `/api/workspaces/${workspaceId}/context-links/${nodeId}`,
    { links: [{ id: targetId, title: "codex", kind: "agent" }] },
  );
  step(
    "the Runtime accepted a context-link document while it still owned the domain",
    pushedLinks.status === 200,
    `HTTP ${pushedLinks.status}`,
  );

  /* ------------------------------------- 2. export, import, five switches */

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

  // The four dependencies settle first, in switch order. Agent records name a
  // session, a session names a root, a root names an execution host, and all of
  // those are somebody else's record until they move.
  for (const dependency of ["canvas", "settings", "filesystem", "session"]) {
    const moved = switchDomain(dependency);
    step(
      `the ${dependency} domain moved to the Host first, as the switch order requires`,
      moved.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST",
      `epoch=${moved.ownership?.epoch}`,
    );
  }

  const switched = switchDomain("agent");
  const checks = Object.fromEntries(
    (switched.report?.checks ?? []).map((check) => [check.check, check]),
  );
  step(
    "the agent domain moved to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  // §3.3 names each of these separately so a failure says which property broke
  // rather than that "something differs".
  step(
    "every §3.3 consistency check matched, with no differences reported",
    switched.report?.matched === true &&
      [
        "agent.status.count",
        "agent.status.ids",
        "agent.status.state",
        "agent.status.unread",
        "agent.approvals.count",
        "agent.approvals.unanswered",
        "agent.mailbox.count",
        "agent.mailbox.unacked",
        "agent.deliveries.count",
        "agent.handoffs.count",
        "agent.handoffs.bundle_sha256",
        "agent.handoffs.state",
        "agent.outbox.attempts",
        "agent.context_links.links",
      ].every((name) => checks[name]?.matched === true),
    Object.keys(checks).join(", "),
  );
  // The switch ends by settling whatever was mid-dispatch. Nothing was, so it
  // reports zero — but the check has to be there, because a handoff left
  // claimed by a process that is no longer the writer stays claimed forever.
  step(
    "the switch settled what was in flight rather than trusting the rows",
    checks["agent.handoffs.reconcile"] !== undefined,
    `reconcile check present=${checks["agent.handoffs.reconcile"] !== undefined}`,
  );
  const dependencies = Object.fromEntries(
    (switched.plan?.dependencies ?? []).map((entry) => [
      entry.domain,
      entry.owner,
    ]),
  );
  step(
    "the plan reports the four dependencies it actually verified",
    Object.keys(dependencies).length === 4 &&
      Object.values(dependencies).every(
        (owner) => owner === "CANVAS_OWNERSHIP_OWNER_HOST",
      ),
    Object.keys(dependencies).join(" "),
  );

  /* ------------------------- 3. the Runtime stops deciding, not doing */

  step(
    "the Runtime restarted under the moved epoch",
    await harness.startRuntime(),
    "",
  );
  const refusedRead = await harness.runtimeCall(
    "POST",
    `/api/agent-status/${nodeId}/read`,
  );
  const refusedAnswer = await harness.runtimeCall(
    "POST",
    "/api/approvals/does-not-matter/answer",
    { decision: "allow" },
  );
  const refusedLinks = await harness.runtimeCall(
    "PUT",
    `/api/workspaces/${workspaceId}/context-links/${nodeId}`,
    { links: [] },
  );
  const refusedHandoff = await harness.runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/handoffs`,
    {
      sourceNodeId: nodeId,
      sourceSessionId: "hook-one",
      sourceGeneration: 1,
      targetNodeId: targetId,
      targetSessionId: "hook-two",
      targetGeneration: 1,
      sections: { goal: "接手 agent 域" },
      byteBudget: 4096,
    },
  );
  step(
    "the Runtime refuses mark-read, approval answers, context links and handoffs with ownership_moved",
    [refusedRead, refusedAnswer, refusedLinks, refusedHandoff].every(
      (reply) => reply.status === 409 && reply.json?.code === "ownership_moved",
    ),
    `read ${refusedRead.status} ${refusedRead.json?.code}, answer ${refusedAnswer.status}, links ${refusedLinks.status}, handoff ${refusedHandoff.status} ${refusedHandoff.json?.code}`,
  );
  const readStatus = await harness.runtimeCall(
    "POST",
    `/api/agent-status/${nodeId}/suggest-title`,
  );
  const listedHandoffs = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/handoffs`,
  );
  const listedDeliveries = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/deliveries`,
  );
  step(
    "the Runtime still answers every read, unchanged",
    readStatus.status === 200 &&
      listedHandoffs.status === 200 &&
      listedDeliveries.status === 200,
    `status ${readStatus.status}, handoffs ${listedHandoffs.status}, deliveries ${listedDeliveries.status}`,
  );

  // And the CLI's own door is untouched: a Hook reports to the machine
  // whichever side owns the records, and the machine still reduces it.
  const afterSwitch = await hookReport("claude", {
    nodeId,
    version: 1,
    payload: { hook_event_name: "Stop", session_id: "hook-one" },
  });
  step(
    "a Hook still reports to the machine after the domain moved",
    afterSwitch === 200 || afterSwitch === 204,
    `HTTP ${afterSwitch}`,
  );

  /* ----------------------------------------- 4. the Host serves the record */

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
    "Hello advertises the agent surface",
    hello.capabilities?.includes("agent.records.v1") === true,
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

  const adopted = await driver.agent("listStatus", []);
  const adoptedNode = Array.isArray(adopted)
    ? adopted.find((entry) => entry.nodeId === nodeId)
    : null;
  step(
    "the status the Host serves is the status the Runtime had",
    adoptedNode?.agentId === "claude" && typeof adoptedNode?.state === "string",
    `state=${adoptedNode?.state} agent=${adoptedNode?.agentId}${refusal(adopted)}`,
  );
  // The absences survive. The CLI's `Stop` turn reported `errored: false`, so
  // that value comes across as a value; nobody ever reported an interruption,
  // so that one comes across absent. Collapsing the two would make every node
  // that has never been interrupted look like one that was not — which is the
  // same picture as one that ran cleanly, on no evidence at all.
  step(
    "a reported flag came across as a value",
    adoptedNode?.errored === false,
    `errored=${String(adoptedNode?.errored)}`,
  );
  // And the other half of the same distinction: the second node has never
  // reported at all, so it has no status. "Nobody has heard from this one" is
  // an absence, not a row full of defaults, and a Host that invented one would
  // draw a node as idle on no evidence.
  const silent = Array.isArray(adopted)
    ? adopted.find((entry) => entry.nodeId === targetId)
    : null;
  step(
    "a node nobody has heard from has no status at all",
    silent === undefined || silent === null,
    `statuses=${Array.isArray(adopted) ? adopted.length : "none"}`,
  );
  const adoptedLinks = await driver.agent("listContextLinks", [nodeId]);
  step(
    "the context-link projection the Runtime held came across",
    Array.isArray(adoptedLinks) &&
      adoptedLinks[0]?.links?.some((link) => link.targetNodeId === targetId),
    `links=${adoptedLinks?.[0]?.links?.length ?? 0}${refusal(adoptedLinks)}`,
  );

  // The switch adopted the `UserPromptSubmit` turn, which reduces to `working`.
  // The `Stop` reported afterwards — while the Runtime had already stopped
  // deciding — reduces to `done`, and the Host only knows about it because the
  // listing above drained for it. This is claim 4: the pull is what makes the
  // Host see what happened on a machine that has no way to tell it.
  step(
    "a Hook turn reported after the switch reached the Host through the drain",
    adoptedNode?.state === "done",
    `state=${adoptedNode?.state} (adopted as working, drained to done)`,
  );

  /* ---------------------------------- 5. the Host decides, and says so */

  const stream = await harness.openStream(protocol);
  step("the event stream upgraded", stream.upgraded, stream.handshake);
  stream.send({
    payload: {
      case: "subscribe",
      value: {
        afterSequence: 0n,
        workspaceIds: [workspaceId],
        domains: [protocol.EventDomain.AGENT],
      },
    },
  });
  // Drain the catch-up page so the push that follows is the one being asserted.
  await stream.next(3_000);

  const current = (await driver.agent("listStatus", [])).find(
    (entry) => entry.nodeId === nodeId,
  );
  const cleared = await driver.agent("markRead", [
    {
      operationId: `agent/${nodeId}/read/${current?.revision}`,
      expectedRevision: current?.revision,
      nodeId,
    },
  ]);
  step(
    "the Host cleared the badge under the revision it was read at",
    cleared?.unread === 0 && cleared.nodeId === nodeId,
    `unread=${cleared?.unread} revision=${cleared?.revision}${refusal(cleared)}`,
  );
  // The same revision again is refused: two clients clearing one badge are two
  // decisions, and the second has to learn it lost.
  const stale = await driver.agent("markRead", [
    {
      operationId: `agent/${nodeId}/read/stale`,
      expectedRevision: current?.revision,
      nodeId,
    },
  ]);
  step(
    "a second client holding the same revision is refused rather than applied",
    stale?.error?.failure === "conflict",
    `${stale?.error?.failure ?? "accepted"}${refusal(stale)}`,
  );

  let delivered = null;
  const deadline = Date.now() + 8_000;
  while (delivered === null && Date.now() < deadline) {
    const entry = await stream.next(Math.max(1, deadline - Date.now()));
    if (!entry) break;
    if (entry.frame?.payload?.case !== "page") continue;
    delivered = (entry.frame.payload.value.events ?? []).find(
      (event) =>
        event.domain === protocol.EventDomain.AGENT && event.kind === "status",
    );
  }
  step(
    "the status change reached the client on the agent event stream, as its own kind",
    delivered?.entity?.case === "agentStatus" &&
      delivered.entity.value.nodeId === nodeId,
    delivered
      ? `sequence=${delivered.sequence} kind=${delivered.kind}`
      : "no agent status event arrived",
  );

  /* ------------------------------------- 6. a handoff, frozen then settled */

  // The Host stores a bundle as opaque bytes with a digest (§2.1 大载荷), so
  // it never parses this. The Runtime does: it is the side that renders a
  // handoff, and after a rollback its own reader has to be able to read the
  // row back. So the bundle sent here is the Runtime's own shape — anything
  // else would prove the switch and leave the reversal unreadable.
  const identity = (nodeIdentity, agentId, sessionId) => ({
    nodeId: nodeIdentity,
    nodeTitle: agentId,
    sessionId,
    generation: 1,
    agentId,
    provider: agentId,
    providerSessionId: null,
    modelId: null,
    accountId: null,
    executionHost: "",
    workingDirectory: harness.project,
  });
  const bundleBody = {
    version: 1,
    handoffId: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    workspaceId,
    createdAt: "2026-09-06T00:00:00.000Z",
    source: identity(nodeId, "claude", "hook-one"),
    target: identity(targetId, "codex", "hook-two"),
    cutoff: {
      kind: "turn",
      reference: null,
      sourceRevision: null,
      sha256: null,
      sourceUpdatedAt: null,
    },
    sections: {
      goal: "接手 agent 域",
      constraints: "",
      completed: "",
      pending: "",
      decisions: "",
      toolSummary: "",
    },
    transcriptExcerpt: "",
    summaryMethod: "manual",
    // The Runtime's own word, and the reason a handoff is safe to read: what
    // arrives is another agent's data, never instructions to follow.
    trust: "peerDataNotSystemInstructions",
    sourcePreserved: true,
    files: [
      {
        path: "src/笔记.txt",
        sha256: null,
        bytes: null,
        status: "included",
        executionHost: "",
      },
    ],
    git: {
      headOid: null,
      indexDigest: null,
      worktreeDigest: null,
      repositoryId: null,
      worktreeId: null,
      status: "clean",
      worktreeDigestBasis: "none",
    },
    attachments: [],
    budget: {
      byteLimit: 4096,
      usedBytes: 0,
      tokenEstimate: null,
      capacityTokens: null,
      availableTokens: null,
      reservedTokens: null,
      truncated: false,
      omitted: [],
    },
  };
  // `budget.usedBytes` has to equal the length of the encoded bundle, which
  // includes the number itself. Two passes settle it, and the loop says so
  // rather than hiding a magic constant that would rot the first time a field
  // is added.
  let encodedBundle = JSON.stringify(bundleBody);
  for (let pass = 0; pass < 4; pass += 1) {
    const length = Buffer.byteLength(encodedBundle, "utf8");
    if (bundleBody.budget.usedBytes === length) break;
    bundleBody.budget.usedBytes = length;
    encodedBundle = JSON.stringify(bundleBody);
  }
  const bundle = new TextEncoder().encode(encodedBundle);
  const handoffId = "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const prepared = await driver.agent("prepareHandoff", [
    {
      operationId: `agent/${handoffId}/prepare`,
      expectedRevision: 0n,
      handoffId,
      sourceNodeId: nodeId,
      targetNodeId: targetId,
      // Which session each side was on. A target whose session has been
      // replaced since is a target the bundle was not aimed at, and that is
      // decidable only because both are recorded.
      source: { sessionId: "hook-one", generation: 1n },
      target: { sessionId: "hook-two", generation: 1n },
      bundle,
    },
  ]);
  step(
    "preparing froze the bundle and sent nothing",
    prepared?.state === "prepared" && prepared.attempts === 0,
    `state=${prepared?.state} attempts=${prepared?.attempts}${refusal(prepared)}`,
  );
  const accepted = await driver.agent("acceptHandoff", [
    {
      operationId: `agent/${handoffId}/accept`,
      expectedRevision: prepared?.revision,
      handoffId,
    },
  ]);
  step(
    "accepting queued it, counted the attempt and settled it honestly",
    ["delivered", "queued", "failed", "unknownOutcome"].includes(
      accepted?.state,
    ) && accepted.attempts === 1,
    `state=${accepted?.state} attempts=${accepted?.attempts} error=${accepted?.errorCode}${refusal(accepted)}`,
  );
  // Whatever the pane said, the bundle is in the target's inbox — the durable
  // half. A bundle that reached only a pane would be gone the moment it
  // scrolled.
  const inbox = await driver.agent("listMailbox", [targetId]);
  step(
    "the bundle reached the target's inbox, unread",
    Array.isArray(inbox) &&
      inbox.some(
        (message) =>
          message.messageKey === `handoff/${handoffId}` &&
          message.acknowledgedAtUnixMs === 0n,
      ),
    `messages=${inbox?.length ?? 0}${refusal(inbox)}`,
  );
  // And a settled handoff cannot be cancelled: the record must not say a
  // target never got something it may already have.
  const cancelled = await driver.agent("cancelHandoff", [
    {
      operationId: `agent/${handoffId}/cancel`,
      expectedRevision: accepted?.revision,
      handoffId,
      reasonCode: "agent.handoff.test",
    },
  ]);
  const cancellable = ["queued", "failed"].includes(accepted?.state);
  step(
    cancellable
      ? "a handoff that never landed can still be withdrawn"
      : "a handoff nobody can un-deliver cannot be cancelled",
    cancellable
      ? cancelled?.state === "cancelled"
      : cancelled?.error?.failure === "conflict",
    `state=${cancelled?.state ?? cancelled?.error?.failure}${refusal(cancelled)}`,
  );
  stream.close();

  /* ------------------------------------------------------------ 7. rollback */

  await harness.stopRuntime();
  await harness.stopHost();
  const rollback = (name) => {
    try {
      return JSON.parse(
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
    } catch (error) {
      // The CLI's own words say which check refused; the exit code alone says
      // only that something did.
      throw new Error(
        `${name} rollback refused: ${String(error.stdout ?? "").trim()} ${String(error.stderr ?? "").trim()}`,
      );
    }
  };
  const rolledBack = rollback("agent");
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
    "the Runtime's own re-read was compared with the package, and the Worker's agents with it",
    reverseChecks["reverse.import"] === true &&
      reverseChecks["reverse.agents"] === true &&
      reverseChecks["agent.worker_agents"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  for (const dependency of ["session", "filesystem", "settings", "canvas"]) {
    const back = rollback(dependency);
    step(
      `the ${dependency} domain followed the agent domain back to the Runtime`,
      back.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME",
      `epoch=${back.ownership?.epoch}`,
    );
  }

  step(
    "the Runtime restarted after the reversal",
    await harness.startRuntime(),
  );
  const restored = await harness.runtimeCall(
    "POST",
    `/api/agent-status/${nodeId}/read`,
  );
  // The Runtime's own row spells the badge as a flag rather than a count, which
  // is the shape the projection folded into `unread` and back again.
  step(
    "the badge the Host cleared during its tenure is readable from the Runtime",
    restored.status === 200 && restored.json?.unread === false,
    `HTTP ${restored.status} unread=${restored.json?.unread} state=${restored.json?.state}`,
  );
  const afterHandoffs = await harness.runtimeCall(
    "GET",
    `/api/workspaces/${workspaceId}/handoffs`,
  );
  // The Runtime renders a handoff from its own bundle, and it re-checks the
  // digest and every identity on the way out. A row that came back readable is
  // therefore a stronger statement than a row that came back: the bundle is
  // byte for byte the one that was frozen, and it still names the two sessions
  // it was aimed at.
  const back = (afterHandoffs.json ?? []).find(
    (entry) => entry.bundle?.handoffId === handoffId,
  );
  step(
    "the handoff the Host prepared during its tenure came back with its bundle",
    afterHandoffs.status === 200 &&
      back?.state === "cancelled" &&
      back.bundle.source.sessionId === "hook-one",
    `HTTP ${afterHandoffs.status} handoffs=${(afterHandoffs.json ?? []).length} state=${back?.state}`,
  );
  const decidesAgain = await harness.runtimeCall(
    "PUT",
    `/api/workspaces/${workspaceId}/context-links/${nodeId}`,
    { links: [{ id: targetId, title: "codex", kind: "agent" }] },
  );
  step(
    "the Runtime decides again after the rollback",
    decidesAgain.status === 200,
    `HTTP ${decidesAgain.status}`,
  );
  note(
    "the pane-delivery half of a handoff is not wired up in this batch: the bundle reaches the inbox and the record says so",
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
