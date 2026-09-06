// The processes a domain-switch end-to-end check runs against.
//
// It is a layer, not a step: nothing here knows what a workspace root or an
// epoch is. It starts a real Rust Runtime and a real Go Host on kernel-assigned
// loopback ports with throwaway data directories, hands back the four ways a
// client reaches them — the Runtime's own HTTP API, the Host's TLS proxy, the
// Host's protobuf surface through @armadra/host-client, and the Host's
// WebSocket event stream — and cleans all of it up.
//
// Nothing touches the operator's data directory, keychain, or the ports the
// application reserves (1420, 1421, 43120, 43121).
//
// The canvas scenario keeps its own copy of this scaffolding in
// `tools/ownership/canvas/harness.mjs`, and so does the settings one in
// `tools/ownership/settings/harness.mjs`. Both serve the page from a separate
// same-origin proxy rather than from the Host's own TLS port, so moving them
// across is a change to what they exercise, not a move.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

/** Ports the application reserves. A check must never bind one of them. */
const RESERVED = [1420, 1421, 43120, 43121];

/** A port nothing is listening on right now, never one the app reserves. */
export async function freePort() {
  const probe = createHttpServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (RESERVED.includes(port)) return freePort();
  return port;
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

/**
 * Opens the harness. The caller gets one object and one `teardown`; every
 * process, socket and directory it created is closed by that call, because an
 * abandoned Host keeps the data directory lock a later run would need.
 */
export async function openHarness({ label }) {
  const workspace = mkdtempSync(join(tmpdir(), `armadra-${label}-`));
  const cleanups = [];
  let cleaned = false;
  const teardown = () => {
    if (!cleaned) {
      cleaned = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {}
      }
    }
    try {
      rmSync(workspace, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch {
      console.error(`  note  temporary directory left behind: ${workspace}`);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      teardown();
      process.exit(130);
    });

  /* ----------------------------------------------------------- certificate */

  const tlsDirectory = join(workspace, "tls");
  mkdirSync(tlsDirectory, { recursive: true });
  const certFile = join(tlsDirectory, "cert.pem");
  const keyFile = join(tlsDirectory, "key.pem");
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const credentials = {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  };

  // The Host serves one public origin. The check never runs a browser, so that
  // origin is the Host's own TLS port: the session cookie, the exact Origin
  // check and the CSRF header are all still real, which is what matters.
  const hostPort = await freePort();
  const appOrigin = `https://localhost:${hostPort}`;

  /* --------------------------------------------------------------- Runtime */

  const runtimeBinary = join(
    root,
    "target",
    "debug",
    process.platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime",
  );
  const runtimeData = join(workspace, "runtime");
  const project = join(workspace, "project");
  const runtimeDatabase = join(runtimeData, "canvas.db");
  mkdirSync(runtimeData, { recursive: true });
  mkdirSync(project, { recursive: true });
  const runtimeEnv = {
    ...process.env,
    ARMADRA_DATA_DIR: runtimeData,
    ARMADRA_DATABASE_URL: `sqlite://${runtimeDatabase}?mode=rwc`,
    RUST_LOG: process.env.RUST_LOG ?? "warn",
  };
  const endpointsFile = join(runtimeData, "endpoints.json");
  let runtime = null;
  let runtimeOrigin = "";
  let runtimeDiagnostics = "";

  function runtimeCall(method, path, body, headers = {}) {
    const url = new URL(path, runtimeOrigin);
    const payload =
      body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          method,
          path: url.pathname + url.search,
          headers: {
            ...(payload ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          timeout: 30_000,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: response.statusCode ?? 0, json, text });
          });
        },
      );
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error("timed out")));
      if (payload) request.write(payload);
      request.end();
    });
  }

  async function startRuntime() {
    rmSync(endpointsFile, { force: true });
    const child = spawn(runtimeBinary, ["--listen", "tcp:127.0.0.1:0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: runtimeEnv,
    });
    runtime = child;
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      runtimeDiagnostics = (runtimeDiagnostics + chunk).slice(-4096);
    });
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (child.exitCode !== null) return false;
      let published = "";
      try {
        published = JSON.parse(readFileSync(endpointsFile, "utf8"))?.runtime
          ?.http;
      } catch {}
      if (published) {
        runtimeOrigin = published;
        const health = await runtimeCall("GET", "/api/health").catch(
          () => null,
        );
        if (health?.status === 200) return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function stopRuntime() {
    const child = runtime;
    runtime = null;
    runtimeOrigin = "";
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(15_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([once(child, "exit"), sleep(2_000)]);
    }
  }
  cleanups.push(() => runtime?.kill("SIGKILL"));

  /* ------------------------------------------------------------------ Host */

  const hostBinary = join(
    root,
    "target",
    process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
  );
  const hostData = join(workspace, "host");
  const hostEnv = { ...process.env, ARMADRA_GITHUB_SECRET_STORE: "file" };
  let host = null;
  let hostDiagnostics = "";

  async function startHost() {
    const child = spawn(
      hostBinary,
      [
        "serve",
        "--listen",
        `127.0.0.1:${hostPort}`,
        "--data-dir",
        hostData,
        "--tls-cert",
        certFile,
        "--tls-key",
        keyFile,
        "--public-origin",
        appOrigin,
        // Naming the Runtime executable and its database is what makes a
        // switch over HTTPS possible at all: without them the Host answers the
        // record and refuses to move it.
        "--runtime-binary",
        runtimeBinary,
        "--runtime-database",
        runtimeDatabase,
        // The proxy dials whatever the Runtime published. Pointing the Host at
        // the Runtime's data directory is how the two find each other without
        // either guessing a port.
        "--endpoints-dir",
        runtimeData,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: hostEnv },
    );
    host = child;
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      hostDiagnostics = (hostDiagnostics + chunk).slice(-4096);
    });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null) return false;
      const reachable = await new Promise((resolve) => {
        const probe = httpsRequest(
          {
            host: "127.0.0.1",
            port: hostPort,
            path: "/health",
            method: "GET",
            ca: credentials.cert,
            servername: "localhost",
            // The Host serves exactly one public origin, so a probe that
            // arrives as 127.0.0.1 is refused before it reaches the handler.
            headers: { Host: `localhost:${hostPort}` },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          },
        );
        probe.on("error", () => resolve(false));
        probe.end();
      });
      if (reachable) return true;
      await sleep(100);
    }
    return false;
  }

  /**
   * Stops the Host completely. The ownership commands take the same data
   * directory lock a serving Host holds, so "stopped" has to mean the process
   * is gone, not merely signalled.
   */
  async function stopHost() {
    const child = host;
    host = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(15_000)]);
    if (child.exitCode === null) {
      try {
        run(hostBinary, ["stop", "--data-dir", hostData], { env: hostEnv });
      } catch {}
      await Promise.race([once(child, "exit"), sleep(5_000)]);
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([once(child, "exit"), sleep(2_000)]);
    }
  }
  cleanups.push(() => host?.kill("SIGKILL"));

  function hostCli(args) {
    return run(hostBinary, [...args, "--data-dir", hostData], { env: hostEnv });
  }

  /* ------------------------------------------- the browser-shaped transport */

  const jar = new Map();

  /**
   * A cookie jar and an HTTPS transport that behave like the browser's own: the
   * Host still sees its public origin, still enforces the exact Origin, and
   * still hands out `__Host-` cookies that only travel back to that origin.
   */
  function transport() {
    return async (url, init = {}) => {
      const target = new URL(url);
      const headers = { ...(init.headers ?? {}), Origin: appOrigin };
      if (jar.size)
        headers.Cookie = [...jar]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
      return new Promise((resolve, reject) => {
        const request = httpsRequest(
          {
            host: target.hostname,
            port: target.port,
            method: init.method ?? "GET",
            path: target.pathname + target.search,
            headers,
            ca: credentials.cert,
            servername: "localhost",
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              for (const raw of response.headers["set-cookie"] ?? []) {
                const pair = raw.split(";", 1)[0];
                const split = pair.indexOf("=");
                jar.set(
                  pair.slice(0, split).trim(),
                  pair.slice(split + 1).trim(),
                );
              }
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode ?? 502,
                  headers: {
                    "content-type":
                      response.headers["content-type"] ??
                      "application/octet-stream",
                  },
                }),
              );
            });
          },
        );
        request.on("error", reject);
        if (init.body) request.write(Buffer.from(init.body));
        request.end();
      });
    };
  }

  /**
   * One `/api/...` request through the Host's proxy, as the paired device.
   *
   * This is the path a phone takes: the Host authenticates the session, checks
   * the device's grants against the route, narrows by whatever else it owns,
   * and only then forwards to the Runtime. `csrf` is required for anything but
   * a read.
   */
  function hostApi(method, path, { body, csrf } = {}) {
    const payload =
      body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port: hostPort,
          method,
          path,
          ca: credentials.cert,
          servername: "localhost",
          headers: {
            Host: `localhost:${hostPort}`,
            Origin: appOrigin,
            "Sec-Fetch-Site": "same-origin",
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": payload.length,
                }
              : {}),
            ...(csrf ? { "X-Armadra-CSRF": csrf } : {}),
            Cookie: [...jar]
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: response.statusCode ?? 0, json, text });
          });
        },
      );
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  /* --------------------------------------------------------- event stream */

  const streamGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

  /** One masked client frame. Server frames are never masked; client ones must be. */
  function writeStreamFrame(socket, opcode, payload) {
    const mask = randomBytes(4);
    const header =
      payload.length < 126
        ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
        : Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
    if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
    const body = Buffer.from(payload);
    for (let index = 0; index < body.length; index += 1)
      body[index] ^= mask[index % 4];
    socket.write(Buffer.concat([header, mask, body]));
  }

  /**
   * The smallest RFC 6455 client that can prove the Host's stream works.
   *
   * A WebSocket handshake carries no CSRF header: what authorizes it is the
   * exact Origin plus the SameSite=Strict session cookie, and both are real
   * here.
   */
  async function openStream(protocol) {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port: hostPort,
      ca: credentials.cert,
      servername: "localhost",
    });
    await once(socket, "secureConnect");
    socket.on("error", () => {});
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1")
      .update(key + streamGUID)
      .digest("base64");
    let buffer = Buffer.alloc(0);
    let handshake = null;
    const frames = [];
    let waiter = null;
    const wake = () => {
      if (!waiter) return;
      const resolve = waiter;
      waiter = null;
      resolve();
    };
    const pump = () => {
      if (handshake === null) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        handshake = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        wake();
      }
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x9) {
          writeStreamFrame(socket, 0xa, payload);
          continue;
        }
        if (opcode === 0x8)
          frames.push({
            close: payload.length >= 2 ? payload.readUInt16BE(0) : 0,
          });
        else if (opcode === 0x2)
          frames.push({
            frame: protocol.fromBinary(
              protocol.EventStreamFrameSchema,
              new Uint8Array(payload),
            ),
          });
        wake();
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.write(
      [
        "GET /ws/armadra.v1.EventStream HTTP/1.1",
        `Host: localhost:${hostPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        `Origin: ${appOrigin}`,
        "Sec-Fetch-Site: same-origin",
        `Cookie: ${[...jar].map(([name, value]) => `${name}=${value}`).join("; ")}`,
        "",
        "",
      ].join("\r\n"),
    );
    // The handshake is proved, never assumed: a proxy answering 200 with a body
    // would otherwise look like a stream that simply never says anything.
    for (let attempt = 0; attempt < 200 && handshake === null; attempt += 1)
      await sleep(25);
    cleanups.push(() => socket.destroy());
    return {
      upgraded:
        handshake !== null &&
        handshake.startsWith("HTTP/1.1 101") &&
        handshake.includes(accept),
      handshake: (handshake ?? "").split("\r\n", 1)[0],
      send(payload) {
        writeStreamFrame(
          socket,
          0x2,
          Buffer.from(
            protocol.toBinary(
              protocol.EventStreamFrameSchema,
              protocol.create(protocol.EventStreamFrameSchema, payload),
            ),
          ),
        );
      },
      /** The next frame, or null when nothing arrived inside the deadline. */
      async next(timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const entry = frames.shift();
          if (entry) return entry;
          if (Date.now() >= deadline) return null;
          await new Promise((resolve) => {
            waiter = resolve;
            setTimeout(() => {
              if (waiter === resolve) {
                waiter = null;
                resolve();
              }
            }, 20);
          });
        }
      },
      close() {
        socket.destroy();
      },
    };
  }

  return {
    workspace,
    project,
    appOrigin,
    hostPort,
    certFile,
    keyFile,
    credentials,
    runtimeBinary,
    runtimeDatabase,
    runtimeData,
    runtimeEnv,
    hostBinary,
    hostData,
    hostEnv,
    jar,
    transport,
    hostApi,
    hostCli,
    openStream,
    startRuntime,
    stopRuntime,
    runtimeCall,
    startHost,
    stopHost,
    teardown,
    diagnostics: () => ({
      runtime: runtimeDiagnostics,
      host: hostDiagnostics,
    }),
  };
}
