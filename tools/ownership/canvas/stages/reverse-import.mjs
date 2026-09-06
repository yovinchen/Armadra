// 第 7–8 步：回滚。已经有包的目录不许被覆盖；真正的回滚不接受「只导出」，包要回到
// Runtime 自己的库里，纪元只在双方摘要一致时才移动；随后 Host 任期内写下的内容出现在
// Runtime 的行里，Runtime 也重新可写。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf, runtimeShape } from "../../../canvas-ownership-shapes.mjs";
import {
  hostBinary,
  hostData,
  hostEnv,
  ownership,
  runtimeBinary,
  runtimeCall,
  runtimeDatabase,
  runtimeOrigin,
  sha256,
  startRuntime,
  step,
  stopHost,
  stopRuntime,
  tryRun,
  workspace,
} from "../harness.mjs";
import { documentFor, whiteboard } from "../fixtures.mjs";

export async function reverseImportToRuntime({
  workspaceId,
  canvasId,
  documentPath,
  reloaded,
  runtimeDigest,
}) {
  await stopHost();
  await stopRuntime();
  // A rollback writes its package once. A directory that already holds one is
  // refused rather than overwritten: the previous attempt may be the only copy
  // of what the Host held.
  const refusedExport = join(workspace, "reverse-export-refused");
  mkdirSync(refusedExport, { recursive: true });
  writeFileSync(join(refusedExport, "occupied"), "not empty\n");
  const refusedRollback = tryRun(
    hostBinary,
    [
      "ownership",
      "rollback",
      "--data-dir",
      hostData,
      "--output",
      "json",
      "--export",
      refusedExport,
      "--runtime-binary",
      runtimeBinary,
      "--runtime-database",
      runtimeDatabase,
    ],
    { env: hostEnv },
  );
  step(
    "a rollback refuses to write over a package that is already there",
    refusedRollback.status !== 0 &&
      readdirSync(refusedExport).join() === "occupied",
    refusedRollback.stderr.trim().split("\n").at(-1),
  );
  const stillHost = ownership("status");
  step(
    "the refused rollback left the epoch where it was",
    stillHost.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      stillHost.ownership?.epoch === "2",
    `owner=${stillHost.ownership?.owner} epoch=${stillHost.ownership?.epoch}`,
  );

  // No --accept-export-only. The Host's edit has to travel back into the
  // Runtime's own database, and the epoch only moves once the Runtime has read
  // its rows back and the Host has compared the digests.
  const reverseExport = join(workspace, "reverse-export");
  const rolledBack = ownership("rollback", [
    "--export",
    reverseExport,
    "--runtime-binary",
    runtimeBinary,
    "--runtime-database",
    runtimeDatabase,
  ]);
  step(
    "the rollback handed the epoch back without accepting an export-only reversal",
    rolledBack.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      rolledBack.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      rolledBack.ownership?.epoch === "3",
    `owner=${rolledBack.ownership?.owner} epoch=${rolledBack.ownership?.epoch}`,
  );
  const reverseChecks = Object.fromEntries(
    (rolledBack.report?.checks ?? []).map((check) => [
      check.check,
      check.matched === true,
    ]),
  );
  step(
    "the epoch moved on the Runtime's own re-read, not on the Host's word",
    reverseChecks["reverse.import"] === true &&
      reverseChecks["reverse.workspaces"] === true &&
      reverseChecks["reverse.unsupported_entity"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  const index = JSON.parse(
    readFileSync(join(reverseExport, "export.json"), "utf8"),
  );
  const entries = readdirSync(reverseExport).sort();
  step(
    "the reverse export is a format version 2 package for the canvas domain",
    // One file per workspace: the e2e's own plus the Default one a fresh
    // Runtime creates on first start.
    entries.length === (index.files?.length ?? 0) + 1 &&
      entries.includes("export.json") &&
      index.formatVersion === 2 &&
      index.domain === "canvas" &&
      index.epoch === 2 &&
      index.entityCount > 0 &&
      (index.files?.length ?? 0) >= 1 &&
      (index.files ?? []).reduce((sum, file) => sum + file.entityCount, 0) ===
        index.entityCount,
    `${entries.join(", ")} epoch=${index.epoch} entities=${index.entityCount}`,
  );
  const mismatched = (index.files ?? []).filter((file) => {
    const payload = readFileSync(join(reverseExport, file.name));
    return payload.length !== file.bytes || sha256(payload) !== file.sha256;
  });
  step(
    "every digest in export.json describes the bytes actually on disk",
    (index.files ?? []).length > 0 && mismatched.length === 0,
    `${index.files?.[0]?.bytes} bytes sha256=${index.files?.[0]?.sha256?.slice(0, 16)}`,
  );
  // The canonical digest describes the records with the Host's own revisions
  // and asset references removed, which is why it cannot be the on-disk one.
  step(
    "each file also carries the canonical digest the Runtime is compared against",
    (index.files ?? []).length > 0 &&
      index.files.every(
        (file) =>
          /^[0-9a-f]{64}$/.test(file.contentSha256) &&
          file.contentSha256 !== file.sha256 &&
          file.entityCount > 0,
      ),
    `contentSha256=${index.files?.[0]?.contentSha256?.slice(0, 16)}`,
  );

  /* ------------------------------------------- 8. writes are the Runtime's */

  step(
    "the Runtime restarted after the reversal",
    await startRuntime(),
    runtimeOrigin,
  );
  const returned = await runtimeCall("GET", "/api/ownership");
  step(
    "the Runtime reports itself as the owner at the new epoch",
    returned.json?.owner === "runtime" && returned.json?.epoch === "3",
    `owner=${returned.json?.owner} epoch=${returned.json?.epoch} reason=${returned.json?.reasonCode}`,
  );
  // The point of the reverse import: what the Host wrote while it owned the
  // canvas is in the Runtime's own rows, not only in the package. The last Host
  // write is the second offline rename from the stream section above. The whole
  // document is compared, not just the renamed field, so a rollback that
  // brought the name back while dropping a node would fail here.
  const current = await runtimeCall("GET", documentPath);
  const restoredDigest = digestOf(runtimeShape(current.json ?? {}));
  step(
    "the Runtime reads back the edit the Host made while it owned the canvas",
    current.status === 200 &&
      current.json?.board?.name === "断线期间的第二次改动" &&
      restoredDigest ===
        digestOf({
          ...runtimeShape(reloaded.json ?? {}),
          name: "断线期间的第二次改动",
        }) &&
      restoredDigest !== runtimeDigest,
    `name=${current.json?.board?.name} sha256=${restoredDigest.slice(0, 16)} (pre-switch ${runtimeDigest.slice(0, 16)})`,
  );
  const rewritten = documentFor(canvasId, "回滚之后重新写入的正文");
  const rewrittenBoard = await runtimeCall("PUT", documentPath, {
    expectedUpdatedAt: current.json.board.updatedAt,
    ...rewritten,
    viewport: { x: 10, y: 10, zoom: 1 },
    whiteboard,
  });
  step(
    "a canvas write to the Runtime succeeds again",
    rewrittenBoard.status === 200,
    `HTTP ${rewrittenBoard.status}`,
  );
  const finalRead = await runtimeCall("GET", documentPath);
  const finalDigest = digestOf(runtimeShape(finalRead.json ?? {}));
  step(
    "the new content reads back, and is not the pre-switch document",
    finalRead.status === 200 &&
      finalDigest === digestOf(runtimeShape(rewrittenBoard.json)) &&
      finalDigest !== runtimeDigest,
    `sha256=${finalDigest.slice(0, 16)} (was ${runtimeDigest.slice(0, 16)})`,
  );
  const settled = ownership("status");
  step(
    "the Host's own record agrees that the Runtime writes again",
    settled.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      settled.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      settled.ownership?.epoch === "3",
    `owner=${settled.ownership?.owner} epoch=${settled.ownership?.epoch} reason=${settled.ownership?.reasonCode}`,
  );
}
