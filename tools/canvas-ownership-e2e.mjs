// End-to-end check for the canvas write-ownership switch (H01 / C02).
//
// Everything it talks to is local and temporary: a self-signed certificate, a
// real Rust Runtime on a kernel-assigned loopback port with its own data
// directory and database, a real Go Host on an ephemeral TLS port with a
// throwaway data directory, the Vite-built web bundle served from a temporary
// HTTPS origin that proxies /rpc to the Host, and a headless Chrome with a
// fresh profile. Nothing reaches the operator's own data directory, keychain or
// the ports the application reserves (1420, 1421, 43120, 43121).
//
// The proxy exists because the browser session transport requires the page and
// the Host to share an origin: cookies scoped to one origin are the point.
//
// The switch is driven twice on purpose: once through the offline CLI, whose
// maintenance window is the data directory lock, and once over HTTPS against a
// serving Host, whose window is a token issued at this machine over the
// same-user control channel. Both walk the same state machine — including the
// reversal, which imports the package back into the Runtime either way — and
// the second pass also proves a token cannot be spent twice.
//
// What this covers: a canvas that really contains the C02 shapes — a frame
// nested in a frame, a terminal and a sticky inside the inner frame, labels, a
// multi-line non-ASCII note, a context link and a whiteboard snapshot — written
// through the Runtime's HTTP API, exported, staged, verified, and then served
// by the Host under a moved epoch; the Runtime refusing writes while the Host
// holds the domain and still answering reads; a real edit through the Host with
// its receipt, its event and its replay; a second client following the Host's
// WebSocket event stream, which must see that edit within 200 ms and, after a
// disconnect, resume from its cursor without losing or repeating one event; and
// the reversal — the format version 2 package, the Runtime applying it to its
// own database, the Runtime's re-read compared against the package, and the
// edit the Host made during its tenure showing up in the Runtime's rows
// afterwards, including the refusal to hand the epoch back to a Runtime that
// cannot apply the package at all.
// Every step is proved by a digest, a revision or a sequence rather than by the
// absence of an exception: a check that only asserts "no error was thrown" would
// still pass against a migration that silently dropped half the canvas.
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { openDriver } from "./canvas-ownership-driver.mjs";
import {
  appOrigin,
  appPort,
  appServer,
  cleanups,
  driverFile,
  failures,
  noteFailure,
  pnpm,
  results,
  root,
  run,
  skipApplication,
  sleep,
  stopHost,
  stopRuntime,
  teardown,
  workspace,
} from "./ownership/canvas/harness.mjs";
import { nodeTransport } from "./ownership/canvas/stream.mjs";
import {
  checkApplicationBoots,
  closeBrowser,
} from "./ownership/canvas/browser.mjs";
import { writeTheCanvas } from "./ownership/canvas/stages/prepare.mjs";
import { switchToHostOffline } from "./ownership/canvas/stages/offline-switch.mjs";
import { reverseImportToRuntime } from "./ownership/canvas/stages/reverse-import.mjs";
import { switchOverHttps } from "./ownership/canvas/stages/https-switch.mjs";

const client = { driver: null };
try {
  console.log("Building the Host binary, the Runtime, the client and the app…");
  mkdirSync(join(root, "target"), { recursive: true });
  run(
    "go",
    [
      "-C",
      "apps/host",
      "build",
      "-o",
      "../../target/armadra-host",
      "./cmd/armadra-host",
    ],
    { stdio: "inherit" },
  );
  run("cargo", ["build", "-p", "armadra-runtime"], {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(root, "target"),
    },
  });
  pnpm(["--filter", "@armadra/shared", "build"]);
  pnpm(["--filter", "@armadra/protocol", "build"]);
  pnpm(["--filter", "@armadra/host-client", "build"]);
  // The browser half is skippable so the switch itself can be checked on a
  // machine with no Chrome; the summary says which half ran rather than
  // implying both did.
  if (!skipApplication) pnpm(["--filter", "@armadra/web", "build"]);

  // The driver the whole check talks through: one @armadra/host-client, driven
  // from Chrome or, with the browser half skipped, from Node over the same TLS
  // proxy.
  const { driverCore, driver: nodeDriver } = await openDriver({
    root,
    workspace,
    appOrigin,
    driverFile,
    skipApplication,
    nodeTransport,
    run,
  });
  client.driver = nodeDriver;

  appServer.listen(appPort, "127.0.0.1");
  await once(appServer, "listening");
  cleanups.push(() => appServer.close());

  const { workspaceId, canvasId, documentPath, reloaded, runtimeDigest } =
    await writeTheCanvas();
  await switchToHostOffline({
    client,
    driverCore,
    workspaceId,
    canvasId,
    documentPath,
    reloaded,
    runtimeDigest,
  });
  await reverseImportToRuntime({
    workspaceId,
    canvasId,
    documentPath,
    reloaded,
    runtimeDigest,
  });
  await switchOverHttps({ client, workspaceId, canvasId, documentPath });
  await checkApplicationBoots();
} catch (error) {
  noteFailure();
  console.error(error);
} finally {
  closeBrowser();
  await stopHost().catch(() => {});
  await stopRuntime().catch(() => {});
  // Give the browser and the two services a moment to release their files
  // before the temporary directory that holds all of them is removed.
  await sleep(500);
  teardown();
}

console.log(
  failures === 0
    ? `Canvas ownership end-to-end passed: ${results.length} checks${skipApplication ? " (browser half skipped)" : ""}.`
    : `Canvas ownership end-to-end failed: ${failures} of ${results.length} checks.`,
);
process.exit(failures === 0 ? 0 : 1);
