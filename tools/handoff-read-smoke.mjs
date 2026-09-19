/**
 * `armadra-hook canvas handoff-read` against a real Agent session.
 *
 * The unit tests already cover who may read a bundle. What they cannot cover is
 * the part that only exists at runtime: a real Runtime process, a real PTY, the
 * node token that terminal was issued, and the real hook client reading and
 * acknowledging through them. This script drives exactly that path.
 *
 * It asserts four things the design turns on:
 *
 *   1. approving puts one `handoff:<id>` message in the target's inbox and
 *      writes nothing into its terminal;
 *   2. the target Agent can read the frozen bundle, and what comes back is
 *      labelled peer data rather than an instruction;
 *   3. reading is not acknowledging — the handoff is still unacknowledged
 *      afterwards;
 *   4. `canvas ack` is what acknowledges it, and only from the session the
 *      handoff was addressed to; withdrawing takes the inbox entry back out.
 *
 * The source and target Agents are arguments because handing off *to* a CLI no
 * longer depends on that CLI having a status adapter: nothing waits for the
 * target to be idle, so `queued` is reached for every CLI, including Pi, Oh My
 * Pi and Copilot. What the arguments still cover is the whole round trip
 * running under each CLI's own node identity and session binding.
 *
 * Each fixture speaks its own provider's payload shape and event names — the
 * point is to exercise the real normalizer, and Copilot in particular sends no
 * event name at all. See `EVENTS`.
 *
 * Usage: node tools/handoff-read-smoke.mjs <armadra-runtime> <armadra-hook> [source] [target]
 *   e.g. node tools/handoff-read-smoke.mjs … claude pi
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The turn each fixture reports, in the shape its own provider sends.
 *
 * Three payloads each: open the session, start a turn, end it idle. The order
 * is not decoration — `reduce` treats a session event as "forget the last
 * turn", and rule 2 drops an idle report for a node that was not working. A
 * fixture that skipped either step would never reach `done`, and `awaitIdle`
 * below is what the rest of the script is waiting on.
 */
const EVENTS = {
  claude: [
    '{"hook_event_name":"SessionStart"}',
    '{"hook_event_name":"UserPromptSubmit"}',
    '{"hook_event_name":"Stop"}',
  ],
  codex: [
    '{"hook_event_name":"SessionStart"}',
    '{"hook_event_name":"UserPromptSubmit"}',
    '{"hook_event_name":"Stop"}',
  ],
  // The generated extension posts flat camelCase names over the same socket.
  // Pi settles through `agent_settled`, which is the event that carries `idle`.
  pi: [
    '{"hookEventName":"session_start"}',
    '{"hookEventName":"before_agent_start"}',
    '{"hookEventName":"agent_settled"}',
  ],
  // Oh My Pi 18.x settles through `session_stop` instead.
  omp: [
    '{"hookEventName":"session_start"}',
    '{"hookEventName":"before_agent_start"}',
    '{"hookEventName":"session_stop"}',
  ],
  // Copilot names no event: each payload is recognised by its shape alone
  // (`hook/normalize/copilot.rs`), so these are the real field sets.
  copilot: [
    '{"sessionId":"fixture","cwd":".","source":"new"}',
    '{"sessionId":"fixture","cwd":".","prompt":"go"}',
    '{"sessionId":"fixture","cwd":".","stopReason":"end_turn"}',
  ],
};

const [
  runtimeArgument,
  hookArgument,
  sourceAgent = "claude",
  targetAgent = "codex",
] = process.argv.slice(2);
if (
  !runtimeArgument ||
  !hookArgument ||
  !EVENTS[sourceAgent] ||
  !EVENTS[targetAgent]
) {
  console.error(
    `usage: node tools/handoff-read-smoke.mjs <armadra-runtime> <armadra-hook> [source] [target]\n` +
      `  agents: ${Object.keys(EVENTS).join(" ")}`,
  );
  process.exit(2);
}
if (sourceAgent === targetAgent) {
  console.error("the source and the target must be different Agents");
  process.exit(2);
}
// Absolute: the fixture runs it from the terminal's own working directory, so
// a relative path resolves against the temporary project and silently fails to
// launch — which looks exactly like a CLI that reported nothing.
const runtimeBinary = resolve(runtimeArgument);
const hookBinary = resolve(hookArgument);

