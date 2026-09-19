/**
 * End-to-end tests that run the real bundle against a throwaway TCP server and
 * byte-compare what lands on the wire — the translation of
 * `crates/hook/tests/wire.rs`, case for case.
 *
 * The bundle is built here rather than assumed, so the suite is honest about
 * what ships: an import of the TypeScript sources would not catch a bundler
 * setting that breaks the one file the CLIs actually fork.
 *
 * When `target/debug/armadra-hook` is present the same invocations are run
 * through the Rust client too and the two outputs are compared byte for byte.
 * Without it those cases are skipped, because a checkout with no Rust
 * toolchain must still be able to run the suite.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

const here = import.meta.dirname;
const desktop = path.resolve(here, "../../..");
const repository = path.resolve(desktop, "../..");
// The Rust client's location follows `CARGO_TARGET_DIR` like every cargo
// invocation in this repository does; a stale binary in the default target
// directory would otherwise be compared against the current wire format.
const rustClient = path.join(
  process.env.CARGO_TARGET_DIR ?? path.join(repository, "target"),
  "debug/armadra-hook",
);
const hasRustClient = fs.existsSync(rustClient);

let bundle = "";
const temporaries: string[] = [];

function tempdir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "armadra-wire-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaries.length > 0) {
    fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
  }
});

/** The bundle outlives every case, so it is not in the per-case cleanup list. */
let buildDir = "";

afterAll(() => {
  if (buildDir !== "") fs.rmSync(buildDir, { recursive: true, force: true });
});

beforeAll(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "armadra-cli-build-"));
  buildDir = outDir;
  await build({
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: true,
      target: "node22",
      ssr: true,
      minify: false,
      rollupOptions: {
        input: { "armadra-hook": path.join(here, "main.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
          codeSplitting: false,
        },
      },
    },
    ssr: { noExternal: true },
  });
  bundle = path.join(outDir, "armadra-hook.js");
  expect(fs.existsSync(bundle)).toBe(true);
}, 120_000);

/* --------------------------------- server --------------------------------- */

interface Captured {
  head: string;
  body: string;
}

function requestLine(captured: Captured): string {
  return captured.head.split("\r\n")[0] ?? "";
}

function header(captured: Captured, name: string): string | undefined {
  for (const line of captured.head.split("\r\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() === name.toLowerCase()) {
      return line.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** Header names in the order they arrived. */
function headerNames(captured: Captured): string[] {
  return captured.head
    .split("\r\n")
    .slice(1)
    .filter((line) => line.includes(":"))
    .map((line) => line.slice(0, line.indexOf(":")).trim());
}

interface Server {
  port: number;
  /** Resolves with the nth captured request (0-based). */
  request(index?: number): Promise<Captured>;
  close(): void;
}

/**
 * Binds an ephemeral port and answers every request with `response`, keeping
 * each one so the test can assert on the exact bytes.
 */
async function serve(response: string): Promise<Server> {
  const captured: Captured[] = [];
  const waiters: ((value: Captured) => void)[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("error", () => {
      // The client closes as soon as the framing is complete.
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const headEnd = raw.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = raw.subarray(0, headEnd + 4).toString("utf8");
      const lengthLine = head
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));
      const length =
        lengthLine === undefined ? 0 : Number(lengthLine.split(":")[1]!.trim());
      const body = raw.subarray(headEnd + 4);
      if (body.length < length) return;
      const entry = { head, body: body.subarray(0, length).toString("utf8") };
      captured.push(entry);
      waiters.shift()?.(entry);
      socket.write(response);
      socket.end();
      chunks.length = 0;
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    request(index = 0) {
      const existing = captured[index];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<Captured>((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error("no request arrived")), 5000).unref();
      });
    },
    close() {
      server.close();
    },
  };
}

/** A port that is almost certainly free, so connecting to it is refused. */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/* --------------------------------- client --------------------------------- */

function writeEndpointFile(directory: string, port: number): string {
  const file = path.join(directory, "hook-endpoint.env");
  const tokens = path.join(directory, "node-tokens");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    file,
    `ARMADRA_HOOK_PORT='${port}'\nARMADRA_HOOK_TOKEN='app-token-abc'\n` +
      `ARMADRA_NODE_TOKEN_DIR='${tokens}'\nARMADRA_HOOK_VERSION='1'\n`,
  );
  fs.mkdirSync(tokens, { recursive: true });
  fs.writeFileSync(path.join(tokens, "node-7"), "kid1234.macvalue\n");
  return file;
}

