/**
 * Arbitrary text on its way from an agent's shell to the core, end to end.
 *
 * Every case runs the real bundle against a throwaway TCP server and checks
 * that the `body` the core would receive is exactly what the agent meant:
 *
 *   * everywhere: `--body -` from stdin and `--body-file` from a file;
 *   * on Windows: the installed `armadra-hook.exe` launcher called the way an
 *     agent's shell calls it — from Git Bash and from PowerShell — with a body
 *     full of what `cmd.exe` would have re-read (`& | " % ^`), CJK and a line
 *     break. Through the old `.cmd` launcher these came out as a different
 *     command; through the `.exe` they must arrive byte for byte.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

import { writeLauncher } from "./launcher.js";

const here = import.meta.dirname;
const desktop = path.resolve(here, "../../..");
const windows = process.platform === "win32";

/** What cmd.exe, bash and PowerShell each treat specially, CJK, a line break. */
const BODY = 'a & b | c "quoted" 100% ^caret %PATH% 中文\n第二行 end';

let bundle = "";
let buildDir = "";
const temporaries: string[] = [];

function tempdir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "armadra-text-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaries.length > 0) {
    fs.rmSync(temporaries.pop()!, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  }
});

afterAll(() => {
  if (buildDir !== "") fs.rmSync(buildDir, { recursive: true, force: true });
});

beforeAll(async () => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "armadra-text-build-"));
  await build({
    logLevel: "silent",
    build: {
      outDir: buildDir,
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
  bundle = path.join(buildDir, "armadra-hook.js");
  expect(fs.existsSync(bundle)).toBe(true);
}, 120_000);

/* ------------------------------ fake core -------------------------------- */

interface Core {
  port: number;
  /** The `args` object of the first control request. */
  args(): Promise<Record<string, unknown>>;
  close(): void;
}

async function fakeCore(): Promise<Core> {
  const reply = '{"message":"ok"}';
  const bodies: string[] = [];
  const waiters: ((body: string) => void)[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const headEnd = raw.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = raw.subarray(0, headEnd).toString("utf8");
      const lengthLine = head
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));
      const length = Number(lengthLine?.split(":")[1]?.trim() ?? 0);
      const body = raw.subarray(headEnd + 4);
      if (body.length < length) return;
      const text = body.subarray(0, length).toString("utf8");
      bodies.push(text);
      waiters.shift()?.(text);
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reply)}\r\n\r\n${reply}`,
      );
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    async args() {
      const body =
        bodies[0] ??
        (await new Promise<string>((resolve, reject) => {
          waiters.push(resolve);
          setTimeout(() => reject(new Error("no request arrived")), 10_000);
        }));
      const parsed = JSON.parse(body) as { args: Record<string, unknown> };
      return parsed.args;
    },
    close() {
      server.close();
    },
  };
}

/** The canvas environment a node's terminal would carry. */
function canvasEnv(port: number): Record<string, string> {
  const directory = tempdir();
  const endpoint = path.join(directory, "hook-endpoint.env");
  const tokens = path.join(directory, "node-tokens");
  fs.mkdirSync(tokens, { recursive: true });
  fs.writeFileSync(
    endpoint,
    `ARMADRA_HOOK_PORT='${port}'\nARMADRA_HOOK_TOKEN='app-token-abc'\n` +
      `ARMADRA_NODE_TOKEN_DIR='${tokens}'\nARMADRA_HOOK_VERSION='1'\n`,
  );
  fs.writeFileSync(path.join(tokens, "node-7"), "kid1234.macvalue\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ARMADRA_")) env[key] = value;
  }
  return {
    ...env,
    ARMADRA_NODE_ID: "node-7",
    ARMADRA_CANVAS_CONTROL: "1",
    ARMADRA_ENDPOINT_FILE: endpoint,
    ARMADRA_DATA_DIR: tempdir(),
  };
}

interface Output {
  code: number | null;
  stderr: string;
}

function run(
  program: string,
  args: string[],
  env: Record<string, string>,
  stdin = "",
): Promise<Output> {
  const child = spawn(program, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  child.stdout.resume();
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  return new Promise((resolve) => {
    child.on("close", (code) =>
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}

/* --------------------------------- cases --------------------------------- */

describe("text from stdin and files", () => {
  it("--body - carries stdin to the core unchanged", async () => {
    const core = await fakeCore();
    const output = await run(
      process.execPath,
      [bundle, "canvas", "send", "--to", "peer", "--body", "-"],
      canvasEnv(core.port),
      `${BODY}\n`,
    );
    expect(output.stderr).toBe("");
    expect(output.code).toBe(0);
    expect(await core.args()).toEqual({ to: "peer", body: BODY });
    core.close();
  });

  it("--body-file carries a file to the core unchanged", async () => {
    const core = await fakeCore();
    const file = path.join(tempdir(), "body.txt");
    fs.writeFileSync(file, `${BODY}\n`, "utf8");
    const output = await run(
      process.execPath,
      [
        bundle,
        "canvas",
        "post",
        "--to",
        "peer",
        "--key",
        "k",
        "--body-file",
        file,
      ],
      canvasEnv(core.port),
    );
    expect(output.stderr).toBe("");
    expect(output.code).toBe(0);
    expect(await core.args()).toEqual({ to: "peer", key: "k", body: BODY });
    core.close();
  });
});

/** Git for Windows' bash, where an agent CLI such as Claude runs its commands. */
function gitBash(): string | undefined {
  const roots = [
    process.env["ProgramFiles"],
    process.env["ProgramW6432"],
    process.env["LOCALAPPDATA"] &&
      path.join(process.env["LOCALAPPDATA"], "Programs"),
  ];
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, "Git", "bin", "bash.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * PowerShell 7 when present: Windows PowerShell 5.1 passes an embedded `"` to
 * a native program without escaping it — its own bug, whatever the program is
 * — which is why the skill tells 5.1 users to use `--body-file` or stdin.
 */