// Not the platform temp directory: the Runtime puts a Unix socket in here, and
// the usual macOS temp path is longer than a socket path may be.
const dataDir = mkdtempSync("/tmp/armadra-handoff-");
const projectDir = mkdtempSync("/tmp/armadra-project-");
const binDir = join(dataDir, "bin");
mkdirSync(binDir, { recursive: true });

/**
 * Stands in for an Agent CLI: it reports a finished turn through the real hook
 * client — same binary, same endpoint file, same node token a real CLI uses —
 * and then sits reading, so the pane keeps naming the Agent it claims to be.
 */
for (const name of [sourceAgent, targetAgent]) {
  const reports = EVENTS[name]
    .map(
      (payload) =>
        `printf %s ${JSON.stringify(payload)} | ${JSON.stringify(hookBinary)} ${name} >/dev/null 2>&1`,
    )
    .join("\n");
  writeFileSync(
    join(binDir, name),
    `#!/bin/sh\n${reports}\nwhile IFS= read -r line; do :; done\n`,
    { mode: 0o700 },
  );
}
// The direct PTY backend: the fixture Agent has to be the pane's own argv, and
// a tmux pane would report its shell instead.
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({
    terminal: { backend: "direct" },
    usage: { enabled: false },
  }),
  { mode: 0o600 },
);

