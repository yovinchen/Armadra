import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "armadra-native-host-"));
const dataDir = join(temporary, "state");
const execute = promisify(execFile);
const binary = join(
  root,
  "target/debug",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
const env = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? join(root, "target/protocol-go/build"),
  GOMODCACHE: process.env.GOMODCACHE ?? join(root, "target/protocol-go/mod"),
  GOPATH: process.env.GOPATH ?? join(root, "target/protocol-go/path"),
};
const run = (command, args, extra = {}) =>
  execFileSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 300_000,
    ...extra,
  });
function pnpm(args) {
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? ""))
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args);
}
let built = false;
let cleanupFailed = false;
try {
  // Keep this probe's Go executable in the conventional ignored target path.
  // Cargo reports its example path explicitly, including custom target dirs.
  run(process.execPath, ["apps/desktop/scripts/prepare-host.mjs", "--native"], {
    env: { ...env, CARGO_TARGET_DIR: join(root, "target") },
  });
  built = true;
  pnpm(["--filter", "@armadra/protocol", "build"]);
  const nativeEnv = { ...env };
  delete nativeEnv.CARGO_BUILD_TARGET;
  delete nativeEnv.TAURI_ENV_TARGET_TRIPLE;
  const cargo = run(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      "armadra-desktop",
      "--no-default-features",
      "--example",
      "host-bootstrap-probe",
      "--message-format=json",
    ],
    { env: nativeEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const entries = cargo
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const probe = entries.findLast(
    (entry) =>
      entry.reason === "compiler-artifact" &&
      entry.target?.name === "host-bootstrap-probe" &&
      entry.executable,
  )?.executable;
  assert.ok(probe, "Native bootstrap probe was not built");
  const reservation = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${reservation.address().port}`;
  await new Promise((resolve) => reservation.close(resolve));
  const { fromBinary, HostStatusSchema, HostManagementResultSchema } =
    await import("../packages/protocol-ts/dist/index.js");
  const launch = async (origin) => {
    const { stdout } = await execute(
      probe,
      [binary, dataDir, endpoint, origin],
      {
        cwd: root,
        env,
        encoding: "buffer",
        timeout: 25_000,
        maxBuffer: 1_048_576,
      },
    );
    return fromBinary(HostStatusSchema, stdout);
  };
  const first = await launch("http://127.0.0.1:1445");
  assert.equal(first.httpEndpoint, endpoint);
  assert.match(first.hostId, /^[a-f0-9]{32}$/);
  // The Rust launcher has exited. The independent Go Host must still answer.
  assert.equal(
    await (
      await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) })
    ).text(),
    "ok\n",
  );
  const second = await launch("http://127.0.0.1:1445");
  assert.equal(second.hostInstanceId, first.hostInstanceId);
  // An already-running Host is not reconfigured for an undeclared page origin.
  await assert.rejects(launch("http://127.0.0.1:1446"));
  const { stdout } = await execute(
    binary,
    ["status", "--data-dir", dataDir, "--output", "protobuf"],
    { env, encoding: "buffer", timeout: 10_000 },
  );
  const current = fromBinary(HostManagementResultSchema, stdout);
  assert.equal(current.state.case, "running");
  assert.equal(current.state.value.hostInstanceId, first.hostInstanceId);
  console.log(
    "PASS: native Rust bootstrap, binary CLI, exact Origin handshake, discovery, launcher-exit survival, incompatible Origin leaves existing Host intact.",
  );
} finally {
  if (built) {
    try {
      await execute(binary, ["stop", "--data-dir", dataDir], {
        env,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    console.error(`Cleanup requires inspection: ${temporary}`);
    process.exitCode = 1;
  } else rmSync(temporary, { recursive: true, force: true });
}
