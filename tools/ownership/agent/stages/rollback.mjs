// 第 7 步：回滚。反向包回到 Runtime 自己的六张表里，所以 Host 任期内记下的东西
// 在 Runtime 侧读得出来，Runtime 也重新开始做决定。
import { join } from "node:path";
import { note, step } from "../report.mjs";

export async function rollbackAgentToRuntime(
  harness,
  { workspaceId, nodeId, targetId, handoffId },
) {
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
}
