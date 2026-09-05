/**
 * `armadra-hook canvas handoff-read` against a real Agent session.
 *
 * The unit tests already cover who may read a bundle. What they cannot cover is
 * the part that only exists at runtime: a real Runtime process, a real PTY, the
 * node token that terminal was issued, and the real hook client reading and
 * acknowledging through them. This script drives exactly that path.
 *
 * It asserts three things the design turns on:
 *
 *   1. the target Agent can read the frozen bundle, and what comes back is
 *      labelled peer data rather than an instruction;
 *   2. reading is not acknowledging — the handoff is still unacknowledged
 *      afterwards;
 *   3. `canvas ack` is what acknowledges it, and only from the session the
 *      handoff was addressed to.
 *
 * Usage: node scripts/handoff-read-smoke.mjs <armadra-runtime> <armadra-hook>
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
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [runtimeBinary, hookBinary] = process.argv.slice(2);
if (!runtimeBinary || !hookBinary) {
  console.error(
    "usage: node scripts/handoff-read-smoke.mjs <armadra-runtime> <armadra-hook>",
  );
  process.exit(2);
}

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
for (const name of ["claude", "codex"]) {
  writeFileSync(
    join(binDir, name),
    `#!/bin/sh\nprintf '{"hook_event_name":"SessionStart"}' | ${JSON.stringify(hookBinary)} ${name} >/dev/null 2>&1\nprintf '{"hook_event_name":"Stop"}' | ${JSON.stringify(hookBinary)} ${name} >/dev/null 2>&1\nwhile IFS= read -r line; do :; done\n`,
    { mode: 0o700 },
  );
}
// The direct PTY backend: the delivery gate reads the fixture Agent's own argv,
// and a tmux pane would report its shell instead.
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
  console.log("handoff-read smoke passed");
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
    // Delivery needs execute, which a new workspace does not grant by default.
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
      nodes: [node(source, "claude"), node(target, "codex")],
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
    { links: [{ id: target, title: "codex", kind: "node" }] },
  );

  const sessions = {};
  for (const [id, agent] of [
    [source, "claude"],
    [target, "codex"],
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

  const prepared = await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs`,
    {
      sourceNodeId: source,
      sourceSessionId: sessions[source].id,
      sourceGeneration: sessions[source].generation,
      targetNodeId: target,
      targetSessionId: sessions[target].id,
      targetGeneration: sessions[target].generation,
      sections: { goal: "把索引重建的收尾工作接过去" },
      byteBudget: 8192,
      includeTranscript: false,
    },
  );
  const accepted = await call(
    base,
    "POST",
    `/api/workspaces/${workspace.id}/handoffs/${prepared.bundle.handoffId}/accept`,
    { expectedDigest: prepared.digest },
  );
  assert.equal(accepted.state, "queued", "accepting did not queue the handoff");
  assert.ok(accepted.mailboxId, "no mailbox message was created");

  // The target Agent reads the bundle with the real client, from inside its own
  // session — the node token, the session binding and the generation all come
  // from the environment that terminal was started with.
  const read = JSON.parse(
    hook(["canvas", "handoff-read", "--id", prepared.bundle.handoffId], {
      node: target,
      agent: "codex",
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
    { node: source, agent: "claude", session: sessions[source] },
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
      agent: "codex",
      session: sessions[target],
    }),
  );
  assert.equal(
    acknowledged.ok,
    true,
    `ack failed: ${JSON.stringify(acknowledged)}`,
  );
  const settled = await awaitState(
    base,
    workspace.id,
    prepared.bundle.handoffId,
    "acknowledged",
  );
  assert.equal(settled.state, "acknowledged");

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
  assert.equal(row.bundle.source.agentId, "claude");
  assert.equal(row.bundle.target.agentId, "codex");
  assert.ok(
    typeof row.attempts === "number",
    "the history did not report delivery attempts",
  );
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
  while (Date.now() < deadline) {
    const sessions = await call(
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
  throw new Error("a fixture Agent never reported a finished turn");
}

async function awaitState(base, workspaceId, handoffId, state) {
  const deadline = Date.now() + 20_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await call(
      base,
      "GET",
      `/api/workspaces/${workspaceId}/handoffs/${handoffId}`,
    );
    if (last.state === state) return last;
    await sleep(200);
  }
  throw new Error(
    `the handoff never reached ${state}; it is ${last?.state} (${last?.errorCode ?? "no reason"})`,
  );
}
