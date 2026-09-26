/**
 * Worker 这一侧的画布注入：把控制端生成的产物落在这台机器上，并为 SSH 终端里
 * 的 Hook 客户端开一个中继 socket（设计见 docs/design/remote-canvas-injection.md）。
 *
 * 三个动作：
 *
 *  * `integration.locate`：答这台机器上的位置——注入根、Worker 自己的 node、中继
 *    socket、这个控制端的端点文件与节点令牌目录。根按版本分目录，两个不同版本的
 *    控制端连同一台主机时互不覆盖；
 *  * `integration.sync`：控制端先只报路径与哈希，Worker 答哪些缺了或不一样，控制
 *    端再把这些的内容发来。一样的文件不重写；每个路径必须落在注入目录之内；
 *  * `hook.listen` / `hook.reply`：中继。Hook 客户端连 socket 发一个 HTTP 请求，
 *    Worker 把它原样推给控制端（`hook.request`），控制端交给自己的 Hook 服务，
 *    再用 `hook.reply` 把答复送回来。socket 随 Worker 会话生死：连接断了它就
 *    关掉，客户端连不上时按原来的规矩静默退出，不挡住 CLI。
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  globalWritesDisabled,
  trustCodexSessionHooks,
} from "../hook/install/inject";
import { configHome } from "../hook/install/shared";
import { badRequest } from "../workspaces/support";
import type { WorkerSession } from "./session";

/** 一条中继请求最多等这么久：权限请求会等人回答。 */
const RELAY_TIMEOUT_MS = 15 * 60_000;
/** 与控制端 Hook 服务相同的请求体上限。 */
const MAX_RELAY_BODY = 1024 * 1024;
/** unix socket 路径的长度上限（macOS 104 字节，留一点余量）。 */
const MAX_SOCKET_PATH = 100;

/** Worker 的状态目录：`--state-dir`，没有就是 `~/.armadra-worker`。 */
export function stateBase(stateDir: string | undefined): string {
  return stateDir ?? join(homedir(), ".armadra-worker");
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/u;

function segment(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !SAFE_SEGMENT.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw badRequest(`${name} is invalid`);
  }
  return value;
}

export interface IntegrationSite {
  readonly root: string;
  readonly node: string;
  readonly socket: string;
  readonly endpointFile: string;
  readonly tokenDir: string;
  readonly platform: string;
}

/** 这台机器上这个控制端、这个版本的注入位置。 */
export function locate(
  stateDir: string | undefined,
  args: Record<string, unknown>,
): IntegrationSite {
  const controlId = segment(args.controlId, "controlId");
  const version = segment(args.version, "version");
  const base = stateBase(stateDir);
  const root = join(base, "integration", version);
  let socket = join(base, "run", `${controlId}.sock`);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    socket = join(tmpdir(), `armadra-worker-${uid}`, `${controlId}.sock`);
  }
  return {
    root,
    node: process.execPath,
    socket,
    endpointFile: join(root, "endpoints", `${controlId}.env`),
    tokenDir: join(root, "node-tokens"),
    platform: process.platform,
  };
}

interface SyncEntry {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
  readonly content?: string;
}

function entries(raw: unknown): SyncEntry[] {
  if (!Array.isArray(raw)) throw badRequest("files is required");
  return raw.map((value) => {
    const entry = value as Record<string, unknown>;
    if (
      typeof entry?.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      typeof entry.mode !== "number" ||
      (entry.content !== undefined && typeof entry.content !== "string")
    ) {
      throw badRequest("A synced file is malformed");
    }
    return {
      path: entry.path,
      sha256: entry.sha256,
      mode: entry.mode & 0o777,
      ...(entry.content === undefined ? {} : { content: entry.content }),
    };
  });
}

