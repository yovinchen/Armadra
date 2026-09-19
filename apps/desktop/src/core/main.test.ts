import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HelpRequested, type RunningCore, run, runtimeEndpoint } from "./main";
import { read } from "./endpoints";
import { parseAnnouncement } from "./instance";
import { endpointsFile } from "./paths";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "db/migrations");

const running: RunningCore[] = [];
afterEach(async () => {
  for (const core of running.splice(0)) await core.stop();
});

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-core-"));
}

async function start(dataDir: string, listen = "tcp:127.0.0.1:0") {
  const lines: string[] = [];
  const core = await run({
    argv: ["--listen", listen, "--data-dir", dataDir],
    env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
    stdout: (line) => lines.push(line),
  });
  running.push(core);
  return { core, lines };
}

/** One hand-written upgrade request; returns the status line. */
function upgrade(
  core: RunningCore,
  path: string,
  origin?: string,
): Promise<string> {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return new Promise((done) => {
    const socket = connect(tcp.port, tcp.host, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${tcp.host}\r\nConnection: Upgrade\r\n` +
          `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          (origin === undefined ? "" : `Origin: ${origin}\r\n`) +
          `\r\n`,
      );
    });
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes("\r\n")) {
        socket.destroy();
        done(received.slice(0, received.indexOf("\r\n")));
      }
    });
    socket.on("error", () => done("error"));
  });
}

function base(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `http://${tcp.host}:${tcp.port}`;
}