function powerShell(): { program: string; modern: boolean } | undefined {
  for (const program of ["pwsh.exe", "powershell.exe"]) {
    const probe = spawnSync(program, ["-NoProfile", "-Command", "exit 0"], {
      windowsHide: true,
    });
    if (probe.status === 0) return { program, modern: program === "pwsh.exe" };
  }
  return undefined;
}

const bash = windows ? gitBash() : undefined;
const shell = windows ? powerShell() : undefined;

describe.runIf(windows)("the Windows launcher", () => {
  let launcher = "";

  beforeAll(async () => {
    const script = pathToFileURL(
      path.join(desktop, "scripts", "hook-launcher.mjs"),
    ).href;
    const { compileHookLauncher } = (await import(script)) as {
      compileHookLauncher(output: string): string;
    };
    const exe = compileHookLauncher(path.join(buildDir, "armadra-hook.exe"));
    const bin = path.join(buildDir, "bin");
    launcher = writeLauncher(
      bin,
      { runner: process.execPath, bundle, windowsExe: exe },
      "win32",
    );
    expect(path.basename(launcher)).toBe("armadra-hook.exe");
  }, 120_000);

  it.runIf(bash !== undefined)(
    "passes a Git Bash argument through untouched",
    async () => {
      const core = await fakeCore();
      // What an agent types: the body in single quotes, the program by path.
      const command = `'${launcher.replace(/\\/g, "/")}' canvas send --to peer --body '${BODY}'`;
      const output = await run(bash!, ["-c", command], canvasEnv(core.port));
      expect(output.stderr).toBe("");
      expect(output.code).toBe(0);
      expect(await core.args()).toEqual({ to: "peer", body: BODY });
      core.close();
    },
  );

  it.runIf(shell !== undefined)(
    "passes a PowerShell argument through untouched",
    async () => {
      const core = await fakeCore();
      const file = path.join(tempdir(), "body.txt");
      fs.writeFileSync(file, BODY, "utf8");
      const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const script = shell!.modern
        ? `& ${quoted(launcher)} canvas send --to peer --body ${quoted(BODY)}; exit $LASTEXITCODE`
        : `& ${quoted(launcher)} canvas send --to peer --body-file ${quoted(file)}; exit $LASTEXITCODE`;
      const output = await run(
        shell!.program,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        canvasEnv(core.port),
      );
      expect(output.stderr).toBe("");
      expect(output.code).toBe(0);
      expect(await core.args()).toEqual({ to: "peer", body: BODY });
      core.close();
    },
  );

  it("hands the exit code back", async () => {
    const output = await run(launcher, ["canvas"], canvasEnv(1));
    expect(output.code).toBe(1);
    expect(output.stderr).toMatch(/usage: armadra-hook canvas/);
  });
});
