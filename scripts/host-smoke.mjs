import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "armadra-host-smoke-"));
const cache = join(root, "target", "protocol-go");
mkdirSync(cache, { recursive: true });
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

let host;
let closed;
try {
  pnpm(["--filter", "@armadra/protocol", "build"]);
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
  host = spawn(binary, ["--listen", "127.0.0.1:0"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise((resolve) => host.once("close", resolve));
  let diagnostics = "";
  host.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Host startup timed out"));
    }, 15_000);
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
      host.stdout.off("data", onData);
      host.off("error", onError);
      host.off("exit", onExit);
    }
    host.stdout.on("data", onData);
    host.once("error", onError);
    host.once("exit", onExit);
  });

  const {
    create,
    fromBinary,
    toBinary,
    HelloRequestSchema,
    HelloResponseSchema,
    ErrorResponseSchema,
  } = await import("../packages/protocol-ts/dist/index.js");
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
    assert.equal(reply.protocol.minor, 0);
    assert.equal(reply.maxFrameBytes, 1_048_576);
    assert.deepEqual(reply.capabilities, ["protocol.hello.v1"]);
    assert.match(reply.hostInstanceId, /^[a-f0-9]{32}$/);
    if (instanceID) assert.equal(reply.hostInstanceId, instanceID);
    instanceID = reply.hostInstanceId;
  }
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
    "PASS: TS → Rust → Go Host HTTP → Rust → TS; Unicode, version negotiation, reconnect identity, incompatible/malformed requests.",
  );
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill("SIGTERM");
    const timeout = setTimeout(() => host.kill("SIGKILL"), 7000);
    try {
      await closed;
    } finally {
      clearTimeout(timeout);
    }
  }
  rmSync(temporary, { recursive: true, force: true });
}