function currentHash(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function currentMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function writeFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, content, { encoding: "utf8", mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

export interface SyncResult {
  /** 缺内容、要控制端再发一次的路径。 */
  readonly missing: readonly string[];
  readonly written: number;
  /** Codex 信任记录是否改动；没写（没有 Codex、关着全局写入）是 `null`。 */
  readonly trustChanged: boolean | null;
}

/**
 * 按哈希落文件。每个路径都必须在 `<状态目录>/integration/` 之内：这个动作不是
 * 一个通用的「写这台机器上任意文件」。
 */
export function sync(
  stateDir: string | undefined,
  args: Record<string, unknown>,
): SyncResult {
  const fence = join(stateBase(stateDir), "integration") + sep;
  const missing: string[] = [];
  let written = 0;
  for (const entry of entries(args.files)) {
    const target = resolve(entry.path);
    if (target !== entry.path || !target.startsWith(fence)) {
      throw badRequest("A synced file is outside the integration directory");
    }
    if (
      currentHash(target) === entry.sha256 &&
      currentMode(target) === entry.mode
    ) {
      continue;
    }
    if (entry.content === undefined) {
      missing.push(entry.path);
      continue;
    }
    const actual = createHash("sha256")
      .update(entry.content, "utf8")
      .digest("hex");
    if (actual !== entry.sha256) {
      throw badRequest("A synced file does not match its hash");
    }
    writeFile(target, entry.content, entry.mode);
    written += 1;
  }
  let trustChanged: boolean | null = null;
  const command = args.codexCommand;
  if (
    typeof command === "string" &&
    missing.length === 0 &&
    !globalWritesDisabled(process.env)
  ) {
    // 与本机同一条规矩：这台机器没用过 Codex 就不替它建 `~/.codex`。
    const home = configHome("codex");
    if (existsSync(home)) {
      try {
        trustChanged = trustCodexSessionHooks(home, command).changed;
      } catch {
        // 认不出的 config.toml 不改写；Codex 的 Hook 因此不跑，技能与说明照样在。
        trustChanged = false;
      }
    }
  }
  return { missing, written, trustChanged };
}

/* ---------------------------------- 中继 ---------------------------------- */

interface Pending {
  readonly response: ServerResponse;
  readonly timer: NodeJS.Timeout;
}

/** 一个 Worker 会话里的中继 socket。 */
class HookRelay {
  private server: Server | undefined;
  private path: string | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly session: WorkerSession) {}

  async listen(socket: string): Promise<void> {
    if (this.server !== undefined && this.path === socket) return;
    await this.close();
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    // 上一个 Worker 留下的 socket 文件：连不上的旧文件挡住 listen。只删 socket，
    // 同名的普通文件不是我们的。
    try {
      if (lstatSync(socket).isSocket()) unlinkSync(socket);
    } catch {
      // 不存在。
    }
    const server = createServer((request, response) => {
      this.accept(request, response);
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(socket, () => {
        server.off("error", fail);
        done();
      });
    });
    chmodSync(socket, 0o600);
    this.server = server;
    this.path = socket;
  }

  private accept(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_RELAY_BODY) {
        refused = true;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (refused) return;
      const relayId = randomUUID();
      const timer = setTimeout(() => {
        this.answer(relayId, 504, [], Buffer.alloc(0));
      }, RELAY_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(relayId, { response, timer });
      const headers: [string, string][] = [];
      for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
        headers.push([
          request.rawHeaders[index] as string,
          request.rawHeaders[index + 1] as string,
        ]);
      }
      this.session.publish({
        type: "hook.request",
        relayId,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers,
        body: Buffer.concat(chunks).toString("base64"),
      });
    });
  }

  /** 把控制端的答复交回等着的客户端；已经答过或超时的答 `false`。 */
  answer(
    relayId: string,
    status: number,
    headers: readonly (readonly [string, string])[],
    body: Buffer,
  ): boolean {
    const pending = this.pending.get(relayId);
    if (pending === undefined) return false;
    this.pending.delete(relayId);
    clearTimeout(pending.timer);
    const response = pending.response;
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      // 长度与连接由这一侧重新决定。
      if (
        lower === "content-length" ||
        lower === "connection" ||
        lower === "transfer-encoding" ||
        lower === "keep-alive"
      ) {
        continue;
      }
      response.setHeader(name, value);
    }
    response.setHeader("content-length", String(body.byteLength));
    response.setHeader("connection", "close");
    response.writeHead(status);
    response.end(body);
    return true;
  }

  async close(): Promise<void> {
    for (const relayId of [...this.pending.keys()]) {
      this.answer(relayId, 503, [], Buffer.alloc(0));
    }
    const server = this.server;
    const path = this.path;
    this.server = undefined;
    this.path = undefined;
    if (server === undefined) return;
    await new Promise<void>((done) => server.close(() => done()));
    if (path !== undefined) {
      try {
        if (lstatSync(path).isSocket()) unlinkSync(path);
      } catch {
        // 已经没了。
      }
    }
  }
}

function relayOf(session: WorkerSession | undefined): HookRelay {
  if (session === undefined) {
    throw badRequest("The hook relay only runs on a worker");
  }
  return session.slot(
    "hook.relay",
    () => new HookRelay(session),
    async (relay) => await relay.close(),
  );
}

export async function listenHooks(
  session: WorkerSession | undefined,
  args: Record<string, unknown>,
): Promise<{ socket: string }> {
  const socket = args.socket;
  if (typeof socket !== "string" || !socket.startsWith("/")) {
    throw badRequest("socket is required");
  }
  await relayOf(session).listen(socket);
  return { socket };
}

export function replyHook(
  session: WorkerSession | undefined,
  args: Record<string, unknown>,
): { delivered: boolean } {
  const relayId = args.relayId;
  const status = args.status;
  if (typeof relayId !== "string" || typeof status !== "number") {
    throw badRequest("relayId and status are required");
  }
  const headers = Array.isArray(args.headers)
    ? (args.headers as unknown[]).filter(
        (pair): pair is [string, string] =>
          Array.isArray(pair) &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "string",
      )
    : [];
  const body =
    typeof args.body === "string"
      ? Buffer.from(args.body, "base64")
      : Buffer.alloc(0);
  return {
    delivered: relayOf(session).answer(relayId, status, headers, body),
  };
}
