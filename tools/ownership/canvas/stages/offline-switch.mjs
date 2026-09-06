// 第 3–6b 步：离线切换。导出、暂存、把纪元移给 Host；Runtime 随即拒写而仍可读；
// Host 接手后真正改了一次画布，并给出回执、事件与重放；第二个客户端经 WebSocket 在
// 200 毫秒内看到那次改动，断线重连后又从游标续上，不丢也不重。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  digestOf,
  hostShape,
  refusal,
  runtimeShape,
} from "../../../canvas-ownership-shapes.mjs";
import {
  appOrigin,
  hostBinary,
  hostData,
  hostDiagnostics,
  hostEnv,
  ownership,
  root,
  run,
  runtimeBinary,
  runtimeCall,
  runtimeDatabase,
  runtimeEnv,
  runtimeOrigin,
  startHost,
  startRuntime,
  step,
  stopRuntime,
  workspace,
} from "../harness.mjs";
import { nodeTransport, openHostStream } from "../stream.mjs";
import { attachBrowser } from "../browser.mjs";
import { documentFor, whiteboard } from "../fixtures.mjs";

export async function switchToHostOffline({
  client,
  driverCore,
  workspaceId,
  canvasId,
  documentPath,
  reloaded,
  runtimeDigest,
}) {
  // The export reads the database file and the ownership command drives a
  // Worker that writes to it. Stopping the Runtime first is the maintenance
  // window the design asks for: no second writer while the epoch moves.
  await stopRuntime();
  const exportDirectory = join(workspace, "export");
  const exported = JSON.parse(
    run(
      runtimeBinary,
      [
        "export",
        "--database",
        runtimeDatabase,
        "--destination",
        exportDirectory,
        "--output",
        "json",
      ],
      { env: runtimeEnv },
    ),
  );
  step(
    "the Runtime wrote a verified export package",
    typeof exported.exportId === "string" &&
      existsSync(join(exportDirectory, "manifest.pb")) &&
      exported.ownershipSwitchAllowed === false,
    `exportId=${exported.exportId?.slice(0, 8)} bytes=${exported.databaseBytes}`,
  );

  const imported = JSON.parse(
    run(
      hostBinary,
      [
        "import",
        "--bundle",
        exportDirectory,
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the Host staged the package without taking ownership",
    typeof imported.importId === "string" &&
      imported.exportId === exported.exportId &&
      imported.state === "staged",
    `importId=${imported.importId?.slice(0, 8)} entities=${imported.entityCount}`,
  );

  const switched = ownership("switch", [
    "--import-id",
    imported.importId,
    "--runtime-binary",
    runtimeBinary,
    "--runtime-database",
    runtimeDatabase,
  ]);
  const switchChecks = switched.report?.checks ?? [];
  step(
    "the switch moved the epoch to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  step(
    "every consistency check matched, with no differences reported",
    switched.report?.matched === true &&
      switchChecks.length > 0 &&
      switchChecks.every((check) => !check.differences?.length),
    `${switchChecks.map((check) => check.check).join(", ")} entities=${switched.report?.entityCount}`,
  );
  const status = ownership("status");
  step(
    "a fresh status read agrees with the switch it just performed",
    status.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      status.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      status.ownership?.epoch === "2" &&
      status.ownership?.importId === imported.importId,
    `reason=${status.ownership?.reasonCode}`,
  );

  /* --------------------------------------------- 4. the Runtime now refuses */

  step(
    "the Runtime restarted after the maintenance window",
    await startRuntime(),
    runtimeOrigin,
  );
  const moved = await runtimeCall("GET", "/api/ownership");
  step(
    "the Runtime reports the domain as the Host's",
    moved.json?.owner === "host" && moved.json?.epoch === "2",
    `owner=${moved.json?.owner} epoch=${moved.json?.epoch} reason=${moved.json?.reasonCode}`,
  );
  const refusedSave = await runtimeCall("PUT", documentPath, {
    expectedUpdatedAt: reloaded.json.board.updatedAt,
    ...documentFor(canvasId, "这次写入必须被拒绝"),
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard,
  });
  step(
    "a canvas write to the Runtime is refused with ownership_moved",
    refusedSave.status === 409 && refusedSave.json?.code === "ownership_moved",
    `HTTP ${refusedSave.status} ${refusedSave.json?.code}`,
  );
  const refusedBoard = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "不应创建" },
  );
  step(
    "creating a canvas is refused the same way, not with a different code",
    refusedBoard.status === 409 &&
      refusedBoard.json?.code === "ownership_moved",
    `HTTP ${refusedBoard.status} ${refusedBoard.json?.code}`,
  );
  const readOnly = await runtimeCall("GET", documentPath);
  step(
    "the read-only fallback still answers the document it no longer owns",
    readOnly.status === 200 &&
      digestOf(runtimeShape(readOnly.json)) === runtimeDigest,
    `sha256=${digestOf(runtimeShape(readOnly.json ?? {})).slice(0, 16)}`,
  );

  /* --------------------------------------------- 5. the Host now writes it */

  step(
    "the Host started on a temporary TLS port",
    await startHost(),
    hostDiagnostics,
  );
  const ticket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "canvas-e2e",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  step("the Host issued a pairing ticket", typeof ticket.ticket === "string");

  const browserDriver = await attachBrowser(driverCore);
  if (browserDriver) client.driver = browserDriver;

  const hello = await client.driver.hello();
  step(
    "Hello advertises the canvas surface through the proxied origin",
    hello.capabilities?.includes("canvas.documents.v1") === true,
    hello.capabilities?.join(", "),
  );
  const session = await client.driver.pair(JSON.stringify(ticket));
  const scopes = (session.scopes ?? []).map((scope) => scope.permission);
  step(
    "pairing produced a session holding the canvas scopes",
    scopes.includes("canvas:read") && scopes.includes("canvas:write"),
    scopes.filter((scope) => scope.startsWith("canvas")).join(", "),
  );
  await client.driver.connect(workspaceId);

  const hostOwnership = await client.driver.call("getOwnership", []);
  step(
    "the authenticated client is told the Host owns the domain",
    hostOwnership.ownership?.owner === 2 &&
      hostOwnership.ownership?.epoch === 2n,
    `owner=${hostOwnership.ownership?.owner} epoch=${hostOwnership.ownership?.epoch}${refusal(hostOwnership)}`,
  );

  const migrated = await client.driver.call("getDocument", [canvasId]);
  const migratedDigest = digestOf(hostShape(migrated));
  step(
    "the migrated document is the same canvas, digest for digest",
    migratedDigest === runtimeDigest,
    `host=${migratedDigest.slice(0, 16)} runtime=${runtimeDigest.slice(0, 16)}${refusal(migrated)}`,
  );
  const beforeEdit = migrated.eventSequence;
  const canvasRevision = migrated.canvas.revision;

  // Only the canvas row changes: everything else is re-sent exactly as it was
  // read, so a save that replayed the whole document would show up as extra
  // events and a larger transaction below.
  const edit = {
    operationId: `canvas/${workspaceId}/${canvasId}/1`,
    canvas: { ...migrated.canvas, name: "迁移后的画布名" },
    expectedRevision: canvasRevision,
    nodes: migrated.nodes,
    edges: migrated.edges,
    annotations: migrated.annotations,
  };
  const applied = await client.driver.call("saveDocument", [edit]);
  // Read the canvas back rather than trusting the save's own answer. The write
  // reaches storage before the client validates the response, so the effect is
  // observable even when the response itself is refused — and a save that
  // reported success while storing nothing would be caught right here.
  const afterEdit = await client.driver.call("getDocument", [canvasId]);
  step(
    "the Host applied the edit and advanced the canvas revision",
    afterEdit.canvas?.revision === canvasRevision + 1n &&
      afterEdit.canvas?.name === "迁移后的画布名",
    `revision ${canvasRevision} → ${afterEdit.canvas?.revision} name=${afterEdit.canvas?.name}${refusal(afterEdit)}`,
  );
  step(
    "the save answered with a receipt for the operation id the client sent",
    applied.receipt?.operationId === edit.operationId &&
      applied.receipt?.replayed !== true &&
      applied.receipt?.transactionId > 0n,
    `sent=${edit.operationId} transaction=${applied.receipt?.transactionId}${refusal(applied)}`,
  );
  step(
    "the receipt names exactly the one object the save changed",
    applied.receipt?.revisions?.length === 1 &&
      applied.receipt.revisions[0].entityId === canvasId,
    `${applied.receipt?.revisions?.length ?? 0} revision(s)`,
  );

  const replay = await client.driver.call("saveDocument", [
    {
      ...edit,
      canvas: afterEdit.canvas,
      expectedRevision: canvasRevision + 1n,
    },
  ]);
  step(
    "replaying the identical save with the same operation id writes nothing",
    replay.receipt?.replayed === true &&
      replay.document?.canvas?.revision === canvasRevision + 1n,
    `replayed=${replay.receipt?.replayed} revision=${replay.document?.canvas?.revision}${refusal(replay)}`,
  );

  /* ------------------------------------------------------- 6. the event feed */

  const feed = await client.driver.call("subscribeEvents", [beforeEdit, 200]);
  const event = feed.events?.[0];
  step(
    "the subscription hands over exactly the object that changed",
    feed.status === "ok" &&
      feed.events?.length === 1 &&
      event.entityId === canvasId &&
      event.kind === 2 &&
      event.sequence > beforeEdit,
    `sequence ${beforeEdit} → ${event?.sequence} entity=${event?.entityId?.slice(0, 8)}${refusal(feed)}`,
  );
  step(
    "the event names its position in a single-object transaction",
    event?.transactionIndex === 0 && event?.transactionSize === 1,
    `index=${event?.transactionIndex} size=${event?.transactionSize}`,
  );

  /* ------------------------------------------- 6b. the pushed event stream */

  // A second client, paired on its own device, following the Host's WebSocket
  // stream instead of asking every few seconds. Everything below is measured
  // against real frames on a real socket: the point of the stream is latency
  // and resumability, and neither can be proved by "no error was thrown".
  const streamProtocol = await import(
    pathToFileURL(join(root, "packages/protocol/dist/index.js")).href
  );
  const streamTicket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "canvas-e2e-stream",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const streamClients = await import(
    pathToFileURL(join(root, "packages/host-client/dist/index.js")).href
  );
  const streamJar = new Map();
  const streamIdentity = new streamClients.HostIdentityClient({
    baseUrl: appOrigin,
    hostId: streamTicket.hostId,
    hostInstanceId: streamTicket.hostInstanceId,
    pageOrigin: appOrigin,
    fetch: nodeTransport(streamJar),
  });
  const streamSession = await streamIdentity.pair(JSON.stringify(streamTicket));
  step(
    "a second device paired and holds a session cookie of its own",
    streamSession?.device?.displayName === "canvas-e2e-stream" &&
      streamJar.size > 0,
    `cookies=${streamJar.size} device=${streamSession?.device?.displayName}`,
  );

  const stream = await openHostStream(streamProtocol, streamJar);
  step(
    "the Host upgraded the event stream for that session's cookie and origin",
    stream.upgraded,
    stream.handshake,
  );
  const cursorBeforeStream = (
    await client.driver.call("getDocument", [canvasId])
  ).eventSequence;
  stream.send({
    payload: {
      case: "subscribe",
      value: {
        afterSequence: cursorBeforeStream,
        workspaceIds: [workspaceId],
      },
    },
  });

  // The catch-up half: the subscription has to reach the watermark before the
  // Host starts pushing, and it says so with `hasMore` rather than leaving the
  // client to guess when it is current.
  let streamCursor = cursorBeforeStream;
  const caughtUp = await stream.pages(5_000);
  for (const entry of caughtUp) streamCursor = entry.page.nextCursor;
  step(
    "the subscription caught up to the Host's watermark before pushing",
    streamCursor >= cursorBeforeStream &&
      caughtUp.every(
        (entry) => entry.page.status === streamProtocol.EventCursorStatus.OK,
      ),
    `cursor ${cursorBeforeStream} → ${streamCursor} in ${caughtUp.length} page(s)`,
  );

  const pushedAt = Date.now();
  const streamedEdit = await client.driver.call("saveDocument", [
    {
      operationId: `canvas/${workspaceId}/${canvasId}/stream-1`,
      canvas: { ...afterEdit.canvas, name: "经事件流看到的改名" },
      expectedRevision: afterEdit.canvas.revision,
      nodes: afterEdit.nodes,
      edges: afterEdit.edges,
      annotations: afterEdit.annotations,
    },
  ]);
  const pushedSequence = streamedEdit.receipt?.lastSequence;
  const pushed = await stream.pages(3_000);
  const pushedEvents = pushed.flatMap((entry) => entry.page.events);
  const arrival = pushed.find((entry) =>
    entry.page.events.some((event) => event.sequence === pushedSequence),
  );
  const latency = arrival ? arrival.at - pushedAt : -1;
  step(
    "a save reaches the second client through the stream in under 200 ms",
    arrival !== undefined && latency >= 0 && latency < 200,
    `sequence=${pushedSequence} latency=${latency}ms`,
  );
  step(
    "the pushed envelope names the canvas that changed, in the canvas domain",
    pushedEvents.length === 1 &&
      pushedEvents[0].entityId === canvasId &&
      pushedEvents[0].kind === "canvas" &&
      pushedEvents[0].domain === streamProtocol.EventDomain.CANVAS &&
      pushedEvents[0].entity?.case === "canvas" &&
      pushedEvents[0].entity.value.name === "经事件流看到的改名",
    `${pushedEvents.length} event(s) kind=${pushedEvents[0]?.kind} name=${pushedEvents[0]?.entity?.value?.name}`,
  );
  for (const entry of pushed) streamCursor = entry.page.nextCursor;

  // The reconnect half. Two saves land while nobody is listening; resuming from
  // the cursor has to deliver exactly those two — losing one would leave a
  // client silently stale, and repeating one would re-apply a change it already
  // has.
  stream.close();
  const offlineSequences = [];
  let offlineBase = streamedEdit.document?.canvas ?? afterEdit.canvas;
  for (const name of ["断线期间的第一次改动", "断线期间的第二次改动"]) {
    const saved = await client.driver.call("saveDocument", [
      {
        operationId: `canvas/${workspaceId}/${canvasId}/offline-${offlineSequences.length}`,
        canvas: { ...offlineBase, name },
        expectedRevision: offlineBase.revision,
        nodes: afterEdit.nodes,
        edges: afterEdit.edges,
        annotations: afterEdit.annotations,
      },
    ]);
    offlineBase = saved.document?.canvas ?? offlineBase;
    offlineSequences.push(saved.receipt?.lastSequence);
  }
  step(
    "two more edits were written while the stream was disconnected",
    offlineSequences.every((sequence) => typeof sequence === "bigint") &&
      offlineSequences[1] > offlineSequences[0],
    offlineSequences.join(", "),
  );

  const resumed = await openHostStream(streamProtocol, streamJar);
  step(
    "the second client reconnected with the cursor it already held",
    resumed.upgraded,
    resumed.handshake,
  );
  resumed.send({
    payload: {
      case: "subscribe",
      value: { afterSequence: streamCursor, workspaceIds: [workspaceId] },
    },
  });
  const replayed = await resumed.pages(5_000);
  const replayedEvents = replayed.flatMap((entry) => entry.page.events);
  const replayedSequences = replayedEvents.map((event) => event.sequence);
  step(
    "resuming delivered every missed event exactly once, in order",
    replayedSequences.length === offlineSequences.length &&
      replayedSequences.every(
        (sequence, index) => sequence === offlineSequences[index],
      ),
    `expected ${offlineSequences.join(",")} got ${replayedSequences.join(",")}`,
  );
  step(
    "resuming replayed nothing the client had already applied",
    replayedSequences.every((sequence) => sequence > streamCursor),
    `cursor=${streamCursor} first=${replayedSequences[0]}`,
  );
  resumed.close();
}
