// 第 1–2 步：Runtime 自己拥有并写下 C02 那份画布，再原样读回来——摘要相同，画框
// 的嵌套、位置、标签、多行备注、上下文连线和白板快照逐项对上。后面每一次比对都以
// 这里的摘要为准。
import {
  digestOf,
  runtimeShape,
  stable,
} from "../../../canvas-ownership-shapes.mjs";
import {
  runtimeCall,
  runtimeDiagnostics,
  runtimeOrigin,
  runtimeRoot,
  sha256,
  startRuntime,
  step,
} from "../harness.mjs";
import {
  documentFor,
  innerFrame,
  note,
  outerFrame,
  stickyNode,
  terminalNode,
  whiteboard,
} from "../fixtures.mjs";

export async function writeTheCanvas() {
  step(
    "the Runtime started on a kernel-assigned loopback port",
    await startRuntime(),
    `${runtimeOrigin} ${runtimeDiagnostics}`.trim(),
  );

  const before = await runtimeCall("GET", "/api/ownership");
  step(
    "a fresh database starts with the Runtime owning canvas writes",
    before.status === 200 &&
      before.json?.owner === "runtime" &&
      before.json?.epoch === "1",
    `owner=${before.json?.owner} epoch=${before.json?.epoch}`,
  );

  const created = await runtimeCall("POST", "/api/workspaces", {
    name: "所有权端到端",
    rootPath: runtimeRoot,
  });
  step(
    "the Runtime created a workspace",
    created.status === 200 && typeof created.json?.id === "string",
    created.json?.id ?? created.text,
  );
  const workspaceId = created.json.id;

  const board = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "迁移画布" },
  );
  step(
    "the Runtime created a canvas",
    board.status === 200 && typeof board.json?.id === "string",
    board.json?.id ?? board.text,
  );
  const canvasId = board.json.id;
  const documentPath = `/api/workspaces/${workspaceId}/boards/${canvasId}/document`;

  const original = documentFor(canvasId, "迁移前的便签正文\n第二行");
  const saved = await runtimeCall("PUT", documentPath, {
    expectedUpdatedAt: board.json.updatedAt,
    ...original,
    viewport: { x: -40, y: 20, zoom: 1.5 },
    whiteboard,
  });
  const savedDigest = digestOf({
    name: board.json.name,
    whiteboard,
    nodes: original.nodes.map((value) => ({
      id: value.id,
      type: value.type,
      title: value.title,
      color: value.color,
      x: value.position.x,
      y: value.position.y,
      width: value.size?.width ?? null,
      height: value.size?.height ?? null,
      parentId: value.parentId ?? "",
      labels: value.labels,
      note: value.note,
      data: stable(value.data),
    })),
    edges: original.edges,
  });
  step(
    "the Runtime stored the C02 document",
    saved.status === 200 && digestOf(runtimeShape(saved.json)) === savedDigest,
    `sha256=${savedDigest.slice(0, 16)}`,
  );

  /* ---------------------------------------------- 2. it reads back verbatim */

  const reloaded = await runtimeCall("GET", documentPath);
  const runtimeDigest = digestOf(runtimeShape(reloaded.json ?? {}));
  step(
    "the stored document reads back with the same digest",
    reloaded.status === 200 && runtimeDigest === savedDigest,
    `sha256=${runtimeDigest.slice(0, 16)}`,
  );
  const stored = new Map(
    (reloaded.json?.nodes ?? []).map((value) => [value.id, value]),
  );
  step(
    "a frame nests inside a frame and both children name the inner one",
    stored.get(outerFrame)?.parentId === undefined &&
      stored.get(innerFrame)?.parentId === outerFrame &&
      stored.get(terminalNode)?.parentId === innerFrame &&
      stored.get(stickyNode)?.parentId === innerFrame,
    `${stored.get(innerFrame)?.parentId?.slice(0, 8)} ⊂ ${outerFrame.slice(0, 8)}`,
  );
  step(
    "positions, labels and the multi-line note survived the save",
    stored.get(terminalNode)?.position?.x === 120 &&
      stored.get(terminalNode)?.size?.height === 260 &&
      stored.get(terminalNode)?.labels?.join(",") === "运行中,review" &&
      stored.get(terminalNode)?.note === note,
    `note lines=${(stored.get(terminalNode)?.note ?? "").split("\n").length}`,
  );
  step(
    "the context link joins the terminal to the sticky",
    reloaded.json?.edges?.length === 1 &&
      reloaded.json.edges[0].source === terminalNode &&
      reloaded.json.edges[0].target === stickyNode &&
      reloaded.json.edges[0].kind === "link",
    `${terminalNode.slice(0, 8)} → ${stickyNode.slice(0, 8)}`,
  );
  step(
    "the whiteboard snapshot round-tripped byte for byte",
    sha256(reloaded.json?.board?.whiteboard ?? "") === sha256(whiteboard),
    `sha256=${sha256(whiteboard).slice(0, 16)}`,
  );
  return {
    workspaceId,
    canvasId,
    documentPath,
    reloaded,
    runtimeDigest,
  };
}
