import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { request } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "armadra-lifecycle-"));
const binary = join(
  temporary,
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
const env = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? join(root, "target/protocol-go/build"),
  GOMODCACHE: process.env.GOMODCACHE ?? join(root, "target/protocol-go/mod"),
  GOPATH: process.env.GOPATH ?? join(root, "target/protocol-go/path"),
};
const execute = promisify(execFile);
const directories = [
  join(temporary, "sequential"),
  join(temporary, "parallel"),
];
const command = async (args) => {
  const { stdout } = await execute(binary, args, {
    cwd: root,
    env,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout);
};
const start = (dir) =>
  command(["start", "--data-dir", dir, "--listen", "127.0.0.1:0"]);
const status = (dir) => command(["status", "--data-dir", dir]);
const stop = (dir) => command(["stop", "--data-dir", dir]);
let cleanupFailed = false;
try {
  // Native launchers consume the generated binary result, while these CLI
  // lifecycle checks also preserve the default human-readable JSON surface.
  const pnpmCommand = /\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? "")
    ? process.execPath
    : process.platform === "win32"
      ? "pnpm.exe"
      : "pnpm";
  const pnpmArgs =
    pnpmCommand === process.execPath
      ? [process.env.npm_execpath, "--filter", "@armadra/protocol", "build"]
      : ["--filter", "@armadra/protocol", "build"];
  execFileSync(pnpmCommand, pnpmArgs, {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 180_000,
  });
  const { fromBinary, HostManagementResultSchema } = await import(
    "../packages/protocol-ts/dist/index.js"
  );
  const binaryResult = async (args) => {
    const { stdout } = await execute(
      binary,
      [...args, "--output", "protobuf"],
      {
        cwd: root,
        env,
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 1_048_576,
      },
    );
    return fromBinary(HostManagementResultSchema, stdout);
  };
  execFileSync(
    "go",
    [
      "-C",
      join(root, "apps/host"),
      "build",
      "-o",
      binary,
      "./cmd/armadra-host",
    ],
    { cwd: root, env, stdio: "inherit", timeout: 180_000 },
  );
  const dir = directories[0];
  assert.deepEqual(await status(dir), { state: "stopped" });
  assert.equal(existsSync(dir), false, "status must not create data");
  const first = await start(dir);
  assert.equal(first.state, "running");
  assert.match(first.hostId, /^[a-f0-9]{32}$/);
  assert.match(first.hostInstanceId, /^[a-f0-9]{32}$/);
  // The launching CLI has exited; this response must come from its detached child.
  assert.equal(
    await (
      await fetch(`${first.httpEndpoint}/health`, {
        signal: AbortSignal.timeout(3000),
      })
    ).text(),
    "ok\n",
  );
  assert.deepEqual(await status(dir), first);
  const nativeRunning = await binaryResult([
    "start",
    "--data-dir",
    dir,
    "--listen",
    "127.0.0.1:0",
  ]);
  assert.equal(nativeRunning.state.case, "running");
  assert.equal(nativeRunning.state.value.hostId, first.hostId);
  assert.equal(nativeRunning.state.value.hostInstanceId, first.hostInstanceId);
  assert.deepEqual(
    await start(dir),
    first,
    "repeated start must reuse the running instance",
  );
  // Admit an HTTP request but withhold the rest of its body. A completed stop
  // must wait for that request (and ownership) rather than only closing IPC.
  const slow = request(
    `${first.httpEndpoint}/rpc/armadra.v1.HostService/Hello`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Length": "2",
        Expect: "100-continue",
      },
    },
  );
  const responseStatus = new Promise((resolve, reject) => {
    slow.once("error", reject);
    slow.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
  });
  void responseStatus.catch(() => {});
  const admitted = once(slow, "continue");
  const rejectedBeforeContinue = once(slow, "response").then(() => {
    throw new Error("Host did not admit the slow request");
  });
  const admissionTimer = setTimeout(
    () => slow.destroy(new Error("HTTP admission timed out")),
    3000,
  );
  slow.flushHeaders();
  try {
    await Promise.race([admitted, rejectedBeforeContinue]);
  } finally {
    clearTimeout(admissionTimer);
  }
  slow.write(Buffer.from([0x0a]));
  let stopFinished = false;
  const stopping = stop(dir).then((result) => {
    stopFinished = true;
    return result;
  });
  void stopping.catch(() => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(stopFinished, false, "stop must wait for HTTP drain");
    slow.end(Buffer.from([0x00]));
    assert.equal(await responseStatus, 400);
    assert.deepEqual(await stopping, { state: "stopped" });
  } finally {
    slow.destroy();
  }
  assert.deepEqual(await status(dir), { state: "stopped" });
  const nativeStopped = await binaryResult(["status", "--data-dir", dir]);
  assert.equal(nativeStopped.state.case, "stopped");
  await assert.rejects(
    fetch(`${first.httpEndpoint}/health`, {
      signal: AbortSignal.timeout(1000),
    }),
  );
  assert.deepEqual(await stop(dir), { state: "stopped" });
  const second = await start(dir);
  assert.equal(second.hostId, first.hostId);
  assert.notEqual(second.hostInstanceId, first.hostInstanceId);
  assert.equal(
    (await binaryResult(["stop", "--data-dir", dir])).state.case,
    "stopped",
  );

  const [left, right] = await Promise.all([
    start(directories[1]),
    start(directories[1]),
  ]);
  assert.equal(
    left.hostInstanceId,
    right.hostInstanceId,
    "concurrent starts must converge",
  );
  assert.equal(
    (await status(directories[1])).hostInstanceId,
    left.hostInstanceId,
  );
  await stop(directories[1]);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(
    await status(directories[1]),
    { state: "stopped" },
    "a losing startup child must not restart the stopped Host",
  );

  const damaged = join(dir, "identity.json");
  writeFileSync(damaged, "damaged identity", { mode: 0o600 });
  await assert.rejects(start(dir));
  assert.equal(
    readFileSync(damaged, "utf8"),
    "damaged identity",
    "start must not repair a damaged identity",
  );
  assert.deepEqual(await status(dir), { state: "stopped" });
  const invalid = join(temporary, "invalid-listener");
  await assert.rejects(
    command(["start", "--data-dir", invalid, "--listen", "0.0.0.0:0"]),
  );
  assert.equal(existsSync(invalid), false);
  await assert.rejects(
    command(["start", "--data-dir", invalid, "--output", "xml"]),
  );
  assert.equal(existsSync(invalid), false);
  console.log(
    "PASS: detached startup, independent status, repeat/concurrent start, complete stop, restart identity, corrupt-state and invalid-config rejection.",
  );
} finally {
  if (existsSync(binary)) {
    for (const dir of directories) {
      try {
        await stop(dir);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) {
    console.error(
      `Cleanup needs inspection; preserved temporary Host and state at ${temporary}`,
    );
    process.exitCode = 1;
  } else {
    rmSync(temporary, { recursive: true, force: true });
  }
}