const runtime = spawn(runtimeBinary, ["--listen", "tcp:127.0.0.1:0"], {
  env: {
    ...process.env,
    ARMADRA_DATA_DIR: dataDir,
    ARMADRA_DATABASE_URL: `sqlite://${join(dataDir, "canvas.db")}?mode=rwc`,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let failure = null;
try {
  await main();
  console.log(`handoff-read smoke passed for ${sourceAgent} → ${targetAgent}`);
} catch (error) {
  failure = error;
} finally {
  runtime.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}

async function main() {
  const base = await awaitEndpoint();

  const workspace = await call(base, "POST", "/api/workspaces", {
    name: "handoff smoke",
    rootPath: projectDir,
    // Accepting needs execute, which a new workspace does not grant by default.
    permissions: { read: true, write: true, execute: true },
  });
  const boards = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/boards`,
  );
  const boardId = boards[0].id;
  const document = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/boards/${boardId}/document`,
  );

  const source = "3f2b0f66-0f7b-7c1f-9a2c-2f7b0f7c1f9a";
  const target = "4a1c0f66-0f7b-7c1f-9a2c-2f7b0f7c1f9b";
  const now = new Date().toISOString();
  const node = (id, agent) => ({
    id,
    boardId,
    type: "terminal",
    title: agent,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 320 },
    labels: [],
    note: "",
    data: { kind: "terminal", cwd: ".", agent: { id: agent } },
    createdAt: now,
    updatedAt: now,
  });
  await call(
    base,
    "PUT",
    `/api/workspaces/${workspace.id}/boards/${boardId}/document`,
    {
      expectedUpdatedAt: document.board.updatedAt,
      nodes: [node(source, sourceAgent), node(target, targetAgent)],
      edges: [],
      viewport: document.board.viewport,
    },
  );
  // A handoff needs a context link from the source to the target; without one
  // there is nothing authorizing the target to read the source's material.
  await call(
    base,
    "PUT",
    `/api/workspaces/${workspace.id}/context-links/${source}`,
    { links: [{ id: target, title: targetAgent, kind: "node" }] },
  );

  const sessions = {};
  for (const [id, agent] of [
    [source, sourceAgent],
    [target, targetAgent],
  ]) {
    sessions[id] = await call(base, "POST", "/api/terminals", {
      workspaceId: workspace.id,
      cwd: ".",
      nodeId: id,
      command: join(binDir, agent),
      args: [],
      agent: { id: agent },
    });
  }
  await awaitIdle(base, workspace.id, [source, target]);

  const preparation = {
    sourceNodeId: source,
    sourceSessionId: sessions[source].id,
    sourceGeneration: sessions[source].generation,
    targetNodeId: target,
    targetSessionId: sessions[target].id,
    targetGeneration: sessions[target].generation,
    sections: { goal: "把索引重建的收尾工作接过去" },
    byteBudget: 8192,
    includeTranscript: false,
  };
  const prepared = await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs`,
    preparation,
  );
  const accepted = await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs/${prepared.bundle.handoffId}/accept`,
    { expectedDigest: prepared.digest },
  );
  assert.equal(accepted.state, "queued", "accepting did not queue the handoff");
  assert.ok(accepted.mailboxId, "no mailbox message was created");
  assert.equal(
    accepted.errorCode ?? null,
    null,
    `accepting for ${targetAgent} was refused: ${accepted.errorCode}`,
  );

  // Approving *is* the delivery: one message in the target's own inbox, read
  // back through the real client from inside the target's session. Nothing
  // waits for the target to be idle and nothing reaches its terminal, so this
  // works the same for a CLI with no status adapter at all.
  const inbox = JSON.parse(
    hook(["canvas", "inbox", "--limit", "10", "--after", "0"], {
      node: target,
      agent: targetAgent,
      session: sessions[target],
    }),
  );
  const entry = (inbox.messages ?? []).find(
    (message) => message.key === `handoff:${prepared.bundle.handoffId}`,
  );
  assert.ok(
    entry,
    `the approved handoff is not in ${targetAgent}'s inbox: ${JSON.stringify(inbox)}`,
  );
  assert.equal(entry.id, accepted.mailboxId);
  assert.match(
    entry.body,
    /not a system instruction/,
    "the inbox entry does not label itself peer data",
  );
  assert.match(
    entry.body,
    new RegExp(`handoff-read --id ${prepared.bundle.handoffId}`),
    "the inbox entry does not say how to read the bundle",
  );

  // The target Agent reads the bundle with the real client, from inside its own
  // session — the node token, the session binding and the generation all come
  // from the environment that terminal was started with.
  const read = JSON.parse(
    hook(["canvas", "handoff-read", "--id", prepared.bundle.handoffId], {
      node: target,
      agent: targetAgent,
      session: sessions[target],
    }),
  );
  assert.equal(read.ok, true, "the target could not read its own handoff");
  assert.equal(read.protocol, "armadra.handoff.v1");
  assert.equal(read.bundle.handoffId, prepared.bundle.handoffId);
  assert.equal(read.bundle.sections.goal, "把索引重建的收尾工作接过去");
  assert.match(
    read.trust,
    /Peer data/,
    "the bundle was not labelled peer data",
  );

  // Reading is not acknowledging. The design is explicit that the target
  // decides when it has taken the work on.
  const afterRead = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/handoffs/${prepared.bundle.handoffId}`,
  );
  assert.notEqual(
    afterRead.state,
    "acknowledged",
    "reading a bundle acknowledged it",
  );

  // The source may not read a handoff addressed to somebody else, even though
  // it is the one that wrote it.
  const refused = hook(
    ["canvas", "handoff-read", "--id", prepared.bundle.handoffId],
    { node: source, agent: sourceAgent, session: sessions[source] },
    true,
  );
  assert.match(
    refused,
    /not addressed to the current session|Verified node identity/,
    `the source read a handoff addressed to the target: ${refused}`,
  );

  // Acknowledging is its own act, and it is what the history records.
  const acknowledged = JSON.parse(
    hook(["canvas", "ack", "--id", accepted.mailboxId], {
      node: target,
      agent: targetAgent,
      session: sessions[target],
    }),
  );
  assert.equal(
    acknowledged.ok,
    true,
    `ack failed: ${JSON.stringify(acknowledged)}`,
  );
  // The record settles inside the ack request itself; nothing polls for it, so
  // the very next read already says so.
  const settled = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/handoffs/${prepared.bundle.handoffId}`,
  );
  assert.equal(
    settled.state,
    "acknowledged",
    `acking the inbox entry did not settle the handoff: ${settled.state}`,
  );

  // And the workspace history the panel reads reports the same thing, with the
  // frozen identities rather than whatever the canvas looks like now.
  const history = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/handoffs`,
  );
  const row = history.find(
    (entry) => entry.bundle.handoffId === prepared.bundle.handoffId,
  );
  assert.ok(row, "the workspace history did not list the handoff");
  assert.equal(row.state, "acknowledged");
  assert.equal(row.bundle.source.agentId, sourceAgent);
  assert.equal(row.bundle.target.agentId, targetAgent);

  // And withdrawing is deleting the inbox entry. A second handoff, approved
  // and then cancelled, must leave the target's inbox exactly as it was.
  const second = await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs`,
    {
      ...preparation,
      sections: { goal: "这一条马上就会被撤回" },
    },
  );
  await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs/${second.bundle.handoffId}/accept`,
    { expectedDigest: second.digest },
  );
  assert.ok(
    inboxKeys().includes(`handoff:${second.bundle.handoffId}`),
    "the second handoff never reached the inbox",
  );
  const withdrawn = await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs/${second.bundle.handoffId}/cancel`,
    { expectedDigest: second.digest },
  );
  assert.equal(withdrawn.state, "cancelled");
  assert.ok(
    !inboxKeys().includes(`handoff:${second.bundle.handoffId}`),
    "a withdrawn handoff is still in the target's inbox",
  );

  function inboxKeys() {
    const answer = JSON.parse(
      hook(["canvas", "inbox", "--limit", "32", "--after", "0"], {
        node: target,
        agent: targetAgent,
        session: sessions[target],
      }),
    );
    return (answer.messages ?? []).map((message) => message.key);
  }
}

