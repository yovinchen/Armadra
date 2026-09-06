// 第 1 步与 Hook 自己的那扇门：一块真有 Agent 节点的画布、节点背后的真终端，
// 以及一次经 `armadra-hook` 用的同一个本机端点发出的上报。后面所有断言都建立在
// 这些真实的行上，而不是直接写进表里的样例。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { step } from "../report.mjs";

export async function prepareAgentRecords(harness) {
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

  return { workspaceId, boardId, nodeId, targetId, hookReport };
}
