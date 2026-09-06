// 第 4–5 步：Host 开始服务这批记录，逐项对上——包括那些「没有值」的地方；然后
// 它开始做决定，并把决定经事件流说出去。
import { join } from "node:path";
import { openDriver } from "../../../canvas-ownership-driver.mjs";
import { root, run } from "../../../ownership-harness.mjs";
import { refusal, step } from "../report.mjs";

export async function hostServesAgentRecords(
  harness,
  { protocol, workspaceId, nodeId, targetId },
) {
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

  return { driver, stream };
}