const CLEARED = [
  "ARMADRA_NODE_ID",
  "ARMADRA_AGENT_ID",
  "ARMADRA_ENDPOINT_FILE",
  "ARMADRA_CANVAS_CONTROL",
  "ARMADRA_PERM_WAIT_SECS",
  "ARMADRA_HOOK_DEBUG",
  "ARMADRA_SESSION_ID",
  "ARMADRA_SESSION_GENERATION",
  "ARMADRA_DATA_DIR",
  "ARMADRA_HOOK_TIMEOUT_MS",
];

interface Output {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a client with a clean ARMADRA environment plus `env`.
 *
 * `ARMADRA_DATA_DIR` always ends up set to a fresh, empty directory (unless
 * `env` names one explicitly): the client also tries the default
 * data-directory location as a failover candidate, and without this a machine
 * with a real Armadra install would have its "no endpoint" cases silently pick
 * up that installation's endpoint file instead.
 */
function runProgram(
  program: string[],
  args: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<Output> {
  const isolated = tempdir();
  const environment: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  for (const name of CLEARED) delete environment[name];
  environment["ARMADRA_DATA_DIR"] = isolated;
  Object.assign(environment, env);
  const child = spawn(program[0]!, [...program.slice(1), ...args], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => {
    // A client that exits before draining is the case under test elsewhere.
  });
  child.stdin.end(stdin);
  return new Promise((resolve) => {
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function run(
  args: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<Output> {
  return runProgram([process.execPath, bundle], args, env, stdin);
}

function runRust(
  args: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<Output> {
  return runProgram([rustClient], args, env, stdin);
}

/* ---------------------------------- cases --------------------------------- */

describe("hook mode", () => {
  it("sends the expected request", async () => {
    const directory = tempdir();
    const server = await serve("HTTP/1.1 204 No Content\r\n\r\n");
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["claude"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_AGENT_ID: "claude",
        ARMADRA_ENDPOINT_FILE: endpoint,
      },
      '{"hook_event_name":"PreToolUse","tool_name":"Bash"}',
    );
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("");

    const captured = await server.request();
    expect(requestLine(captured)).toBe("POST /hook/claude HTTP/1.1");
    expect(headerNames(captured)).toEqual([
      "Host",
      "Connection",
      "X-Armadra-Hook-Client",
      "X-Armadra-Hook-Token",
      "X-Armadra-Node-Token",
      "Content-Type",
      "Content-Length",
    ]);
    expect(header(captured, "Host")).toBe("127.0.0.1");
    expect(header(captured, "X-Armadra-Hook-Client")).toBe("4");
    expect(header(captured, "X-Armadra-Hook-Token")).toBe("app-token-abc");
    expect(header(captured, "X-Armadra-Node-Token")).toBe("kid1234.macvalue");
    expect(header(captured, "Content-Type")).toBe("application/json");
    expect(captured.body).toBe(
      '{"nodeId":"node-7","payload":{"hook_event_name":"PreToolUse","tool_name":"Bash"},"version":1}',
    );
    expect(header(captured, "Content-Length")).toBe(
      String(Buffer.byteLength(captured.body)),
    );
    server.close();
  });

  it("wraps non-JSON stdin on the wire", async () => {
    const directory = tempdir();
    const server = await serve("HTTP/1.1 204 No Content\r\n\r\n");
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["codex"],
      { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: endpoint },
      "UserPromptSubmit\n",
    );
    expect(output.code).toBe(0);

    const captured = await server.request();
    expect(requestLine(captured)).toBe("POST /hook/codex HTTP/1.1");
    expect(captured.body).toBe(
      '{"nodeId":"node-7","payload":{"raw":"UserPromptSubmit\\n"},"version":1}',
    );
    server.close();
  });

  it("fails open without an endpoint file", async () => {
    const output = await run(
      ["claude"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_ENDPOINT_FILE: path.join(tempdir(), "gone.env"),
      },
      '{"hook_event_name":"Stop"}',
    );
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
  });

  it("fails open when nothing is listening", async () => {
    const endpoint = writeEndpointFile(tempdir(), await deadPort());
    const output = await run(
      ["claude"],
      { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: endpoint },
      '{"hook_event_name":"Stop"}',
    );
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
  });

  it("is a no-op without a node id", async () => {
    // No endpoint file at all: the client must still drain stdin and exit 0 so
    // a user's own terminal is unaffected by a stale hook install.
    const output = await run(["claude"], {}, "some payload\n");
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
  });

  it("caps oversize stdin and still reports", async () => {
    const directory = tempdir();
    const server = await serve("HTTP/1.1 204 No Content\r\n\r\n");
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["claude"],
      { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: endpoint },
      "x".repeat(1024 * 1024 + 4096),
    );
    expect(output.code).toBe(0);

    const captured = await server.request();
    const body = JSON.parse(captured.body) as {
      payload: { truncated: boolean; raw: string };
    };
    expect(body.payload.truncated).toBe(true);
    expect(body.payload.raw.length).toBe(1024 * 1024);
    server.close();
  });
});

describe("context-usage", () => {
  it("sends only bound metadata with a monotonic revision", async () => {
    const directory = tempdir();
    const server = await serve("HTTP/1.1 204 No Content\r\n\r\n");
    const endpoint = writeEndpointFile(directory, server.port);
    const sequences = path.join(directory, "context-sequences");
    fs.mkdirSync(sequences);
    if (process.platform !== "win32") fs.chmodSync(sequences, 0o700);
    const seed = Buffer.alloc(16);
    seed.writeBigUInt64BE(4n, 0);
    seed.writeBigUInt64BE(~4n & 0xffff_ffff_ffff_ffffn, 8);
    fs.writeFileSync(path.join(sequences, "session-1-2.seq"), seed);

    const output = await run(
      ["context-usage"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_ENDPOINT_FILE: endpoint,
        ARMADRA_SESSION_ID: "session-1",
        ARMADRA_SESSION_GENERATION: "2",
      },
      '{"session_id":"provider-1","model":{"id":"fixture"},"transcript_path":"private-content",' +
        '"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":100,' +
        '"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":99}}}',
    );
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");

    const captured = await server.request();
    const body = JSON.parse(captured.body) as {
      payload: {
        armadraContextUsage: {
          sessionId: string;
          generation: number;
          sourceRevision: string;
        };
      };
    };
    const report = body.payload.armadraContextUsage;
    expect(report.sessionId).toBe("session-1");
    expect(report.generation).toBe(2);
    expect(report.sourceRevision).toBe("5");
    expect(captured.body).not.toContain("private-content");
    expect(captured.body).not.toContain("output_tokens");
    server.close();
  });
});

describe("control", () => {
  it("sends the expected canvas dry-run request", async () => {
    const directory = tempdir();
    const server = await serve(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 22\r\n\r\nnode-7 api\nnode-9 web\n",
    );
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["canvas", "list", "--dry-run"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_CANVAS_CONTROL: "1",
        ARMADRA_ENDPOINT_FILE: endpoint,
      },
      "",
    );
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("node-7 api\nnode-9 web\n");

    const captured = await server.request();
    expect(requestLine(captured)).toBe("POST /control/list HTTP/1.1");
    expect(header(captured, "X-Armadra-Node-Token")).toBe("kid1234.macvalue");
    expect(captured.body).toBe('{"args":{"dry-run":true},"nodeId":"node-7"}');
    server.close();
  });

  it("sends the node and line count for a context summary", async () => {
    const directory = tempdir();
    const server = await serve(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nprose",
    );
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["context", "summary", "--node", "api", "-n", "20"],
      { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: endpoint },
      "",
    );
    expect(output.code).toBe(0);
    expect(output.stdout).toBe("prose\n");

    const captured = await server.request();
    expect(requestLine(captured)).toBe("POST /context-link/summary HTTP/1.1");
    expect(captured.body).toBe(
      '{"args":{"n":20,"node":"api"},"nodeId":"node-7"}',
    );
    server.close();
  });

  it("exits 1 with a stderr message on failure", async () => {
    const directory = tempdir();
    const server = await serve(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 31\r\n\r\n{"error":"node is not linked"}\n',
    );
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["context", "transcript", "--node", "api"],
      { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: endpoint },
      "",
    );
    expect(output.code).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("node is not linked (403)");
    server.close();
  });

  it("falls back to the default data directory when the env file is missing", async () => {
    const directory = tempdir();
    const server = await serve(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\n\r\nnode-7 api\n\n",
    );
    // Written straight to `directory` — the well-known location under
    // ARMADRA_DATA_DIR, not the (unset) ARMADRA_ENDPOINT_FILE.
    writeEndpointFile(directory, server.port);

    const output = await run(
      ["canvas", "list"],
      { ARMADRA_NODE_ID: "node-7", ARMADRA_DATA_DIR: directory },
      "",
    );
    expect(output.stderr).toBe("");
    expect(output.code).toBe(0);

    const captured = await server.request();
    expect(requestLine(captured)).toBe("POST /control/list HTTP/1.1");
    expect(header(captured, "X-Armadra-Hook-Token")).toBe("app-token-abc");
    server.close();
  });

  it("moves past a dead env file to a live default location", async () => {
    const directory = tempdir();
    const stale = writeEndpointFile(tempdir(), await deadPort());
    const server = await serve(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\n\r\nnode-7 api\n\n",
    );
    writeEndpointFile(directory, server.port);

    const output = await run(
      ["canvas", "list"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_ENDPOINT_FILE: stale,
        ARMADRA_DATA_DIR: directory,
      },
      "",
    );
    expect(output.stderr).toBe("");
    expect(output.code).toBe(0);
    expect(requestLine(await server.request())).toBe(
      "POST /control/list HTTP/1.1",
    );
    server.close();
  });
});

describe("permission wait", () => {
  it("waits for an answer file", async () => {
    const directory = tempdir();
    const server = await serve("HTTP/1.1 204 No Content\r\n\r\n");
    const endpoint = writeEndpointFile(directory, server.port);
    const pending = path.join(directory, "pending");

    // Stand in for the runtime: wait for the request file to appear, then
    // answer it the way the approval card would.
    const answering = (async (): Promise<[string, string] | undefined> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const entries = fs.existsSync(pending) ? fs.readdirSync(pending) : [];
        const request = entries.find((entry) => entry.endsWith(".json"));
        if (request !== undefined) {
          const stem = request.slice(0, -".json".length);
          const body = fs.readFileSync(path.join(pending, request), "utf8");
          fs.writeFileSync(path.join(pending, `${stem}.answer`), "allow\n");
          return [stem, body];
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return undefined;
    })();

    const output = await run(
      ["claude"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_ENDPOINT_FILE: endpoint,
        ARMADRA_PERM_WAIT_SECS: "10",
      },
      '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}',
    );

    const answered = await answering;
    expect(answered, "a request file appeared").toBeDefined();
    const [id, requestJson] = answered!;
    expect(
      id.startsWith("node-7-"),
      `pending id is <nodeId>-<epochMs>-<pid>, got ${id}`,
    ).toBe(true);
    expect(id.split("-").length).toBe(4);
    expect(requestJson).toContain("PermissionRequest");

    expect(output.code).toBe(0);
    expect(output.stdout.trim()).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );

    // Both files are cleaned up by the client once it has the answer.
    expect(fs.existsSync(path.join(pending, `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(pending, `${id}.answer`))).toBe(false);

    const captured = await server.request();
    const body = JSON.parse(captured.body) as {
      pendingId: string;
      answered?: string;
    };
    expect(body.pendingId).toBe(id);
    expect(body.answered, "first POST is the request").toBeUndefined();
    server.close();
  }, 30_000);

  it("prints nothing on a timeout", async () => {
    const directory = tempdir();
    const server = await serve("HTTP/1.1 204 No Content\r\n\r\n");
    const endpoint = writeEndpointFile(directory, server.port);

    const output = await run(
      ["claude"],
      {
        ARMADRA_NODE_ID: "node-7",
        ARMADRA_ENDPOINT_FILE: endpoint,
        ARMADRA_PERM_WAIT_SECS: "1",
      },
      '{"hook_event_name":"PermissionRequest"}',
    );
    expect(output.code).toBe(0);
    expect(
      output.stdout,
      "a timeout must leave the CLI's own prompt in charge",
    ).toBe("");
    server.close();
  }, 30_000);
});

/* ------------------------- byte-for-byte vs. Rust ------------------------- */

describe.skipIf(!hasRustClient)("matches the Rust client byte for byte", () => {
  it("prints the same usage and version", async () => {
    for (const args of [
      ["--help"],
      ["-h"],
      ["help"],
      ["--version"],
      ["-V"],
      [],
    ]) {
      const [ts, rust] = await Promise.all([
        run(args, {}, ""),
        runRust(args, {}, ""),
      ]);
      expect(ts.stdout, args.join(" ")).toBe(rust.stdout);
      expect(ts.stderr, args.join(" ")).toBe(rust.stderr);
      expect(ts.code, args.join(" ")).toBe(rust.code);
    }
  });

  it("prints the same usage errors", async () => {
    const cases: string[][] = [
      ["context"],
      ["context", "nope"],
      ["context", "summary", "--bogus", "x"],
      ["context", "summary", "-n", "abc"],
      ["canvas"],
      ["canvas", "--oops"],
      ["canvas", "list", "positional"],
      ["browser"],
      ["browser", "nope"],
      ["-x"],
    ];
    for (const args of cases) {
      const [ts, rust] = await Promise.all([
        run(args, {}, ""),
        runRust(args, {}, ""),
      ]);
      expect(ts.stderr, args.join(" ")).toBe(rust.stderr);
      expect(ts.stdout, args.join(" ")).toBe(rust.stdout);
      expect(ts.code, args.join(" ")).toBe(rust.code);
    }
  });

  it("sends the same bytes for a hook report, a canvas call and a context read", async () => {
    const cases: { args: string[]; stdin: string; response: string }[] = [
      {
        args: ["claude"],
        stdin:
          '{"hook_event_name":"PreToolUse","tool_name":"Bash","n":1,"f":1.5}',
        response: "HTTP/1.1 204 No Content\r\n\r\n",
      },
      {
        args: ["canvas", "link", "--to", "a", "--to", "b", "--dry-run"],
        stdin: "",
        response:
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nok\n",
      },
      {
        args: ["context", "list"],
        stdin: "",
        response:
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 26\r\n\r\n" +
          '{"message":"two nodes"}\r\n\r\n',
      },
      {
        // `-n` is documented for `browser read` but the flag parser only ever
        // took `--`-prefixed tokens; both clients reject it identically, which
        // the usage-error case above covers.
        args: ["browser", "read", "--mode", "text", "--lines", "5"],
        stdin: "",
        response:
          "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 34\r\n\r\n" +
          '{"error":"LEASE_HELD_BY_HUMAN"}\r\n\r\n',
      },
    ];
    for (const { args, stdin, response } of cases) {
      const label = args.join(" ");
      const tsDirectory = tempdir();
      const tsServer = await serve(response);
      const tsEndpoint = writeEndpointFile(tsDirectory, tsServer.port);
      const rustDirectory = tempdir();
      const rustServer = await serve(response);
      const rustEndpoint = writeEndpointFile(rustDirectory, rustServer.port);

      const tsOutput = await run(
        args,
        { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: tsEndpoint },
        stdin,
      );
      const rustOutput = await runRust(
        args,
        { ARMADRA_NODE_ID: "node-7", ARMADRA_ENDPOINT_FILE: rustEndpoint },
        stdin,
      );
      expect(tsOutput.stdout, label).toBe(rustOutput.stdout);
      expect(tsOutput.stderr, label).toBe(rustOutput.stderr);
      expect(tsOutput.code, label).toBe(rustOutput.code);

      const tsCaptured = await tsServer.request().catch(() => {
        throw new Error(
          `${label}: the TypeScript client sent nothing (${JSON.stringify(tsOutput)})`,
        );
      });
      const rustCaptured = await rustServer.request().catch(() => {
        throw new Error(
          `${label}: the Rust client sent nothing (${JSON.stringify(rustOutput)})`,
        );
      });
      expect(tsCaptured.head, label).toBe(rustCaptured.head);
      expect(tsCaptured.body, label).toBe(rustCaptured.body);
      tsServer.close();
      rustServer.close();
    }
  }, 60_000);

  it("prints the same doctor report", async () => {
    const directory = tempdir();
    const server = await serve(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok",
    );
    const endpoint = writeEndpointFile(directory, server.port);
    const environment = {
      ARMADRA_NODE_ID: "node-7",
      ARMADRA_ENDPOINT_FILE: endpoint,
    };
    const [ts, rust] = await Promise.all([
      run(["doctor"], environment, ""),
      runRust(["doctor"], environment, ""),
    ]);
    expect(ts.stdout).toBe(rust.stdout);
    expect(ts.stderr).toBe(rust.stderr);
    expect(ts.code).toBe(rust.code);
    server.close();
  });

  it("prints the same doctor report with nothing configured", async () => {
    const [ts, rust] = await Promise.all([
      run(["doctor"], {}, ""),
      runRust(["doctor"], {}, ""),
    ]);
    // The isolated data directory differs per invocation, so compare the
    // shape: every line but the candidate list is identical text.
    const shape = (text: string): string[] =>
      text
        .split("\n")
        .map((line) => line.replace(/\/[^ ,]*armadra[^ ,]*/gi, "<dir>"));
    expect(shape(ts.stdout)).toEqual(shape(rust.stdout));
    expect(ts.code).toBe(rust.code);
  });
});