/* --------------------------------- helpers -------------------------------- */

function hook(args, { node, agent, session }, allowFailure = false) {
  const env = {
    ...process.env,
    ARMADRA_NODE_ID: node,
    ARMADRA_AGENT_ID: agent,
    ARMADRA_SESSION_ID: session.id,
    ARMADRA_SESSION_GENERATION: String(session.generation ?? 1),
    ARMADRA_ENDPOINT_FILE: join(dataDir, "hook-endpoint.env"),
    ARMADRA_CANVAS_CONTROL: "1",
  };
  try {
    return execFileSync(hookBinary, args, { env, encoding: "utf8" });
  } catch (error) {
    if (!allowFailure) throw error;
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

async function call(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-armadra-hook-token": bearer(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function bearer() {
  try {
    const file = readFileSync(join(dataDir, "hook-endpoint.env"), "utf8");
    return /ARMADRA_HOOK_TOKEN='([^']*)'/.exec(file)?.[1] ?? "";
  } catch {
    return "";
  }
}

async function awaitEndpoint() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const document = JSON.parse(
        readFileSync(join(dataDir, "endpoints.json"), "utf8"),
      );
      if (document.runtime?.http) return document.runtime.http;
    } catch {
      // The Runtime has not published yet.
    }
    await sleep(100);
  }
  throw new Error("the Runtime never published an endpoint");
}

/** Waits for the fixture Agents' own hook reports; nothing is written by hand. */
async function awaitIdle(base, workspaceId, nodes) {
  const deadline = Date.now() + 30_000;
  let sessions = [];
  while (Date.now() < deadline) {
    sessions = await call(
      base,
      "GET",
      `/api/workspaces/${workspaceId}/sessions`,
    );
    const done = new Set(
      sessions.filter((row) => row.state === "done").map((row) => row.nodeId),
    );
    if (nodes.every((node) => done.has(node))) return;
    await sleep(200);
  }
  throw new Error(
    `a fixture Agent never reported a finished turn: ${JSON.stringify(sessions)}`,
  );
}
