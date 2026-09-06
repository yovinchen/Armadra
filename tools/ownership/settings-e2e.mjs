// End-to-end check for a business domain's write-ownership switch, one domain
// at a time (Go Host 业务所有权迁移 §5.2, §6.2).
//
// The settings scenario, entered through `pnpm ownership:e2e --domain settings`.
// The canvas domain keeps its own, older and much wider script (`pnpm
// canvas:e2e`), which also drives a real browser; this one is Node-only and
// proves the parts a second domain adds: the dependency order between domains, a document that
// never travelled in a migration bundle, and a rollback whose reverse import
// goes over the Worker's own settings frame instead of a package the Runtime
// reads from disk.
//
// Everything it talks to is local and temporary: a self-signed certificate, a
// real Rust Runtime on a kernel-assigned loopback port with its own data
// directory, a real Go Host on an ephemeral TLS port with a throwaway data
// directory, and an HTTPS origin that proxies /rpc and /ws to the Host so the
// browser session transport sees one origin. Nothing reaches the operator's own
// data directory or the ports the application reserves (1420, 1421, 43120,
// 43121).
//
// What it covers, in order:
//
//   - settings written through the Runtime, digested from the file on disk;
//   - a settings switch attempted before the canvas has settled on the Host,
//     which must be refused by dependency order rather than half-performed;
//   - the offline CLI switch, whose consistency checks compare the Host's
//     projection against the document the Worker exported;
//   - the Runtime refusing settings writes afterwards while still answering
//     reads, which is what makes the switch reversible;
//   - the Host serving the same document, digest for digest, over HTTPS;
//   - a save through the Host, its receipt, its revision, and the event a
//     second client receives on the shared stream within a second;
//   - a stale-revision save refused as a conflict;
//   - the HTTPS rollback: the reverse export, the Runtime applying it over the
//     Worker frame, the Runtime's own re-read compared with the package, and
//     the Host-era change showing up in the Runtime's settings afterwards.
//
// Every step is proved by a digest, a revision or a sequence rather than by the
// absence of an exception.
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { openDriver } from "../canvas-ownership-driver.mjs";
import {
  appOrigin,
  appPort,
  appServer,
  cleanups,
  domain,
  failures,
  hostDiagnostics,
  nodeTransport,
  noteFailure,
  pnpm,
  results,
  root,
  run,
  runtimeDiagnostics,
  stopHost,
  stopRuntime,
  teardown,
  workspace,
} from "./settings/harness.mjs";
import { prepareSettings } from "./settings/stages/prepare.mjs";
import { switchSettingsToHost } from "./settings/stages/switch.mjs";
import { hostServesAndWritesSettings } from "./settings/stages/host-writes.mjs";
import { rollbackSettingsToRuntime } from "./settings/stages/rollback.mjs";

let driver;
try {
  console.log(`Building the Host binary, the Runtime and the client…`);
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

  const { driver: nodeDriver } = await openDriver({
    root,
    workspace,
    appOrigin,
    driverFile: join(workspace, "driver.js"),
    skipApplication: true,
    nodeTransport,
    run,
  });
  driver = nodeDriver;

  appServer.listen(appPort, "127.0.0.1");
  await once(appServer, "listening");
  cleanups.push(() => appServer.close());

  const { workspaceId, runtimeDigest } = await prepareSettings();
  await switchSettingsToHost({ runtimeDigest });
  await hostServesAndWritesSettings({ driver, workspaceId, runtimeDigest });
  await rollbackSettingsToRuntime({ driver });
} catch (error) {
  noteFailure();
  console.error(error);
  if (hostDiagnostics) console.error(`host: ${hostDiagnostics}`);
  if (runtimeDiagnostics) console.error(`runtime: ${runtimeDiagnostics}`);
} finally {
  await stopHost().catch(() => {});
  await stopRuntime().catch(() => {});
  teardown();
}

console.log(
  `\n${results.length - failures}/${results.length} checks passed for --domain ${domain}.`,
);
process.exit(failures === 0 ? 0 : 1);
