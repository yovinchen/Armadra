// 第 6 步：一次交接。准备只冻结不投递，接受才排队并如实记下结果，包已经进了
// 目标的收件箱；而一次谁也撤不回的投递，记录不许说它没发生过。
import { refusal, step } from "../report.mjs";

export async function settleHandoff(
  harness,
  { driver, stream, workspaceId, nodeId, targetId },
) {
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

  return { handoffId };
}
