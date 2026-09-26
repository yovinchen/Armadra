/**
 * 远端画布注入：产物同步到执行主机、SSH 终端的远端命令带上身份与垫片、远端
 * CLI 的 Hook 经 Worker 中继回到控制端。
 *
 * 与 `worker-push.test.ts` 同一个办法：core 的真入口打成包，本机子进程跑
 * `worker --stdio --state-dir <临时目录>`；Hook 客户端也打成包，由 Worker 那个
 * node 跑。「假 ssh」就是 sshd 做的那件事：把远端命令交给 `/bin/sh -c`。远端的
 * 登录 shell（`$SHELL`）换成一个只敲一行 `claude --model m` 的脚本，`claude`
 * 是一个假 CLI：打印它收到的 argv、读注入的说明与技能，再照 settings.json 里的
 * Hook 命令报一次 SessionStart。
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { registerSkillContent } from "../hook/install/skills";
import { issueNodeToken } from "../hook/tokens";
import type { SshHost } from "../settings/ssh-hosts";
import { tempDir } from "../testing/temp-dir";
import { remoteShellCommand } from "../terminal/ssh/argv";
import {
  executeRemote,
  listenRemote,
  remoteConnected,
  remoteDisconnected,
  remotePushed,
  setRemoteCaller,
} from "./execute";
import { RemoteIntegration } from "./integration";
import { RemoteWorker } from "./worker";
import {
  disposeWorkerBundle,
  hookClientBundle,
  spawnWorker,
} from "./worker.fixture";

const HOST: SshHost = {
  id: "far",
  name: "far",
  host: "far.example",
  worker: { path: "/opt/armadra/bin/armadra-core" },
};

const NODE_ID = "0192f1a0-7c1e-7b7a-8a55-3a1c2d3e4f50";

async function until<T>(
  read: () => T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function run(
  program: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let bundle: string;
let startWorker: (stateDir: string) => Promise<() => ChildProcess>;

beforeAll(async () => {
  bundle = readFileSync(await hookClientBundle(), "utf8");
  startWorker = async (stateDir) =>
    await spawnWorker(["--state-dir", stateDir]);
}, 180_000);

afterAll(() => {
  setRemoteCaller(undefined);
  disposeWorkerBundle();
});

describe("canvas injection on an SSH terminal", () => {
  let stateDir: string;
  let dataDir: string;
  let bin: string;
  let remote: RemoteWorker;
  let integration: RemoteIntegration;
  let hookServer: Server;
  let unlisten: () => void;
  let unregister: () => void;
  const received: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }[] = [];

  beforeEach(async () => {
    received.length = 0;
    stateDir = tempDir("armadra-far-state-");
    dataDir = tempDir("armadra-control-");
    bin = tempDir("armadra-far-bin-");
    unregister = registerSkillContent({
      skill: () => "# armadra skill\n<!-- armadra:skill-revision 13 -->\n",
      instructions: (skillPath) => `canvas rules; skill at ${skillPath}\n`,
      developerInstructions: (skillPath) => `developer rules ${skillPath}`,
    });
    // 控制端本机的 Hook 服务：记下中继转来的请求，答 204。
    const socket = join(tempDir("armadra-hook-sock-"), "hook.sock");
    hookServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(socket, resolve));

    const start = await startWorker(stateDir);
    remote = new RemoteWorker({
      dataDir: "/nonexistent",
      host: HOST,
      worker: HOST.worker as NonNullable<SshHost["worker"]>,
      askpass: {} as never,
      version: "0.1.0",
      spawn: start,
      node: async () => ({
        version: "v24.0.0",
        major: 24,
        usable: true,
        detail: "",
      }),
      onEvent: (event) => remotePushed(HOST.id, "control", event),
      onConnected: () => remoteConnected(HOST.id, "control"),
      onDisconnected: () => remoteDisconnected(HOST.id, "control"),
    });
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
    integration = new RemoteIntegration({
      dataDir,
      version: "0.1.0",
      call: async (hostId, operation, args) =>
        await executeRemote(hostId, operation, "/", args),
      hookBundle: () => bundle,
      hookEndpoint: () => ({ socket, token: "control-bearer" }),
      reconnectMs: 50,
    });
    unlisten = listenRemote(integration);
  });

  afterEach(async () => {
    await integration.settled();
    unlisten();
    integration.stop();
    remote.close();
    unregister();
    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  });

  it("syncs the artifacts once, keyed by their hashes", async () => {
    const env = [
      ["ARMADRA_NODE_ID", NODE_ID],
      ["ARMADRA_AGENT_ID", "claude"],
      ["ARMADRA_ENDPOINT_FILE", "/local/data/hook-endpoint.env"],
      ["ARMADRA_CODEX_HOOK", "[{hooks=[]}]"],
      ["ARMADRA_NODE_NAME", "it's mine"],
      ["ARMADRA_SESSION_ID", "s-1"],
    ] as const;
    const remoteEnv = await integration.terminal(HOST.id, env);
    expect(remoteEnv).toBeDefined();
    const values = new Map(remoteEnv);
    // 身份照转；本机路径、Codex 的长值与放不进远端命令的节点名不转。
    expect(values.get("ARMADRA_NODE_ID")).toBe(NODE_ID);
    expect(values.get("ARMADRA_SESSION_ID")).toBe("s-1");
    expect(values.has("ARMADRA_CODEX_HOOK")).toBe(false);
    expect(values.has("ARMADRA_NODE_NAME")).toBe(false);
    const endpoint = values.get("ARMADRA_ENDPOINT_FILE") as string;
    expect(endpoint.startsWith(join(stateDir, "integration", "0.1.0"))).toBe(
      true,
    );
    const shims = values.get("ARMADRA_SHIMS") as string;
    for (const cli of ["claude", "codex", "opencode", "pi", "omp", "copilot"]) {
      expect(statSync(join(shims, cli)).mode & 0o111).not.toBe(0);
    }
    // 端点文件里没有控制端的应用令牌。
    expect(readFileSync(endpoint, "utf8")).not.toContain("control-bearer");
    // 节点令牌与本机的是同一个值，文件只有属主可读。
    const token = join(
      stateDir,
      "integration",
      "0.1.0",
      "node-tokens",
      NODE_ID,
    );
    expect(readFileSync(token, "utf8")).toBe(issueNodeToken(dataDir, NODE_ID));
    expect(statSync(token).mode & 0o077).toBe(0);

    // 第二个终端：指纹没变，只同步令牌。
    const before = statSync(join(shims, "claude")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await integration.terminal(HOST.id, env);
    expect(statSync(join(shims, "claude")).mtimeMs).toBe(before);
  }, 60_000);

  it("runs a fake CLI through the shim and relays its hook back", async () => {
    // 假 CLI：真的 `claude` 在 PATH 上垫片的后面。
    const fake = join(bin, "claude");
    writeFileSync(
      fake,
      `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const argv = process.argv.slice(2);
const after = (flag) => argv[argv.indexOf(flag) + 1];
const settings = JSON.parse(readFileSync(after("--settings"), "utf8"));
const command = settings.hooks.SessionStart[0].hooks[0].command;
execSync(command, { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "provider-1" }) });
process.stdout.write(JSON.stringify({
  argv,
  shimOnPath: (process.env.PATH || "").includes(process.env.ARMADRA_SHIMS),
  instructions: readFileSync(after("--append-system-prompt-file"), "utf8"),
  skill: readFileSync(after("--plugin-dir") + "/skills/armadra/SKILL.md", "utf8"),
}) + "\\n");
`,
    );
    chmodSync(fake, 0o755);
    // 远端的登录 shell：只敲画布那一行启动行。
    const login = join(bin, "login-shell");
    writeFileSync(login, "#!/bin/sh\nexec claude --model m\n");
    chmodSync(login, 0o755);

    const remoteEnv = await integration.terminal(HOST.id, [
      ["ARMADRA_NODE_ID", NODE_ID],
      ["ARMADRA_AGENT_ID", "claude"],
    ]);
    expect(remoteEnv).toBeDefined();
    // 假 ssh：sshd 把远端命令交给登录 shell 的 `-c`。
    const outcome = await run(
      "/bin/sh",
      ["-c", remoteShellCommand(remoteEnv ?? [])],
      {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: stateDir,
        SHELL: login,
      },
    );
    expect(outcome.stderr).toBe("");
    const report = JSON.parse(outcome.stdout.trim()) as {
      argv: string[];
      shimOnPath: boolean;
      instructions: string;
      skill: string;
    };
    expect(report.argv.slice(0, 2)).toEqual(["--model", "m"]);
    expect(report.argv).toContain("--settings");
    // 垫片把自己从 PATH 里摘掉了，CLI 再起的同名程序不会又被注入。
    expect(report.shimOnPath).toBe(false);
    expect(report.instructions).toContain("canvas rules");
    expect(report.instructions).toContain(stateDir);
    expect(report.skill).toContain("armadra skill");

    const hook = await until(() =>
      received.find((entry) => entry.url === "/hook/claude"),
    );
    expect(hook.method).toBe("POST");
    // 中继换上控制端的应用令牌；节点令牌是远端文件里那一份。
    expect(hook.headers["x-armadra-hook-token"]).toBe("control-bearer");
    expect(hook.headers["x-armadra-node-token"]).toBe(
      issueNodeToken(dataDir, NODE_ID),
    );
    expect(JSON.parse(hook.body).nodeId).toBe(NODE_ID);
  }, 60_000);

  it("reopens the relay after the worker reconnects", async () => {
    const remoteEnv = await integration.terminal(HOST.id, [
      ["ARMADRA_NODE_ID", NODE_ID],
      ["ARMADRA_AGENT_ID", "claude"],
    ]);
    const endpoint = new Map(remoteEnv).get("ARMADRA_ENDPOINT_FILE") as string;
    const socketLine = readFileSync(endpoint, "utf8")
      .split("\n")
      .find((line) => line.startsWith("ARMADRA_HOOK_SOCK="));
    const socket = (socketLine ?? "").slice("ARMADRA_HOOK_SOCK='".length, -1);
    expect(existsSync(socket)).toBe(true);
    // 断线：旧 Worker 连同它的中继一起没了；控制端自己拉起连接、重开中继，
    // 之后经同一个 socket 的请求照样到达控制端。
    remote.close();
    let answered: number | undefined;
    const deadline = Date.now() + 15_000;
    while (answered !== 204 && Date.now() < deadline) {
      answered = await new Promise<number | undefined>((resolve) => {
        const probe = httpRequest(
          { socketPath: socket, path: "/verify", method: "GET" },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        probe.on("error", () => resolve(undefined));
        probe.end();
      });
      if (answered !== 204) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(answered).toBe(204);
    expect(received.some((entry) => entry.url === "/verify")).toBe(true);
  }, 60_000);

  it("forwards nothing when the terminal is not an agent's", async () => {
    expect(
      await integration.terminal(HOST.id, [["ARMADRA_CANVAS_CONTROL", "1"]]),
    ).toBeUndefined();
  });
});

describe("the remote command", () => {
  it("refuses a value a remote shell would interpret", () => {
    expect(() => remoteShellCommand([["ARMADRA_NODE_NAME", "a'b"]])).toThrow();
    expect(() => remoteShellCommand([["bad-key", "x"]])).toThrow();
    expect(
      remoteShellCommand([
        ["ARMADRA_NODE_ID", "n1"],
        ["ARMADRA_SHIMS", "/home/u/.armadra-worker/integration/1/shims"],
      ]),
    ).toBe(
      "env ARMADRA_NODE_ID='n1' ARMADRA_SHIMS='/home/u/.armadra-worker/integration/1/shims' /bin/sh -c " +
        `'PATH="$ARMADRA_SHIMS:$PATH"; export PATH; exec "\${SHELL:-/bin/sh}" -l'`,
    );
  });
});
