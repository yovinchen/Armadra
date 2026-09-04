import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "armadra-host-smoke-"));
const cache = join(root, "target", "protocol-go");
mkdirSync(cache, { recursive: true });
const dataDirectory = join(temporary, "state");
const env = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? join(cache, "build"),
  GOMODCACHE: process.env.GOMODCACHE ?? join(cache, "mod"),
  GOPATH: process.env.GOPATH ?? join(cache, "path"),
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 180_000,
    ...options,
  });
}

function pnpm(args) {
  // Support both the JS distribution and pnpm's standalone executable.
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? "")) {
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  }
  if (process.platform === "win32") {
    return run("pnpm.exe", args);
  }
  return run("pnpm", args);
}

const hosts = new Set();
async function startHost(binary) {
  const child = spawn(
    binary,
    [
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      dataDirectory,
      "--allow-origin",
      "https://canvas.example",
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const host = {
    child,
    closed: new Promise((resolve) => child.once("close", resolve)),
  };
  hosts.add(host);
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });
  host.base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Host startup timed out"));
    }, 15000);
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Host exited at startup (${code}): ${diagnostics}`));
    };
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return host;
}
async function stopHost(host) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill("SIGTERM");
    const timeout = setTimeout(() => host.child.kill("SIGKILL"), 7000);
    try {
      await host.closed;
    } finally {
      clearTimeout(timeout);
    }
  }
  hosts.delete(host);
}
try {
  pnpm(["--filter", "@armadra/protocol", "build"]);
  pnpm(["--filter", "@armadra/host-client", "build"]);
  const cargo = run(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      "armadra-protocol",
      "--example",
      "wire_roundtrip",
      "--message-format=json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const artifacts = cargo
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const wire = artifacts.findLast(
    (entry) =>
      entry.reason === "compiler-artifact" &&
      entry.target?.name === "wire_roundtrip" &&
      entry.executable,
  )?.executable;
  assert.ok(wire, "Rust wire probe executable was not built");
  const binary = join(
    temporary,
    process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
  );
  run("go", [
    "-C",
    join(root, "apps/host"),
    "build",
    "-o",
    binary,
    "./cmd/armadra-host",
  ]);
  let host = await startHost(binary);
  let base = host.base;
  const duplicate = spawnSync(
    binary,
    ["--listen", "127.0.0.1:0", "--data-dir", dataDirectory],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(duplicate.error);
  assert.equal(
    duplicate.status,
    1,
    "A second Host must reject the occupied data directory",
  );
  assert.doesNotMatch(duplicate.stdout, /listening on/);

  const {
    create,
    fromBinary,
    toBinary,
    HelloRequestSchema,
    HelloResponseSchema,
    ErrorResponseSchema,
  } = await import("../packages/protocol-ts/dist/index.js");
  const { HostClient } = await import("../packages/host-client/dist/index.js");
  const clientHello = await new HostClient({
    baseUrl: base,
    clientId: "HostClient 集成",
  }).hello();
  assert.match(clientHello.hostId, /^[a-f0-9]{32}$/);
  assert.deepEqual(clientHello.capabilities, [
    "protocol.hello.v1",
    "host.identity.v1",
  ]);
  const preflight = await fetch(`${base}/rpc/armadra.v1.HostService/Hello`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://canvas.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://canvas.example",
  );
  assert.match(preflight.headers.get("vary"), /Origin/i);
  assert.equal(
    preflight.headers.has("access-control-allow-credentials"),
    false,
  );
  const allowed = await fetch(`${base}/rpc/armadra.v1.HostService/Hello`, {
    method: "POST",
    headers: {
      Origin: "https://canvas.example",
      "Content-Type": "application/x-protobuf",
    },
    body: toBinary(
      HelloRequestSchema,
      create(HelloRequestSchema, {
        clientId: "cors-check",
        protocol: { major: 1, minor: 1 },
      }),
    ),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://canvas.example",
  );
  await allowed.arrayBuffer();
  const denied = await fetch(`${base}/health`, {
    headers: { Origin: "https://other.example" },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has("access-control-allow-origin"), false);
  await denied.arrayBuffer();
  const roundtrip = (kind, bytes) =>
    run(wire, [kind], { input: bytes, stdio: ["pipe", "pipe", "inherit"] });
  const post = (bytes) =>
    fetch(`${base}/rpc/armadra.v1.HostService/Hello`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        Connection: "close",
      },
      body: bytes,
      signal: AbortSignal.timeout(5000),
    });
  let instanceID;
  let hostID;
  for (const clientId of ["桌面客户端 📡", "移动客户端 📱"]) {
    const request = toBinary(
      HelloRequestSchema,
      create(HelloRequestSchema, {
        clientId,
        protocol: { major: 1, minor: 12 },
      }),
    );
    const response = await post(roundtrip("hello-request", request));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(
      response.headers.get("content-type"),
      "application/x-protobuf",
    );
    const reply = fromBinary(
      HelloResponseSchema,
      roundtrip("hello-response", new Uint8Array(await response.arrayBuffer())),
    );
    assert.equal(reply.protocol.major, 1);
    assert.equal(reply.protocol.minor, 1);
    assert.equal(reply.maxFrameBytes, 1_048_576);
    assert.deepEqual(reply.capabilities, [
      "protocol.hello.v1",
      "host.identity.v1",
    ]);
    assert.match(reply.hostId, /^[a-f0-9]{32}$/);
    if (hostID) assert.equal(reply.hostId, hostID);
    hostID = reply.hostId;
    assert.match(reply.hostInstanceId, /^[a-f0-9]{32}$/);
    if (instanceID) assert.equal(reply.hostInstanceId, instanceID);
    instanceID = reply.hostInstanceId;
  }
  // A graceful process restart changes incarnation but retains directory identity.
  await stopHost(host);
  host = await startHost(binary);
  base = host.base;
  const restarted = await post(
    toBinary(
      HelloRequestSchema,
      create(HelloRequestSchema, {
        clientId: "restart-check",
        protocol: { major: 1, minor: 1 },
      }),
    ),
  );
  assert.equal(restarted.status, 200);
  const afterRestart = fromBinary(
    HelloResponseSchema,
    new Uint8Array(await restarted.arrayBuffer()),
  );
  assert.equal(afterRestart.hostId, hostID);
  const clientRestart = await new HostClient({
    baseUrl: base,
    clientId: "HostClient 重启",
  }).hello();
  assert.equal(clientRestart.hostId, clientHello.hostId);
  assert.notEqual(clientRestart.hostInstanceId, clientHello.hostInstanceId);
  assert.notEqual(afterRestart.hostInstanceId, instanceID);
  // Existing minor-0 clients remain compatible with the additive identity field.
  const legacy = await post(
    toBinary(
      HelloRequestSchema,
      create(HelloRequestSchema, {
        clientId: "legacy-check",
        protocol: { major: 1, minor: 0 },
      }),
    ),
  );
  assert.equal(legacy.status, 200);
  assert.equal(
    fromBinary(HelloResponseSchema, new Uint8Array(await legacy.arrayBuffer()))
      .protocol.minor,
    0,
  );
  const incompatible = await post(
    toBinary(
      HelloRequestSchema,
      create(HelloRequestSchema, {
        clientId: "future",
        protocol: { major: 2 },
      }),
    ),
  );
  assert.equal(incompatible.status, 409);
  assert.equal(
    fromBinary(
      ErrorResponseSchema,
      new Uint8Array(await incompatible.arrayBuffer()),
    ).code,
    "UNSUPPORTED",
  );
  const malformed = await post(Uint8Array.of(0x0a, 0xff));
  assert.equal(malformed.status, 400);
  assert.equal(
    fromBinary(
      ErrorResponseSchema,
      new Uint8Array(await malformed.arrayBuffer()),
    ).code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    await (
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
    ).text(),
    "ok\n",
  );
  console.log(
    "PASS: HostClient and TS → Rust → Go Host HTTP → Rust → TS; Unicode, version negotiation, single-instance lock, persistent identity across restart, reconnect, minor-0 compatibility, incompatible/malformed requests.",
  );
} finally {
  for (const host of hosts) await stopHost(host);
  rmSync(temporary, { recursive: true, force: true });
}