describe("the core process", () => {
  it("announces its instance on stdout before it binds anything", async () => {
    const { core, lines } = await start(temporary());
    expect(lines[0]).toBeDefined();
    expect(parseAnnouncement(lines[0] as string)).toBe(core.instanceId);
  });

  it("publishes an endpoint record naming every transport it bound", async () => {
    const dataDir = temporary();
    const { core } = await start(dataDir);
    const document = read(endpointsFile(dataDir));
    expect(document.version).toBe(1);
    expect(document.runtime?.instanceId).toBe(core.instanceId);
    expect(document.runtime?.processId).toBe(process.pid);
    expect(document.runtime?.http).toBe(base(core));
    expect(document.runtime?.websocket).toBe(base(core).replace("http", "ws"));
  });

  it("withdraws the record and removes its socket when it stops", async () => {
    const dataDir = temporary();
    const socket = join(dataDir, "core.sock");
    const { core } = await start(dataDir, `unix:${socket}`);
    expect(existsSync(socket)).toBe(true);
    await core.stop();
    running.length = 0;
    expect(read(endpointsFile(dataDir)).runtime).toBeUndefined();
    expect(existsSync(socket)).toBe(false);
    // The file itself stays: it is a shared document, not ours to delete.
    expect(existsSync(endpointsFile(dataDir))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the data directory and the endpoint file private",
    async () => {
      const dataDir = temporary();
      await start(dataDir);
      expect(statSync(endpointsFile(dataDir)).mode & 0o777).toBe(0o600);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    },
  );

  it("listens on several transports at once", async () => {
    const dataDir = temporary();
    const socket = join(dataDir, "core.sock");
    const core = await run({
      argv: [
        "--listen",
        `unix:${socket}`,
        "--listen",
        "tcp:127.0.0.1:0",
        "--data-dir",
        dataDir,
      ],
      env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
      stdout: () => {},
    });
    running.push(core);
    expect(core.bound.map((spec) => spec.kind).sort()).toEqual(["tcp", "unix"]);
    const document = read(endpointsFile(dataDir));
    expect(document.runtime?.socket).toBe(socket);
    expect(document.runtime?.http).toBeDefined();
  });

  it("creates the database in the data directory it was given", async () => {
    const dataDir = temporary();
    await start(dataDir);
    expect(existsSync(join(dataDir, "canvas.db"))).toBe(true);
  });

  it("says hello on the bus once it is serving", async () => {
    const dataDir = temporary();
    const core = await run({
      argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
      env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
      stdout: () => {},
    });
    running.push(core);
    // The event has already fired by the time `run` resolves, so a late
    // subscriber proves only that the bus is wired; that is what R1 needs.
    let seen: unknown;
    core.bus.on("runtime.hello", (payload) => (seen = payload));
    core.bus.emit("runtime.hello", {
      instanceId: core.instanceId,
      version: "0.1.0",
    });
    expect(seen).toEqual({ instanceId: core.instanceId, version: "0.1.0" });
  });

  it("prints usage for --help and starts nothing", async () => {
    const lines: string[] = [];
    await expect(
      run({ argv: ["--help"], env: {}, stdout: (line) => lines.push(line) }),
    ).rejects.toBeInstanceOf(HelpRequested);
    expect(lines.join("")).toContain("--listen");
  });

  it("refuses to start on an argument it does not understand", async () => {
    await expect(
      run({ argv: ["--serve-everything"], env: {}, stdout: () => {} }),
    ).rejects.toThrow(/unsupported core argument/);
  });

  it("publishes nothing when it cannot bind", async () => {
    const dataDir = temporary();
    const { core } = await start(dataDir);
    const held = base(core).split(":")[2] as string;
    const second = temporary();
    await expect(
      run({
        argv: ["--listen", `tcp:127.0.0.1:${held}`, "--data-dir", second],
        env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
        stdout: () => {},
      }),
    ).rejects.toThrow(/already in use/);
    expect(existsSync(endpointsFile(second))).toBe(false);
  });
});

describe("what the core answers", () => {
  it("reports the same health document on both paths", async () => {
    const { core } = await start(temporary());
    const first = await (await fetch(`${base(core)}/health`)).json();
    const second = await (await fetch(`${base(core)}/api/health`)).json();
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: "ok",
      version: "0.1.0",
      instanceId: core.instanceId,
      build: expect.any(String) as string,
      // R3 brought the hook service up with the core: the endpoint file names
      // this data directory's socket, which is what `ok` reports on.
      hook: { ok: true, sock: join(core.dataDir, "hook.sock") },
    });
  });

  it("answers a route it has not written with 501 and the feature's name", async () => {
    const { core } = await start(temporary());
    // The power lease surface is a table entry no phase has written yet, so it
    // is the one place a 501 can still be observed.
    const response = await fetch(`${base(core)}/api/power`);
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      code: "not_implemented",
      message: "电源租约（R5）",
    });
  });

  it("answers a path nobody claimed with 404, not 501", async () => {
    const { core } = await start(temporary());
    const response = await fetch(`${base(core)}/api/invented`);
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("not_found");
  });

  it("answers JSON with a content type and no trailing newline", async () => {
    // Byte parity with the Rust Runtime: its axum responses end at the
    // closing brace, and a Content-Length assertion on either side must agree.
    const { core } = await start(temporary());
    const response = await fetch(`${base(core)}/health`);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toMatch(/\}$/);
  });

  it("answers a loopback origin and refuses any other", async () => {
    const { core } = await start(temporary());
    const allowed = await fetch(`${base(core)}/health`, {
      headers: { origin: "http://127.0.0.1:1420" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:1420",
    );
    const refused = await fetch(`${base(core)}/health`, {
      headers: { origin: "http://example.com" },
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("forbidden");
  });

  it("answers a preflight with the allowed verbs and no body", async () => {
    const { core } = await start(temporary());
    const response = await fetch(`${base(core)}/api/workspaces`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:1420" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PATCH",
    );
  });

  it("refuses a WebSocket upgrade that names no origin", async () => {
    // `fetch` will not send an upgrade, so this is spoken by hand.
    const { core } = await start(temporary());
    expect(await upgrade(core, "/api/workspaces/ws-1/events")).toMatch(
      /^HTTP\/1\.1 403/,
    );
  });

  it("refuses an upgrade the core has no stream for", async () => {
    const { core } = await start(temporary());
    // Both streams in the table — the workspace event one and the language
    // session one — are written now, so the case this covers is an upgrade to
    // a path the table does not carry at all: refused outright, rather than a
    // socket left hanging open.
    expect(
      await upgrade(
        core,
        "/api/workspaces/ws-1/not-a-stream",
        "http://127.0.0.1:1420",
      ),
    ).toMatch(/^HTTP\/1\.1 501/);
  });

  /**
   * A stream that exists refuses on its own terms instead. The workspace
   * event route checks the workspace before the upgrade, exactly as the Rust
   * route does, so an unknown one is an HTTP 404 rather than a socket that
   * opens and immediately closes.
   */
  it("lets a stream that exists answer its own refusal", async () => {
    const { core } = await start(temporary());
    expect(
      await upgrade(
        core,
        "/api/workspaces/ws-1/events",
        "http://127.0.0.1:1420",
      ),
    ).toMatch(/^HTTP\/1\.1 404/);
  });

  it("stops accepting once it has stopped", async () => {
    const { core } = await start(temporary());
    const address = base(core);
    await core.stop();
    running.length = 0;
    await expect(fetch(`${address}/health`)).rejects.toThrow();
  });
});

describe("the published record", () => {
  it("names every transport, and nothing a browser cannot reach when there is none", () => {
    const endpoint = runtimeEndpoint(
      "instance-1",
      [
        { kind: "tcp", host: "127.0.0.1", port: 53211 },
        { kind: "unix", path: "/tmp/armadra/runtime.sock" },
        { kind: "pipe", name: "armadra-core" },
      ],
      () => new Date(0),
      4321,
    );
    expect(endpoint).toEqual({
      instanceId: "instance-1",
      writtenAt: "1970-01-01T00:00:00.000Z",
      processId: 4321,
      http: "http://127.0.0.1:53211",
      websocket: "ws://127.0.0.1:53211",
      socket: "/tmp/armadra/runtime.sock",
      pipe: "\\\\.\\pipe\\armadra-core",
    });

    const private_ = runtimeEndpoint("instance-2", [
      { kind: "unix", path: "/tmp/armadra/runtime.sock" },
    ]);
    expect(private_.http).toBeUndefined();
    expect(private_.websocket).toBeUndefined();
  });
});

describe("the built bundle", () => {
  const bundle = resolve(here, "../../out/core/main.js");

  it.skipIf(!existsSync(bundle))(
    "is plain CommonJS that requires no Electron",
    () => {
      const source = readFileSync(bundle, "utf8");
      expect(source).not.toMatch(/require\(["']electron["']\)/);
      expect(source).toContain("armadra-runtime instance ");
    },
  );
});
