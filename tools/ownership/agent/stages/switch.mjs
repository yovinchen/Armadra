// 第 2–3 步：四个被依赖的域先落到 Host，agent 域才跟上；随后 Runtime 只是不再
// 决定——写入回 409 `ownership_moved`，读还照常回答，Hook 也照旧报到本机。
import { join } from "node:path";
import { run } from "../../../ownership-harness.mjs";
import { step } from "../report.mjs";

export async function switchAgentToHost(
  harness,
  { workspaceId, nodeId, targetId, hookReport },
) {
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
}
