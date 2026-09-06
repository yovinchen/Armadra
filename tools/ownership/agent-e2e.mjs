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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openHarness, root, sleep } from "../ownership-harness.mjs";
import { results } from "./agent/report.mjs";
import { prepareAgentRecords } from "./agent/stages/prepare.mjs";
import { switchAgentToHost } from "./agent/stages/switch.mjs";
import { hostServesAgentRecords } from "./agent/stages/host-records.mjs";
import { settleHandoff } from "./agent/stages/handoff.mjs";
import { rollbackAgentToRuntime } from "./agent/stages/rollback.mjs";

const domain = "agent";

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

  const { workspaceId, nodeId, targetId, hookReport } =
    await prepareAgentRecords(harness);
  await switchAgentToHost(harness, {
    workspaceId,
    nodeId,
    targetId,
    hookReport,
  });
  const { driver, stream } = await hostServesAgentRecords(harness, {
    protocol,
    workspaceId,
    nodeId,
    targetId,
  });
  const { handoffId } = await settleHandoff(harness, {
    driver,
    stream,
    workspaceId,
    nodeId,
    targetId,
  });
  await rollbackAgentToRuntime(harness, {
    workspaceId,
    nodeId,
    targetId,
    handoffId,
  });
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
