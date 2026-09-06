// 第 5–6 步：Host 开始服务并接管写入。同一份文档要逐位对上，一次保存要拿到新的
// 修订号，过期修订要被判成冲突，改动本身要在一秒内经事件流到达第二个客户端——
// 包括新增执行主机自己的那条信封。
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  appOrigin,
  cleanups,
  digestOf,
  hostBinary,
  hostData,
  hostDiagnostics,
  hostEnv,
  nodeTransport,
  openHostStream,
  refusal,
  root,
  run,
  settingsShape,
  startHost,
  step,
} from "../harness.mjs";

export async function hostServesAndWritesSettings({
  driver,
  workspaceId,
  runtimeDigest,
}) {
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
        "settings-e2e",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const hello = await driver.hello();
  step(
    "Hello advertises the settings surface through the proxied origin",
    hello.capabilities?.includes("settings.documents.v1") === true,
    hello.capabilities?.join(", "),
  );
  const session = await driver.pair(JSON.stringify(ticket));
  const scopes = (session.scopes ?? []).map((scope) => scope.permission);
  step(
    "pairing produced a session holding the settings scopes",
    scopes.includes("settings:read") && scopes.includes("settings:write"),
    scopes.filter((scope) => scope.startsWith("settings")).join(", "),
  );
  await driver.connect(workspaceId);

  const hostRead = await driver.settings("get", []);
  step(
    "the Host serves the document the Runtime handed over, digest for digest",
    digestOf(settingsShape(hostRead.value)) === runtimeDigest,
    `host=${digestOf(settingsShape(hostRead.value ?? {})).slice(0, 16)} runtime=${runtimeDigest.slice(0, 16)}${refusal(hostRead)}`,
  );
  step(
    "the Host projected the execution host out of the document it stored",
    (hostRead.executionHosts ?? []).some(
      (entry) => entry.executionHostId === "build_box",
    ),
    (hostRead.executionHosts ?? [])
      .map((entry) => entry.executionHostId || "(local)")
      .join(", "),
  );

  /* -------------------------------- 6. a save through the Host, and its event */

  const protocol = await import(
    pathToFileURL(join(root, "packages/protocol/dist/index.js")).href
  );
  const jar = new Map();
  // The stream needs the same session the client holds. Pairing a second device
  // keeps the two independent, which is what "a second client" means here.
  const streamTicket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "settings-e2e-stream",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const clients = await import(
    pathToFileURL(join(root, "packages/host-client/dist/index.js")).href
  );
  const streamIdentity = new clients.HostIdentityClient({
    baseUrl: appOrigin,
    hostId: hello.hostId,
    hostInstanceId: hello.hostInstanceId,
    pageOrigin: appOrigin,
    fetch: nodeTransport(jar),
  });
  await streamIdentity.pair(JSON.stringify(streamTicket));
  const stream = await openHostStream(protocol, jar);
  step(
    "a second client upgraded to the Host event stream",
    stream.upgraded,
    stream.handshake,
  );
  cleanups.push(() => stream.close());
  stream.send({
    payload: {
      case: "subscribe",
      value: {
        afterSequence: hostRead.eventSequence,
        workspaceIds: [workspaceId],
        domains: [protocol.EventDomain.SETTINGS],
      },
    },
  });

  const nextDocument = {
    ...JSON.parse(JSON.stringify(hostRead.value)),
    theme: "深色",
  };
  nextDocument.ssh.hosts.push({
    id: "second-box",
    name: "第二台",
    host: "second.example.com",
    user: "ada",
  });
  const savedAt = Date.now();
  const saved = await driver.settings("put", [
    {
      document: new TextEncoder().encode(JSON.stringify(nextDocument)),
      expectedRevision: hostRead.revision,
      operationId: `settings/global/${hostRead.revision}`,
    },
  ]);
  step(
    "the Host stored the change and moved the document's revision",
    saved.revision === hostRead.revision + 1n &&
      JSON.parse(new TextDecoder().decode(saved.document)).theme === "深色",
    `revision ${hostRead.revision} → ${saved.revision}${refusal(saved)}`,
  );
  const stale = await driver.settings("put", [
    {
      document: new TextEncoder().encode(JSON.stringify(nextDocument)),
      expectedRevision: hostRead.revision,
      operationId: `settings/global/${hostRead.revision}/again`,
    },
  ]);
  step(
    "a save against the revision that was just superseded is a conflict",
    stale.error?.failure === "conflict",
    `${stale.error?.failure ?? "accepted"} HTTP ${stale.error?.httpStatus ?? 200}`,
  );

  const streamed = await stream.envelopes(protocol.EventDomain.SETTINGS, 3_000);
  const documentEvent = streamed.find(
    (entry) => entry.envelope.kind === "document",
  );
  step(
    "the second client received the settings change on the stream within a second",
    documentEvent !== undefined && documentEvent.at - savedAt < 1_000,
    documentEvent
      ? `${documentEvent.at - savedAt} ms, revision ${documentEvent.envelope.revision}`
      : `nothing arrived (${streamed.length} envelopes)`,
  );
  step(
    "the added execution host arrived as its own envelope, not only as a changed document",
    streamed.some(
      (entry) =>
        entry.envelope.kind === "executionHost" &&
        entry.envelope.entityId === "second-box",
    ),
    streamed
      .map((entry) => `${entry.envelope.kind}:${entry.envelope.entityId}`)
      .join(" "),
  );
  step(
    "the settings envelope names no workspace, because the document is host-wide",
    documentEvent?.envelope.workspaceId === "",
    `workspaceId=${JSON.stringify(documentEvent?.envelope.workspaceId ?? null)}`,
  );
}
