/**
 * 控制端这一侧的远端画布注入：SSH 终端要起的时候，把注入产物同步到执行主机、
 * 算出远端 shell 要带的环境，并把远端 Hook 客户端经 Worker 中继回来的请求交给
 * 本机的 Hook 服务（设计见 docs/design/remote-canvas-injection.md）。
 *
 * 一台主机一份状态：
 *
 *  * 位置（`integration.locate`）与上次同步的指纹按主机记住，指纹没变不再同步；
 *    连接断了两样都清掉——对面换了一个 Worker，重新确认一次很便宜；
 *  * 中继 socket 活在 Worker 会话里：每次控制连接握手成功都重开一次；连接断了
 *    而这台主机上开过画布 SSH 终端，隔几秒自己拉起连接，而不是等下一个文件请求。
 *
 * 任何一步失败都只让这个终端「不带注入」：SSH 终端照常打开，CLI 照常启动。
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { parse as parseEndpoint } from "../hook/endpoint";
import { issueNodeToken } from "../hook/tokens";
import {
  type RemoteFile,
  type RemoteIntegrationSite,
  fingerprint,
  remoteCodexCommand,
  remoteIntegrationFiles,
  remoteInjectionReady,
  shimDirectory,
} from "../hook/install/remote";
import { defaultBundleCandidates } from "../hook/install/shared";
import { hookEndpointFile } from "../paths";
import type { RemoteChannel, RemoteListener, RemotePushEvent } from "./execute";

type EnvPairs = readonly (readonly [string, string])[];

/** 发给某台执行主机上 Worker 的一个动作（`remote/execute.ts` 的 `executeRemote`）。 */
export type IntegrationCaller = (
  hostId: string,
  operation: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** 本机 Hook 服务在哪、令牌是什么。 */
export interface LocalHookEndpoint {
  readonly socket?: string | undefined;
  readonly port?: number | undefined;
  readonly token: string;
}

export interface RemoteIntegrationOptions {
  readonly dataDir: string;
  readonly version: string;
  readonly call: IntegrationCaller;
  /** `armadra-hook.js` 的内容；缺省按打包与构建树的位置找。 */
  readonly hookBundle?: () => string | undefined;
  /** 本机 Hook 服务；缺省读 `<数据目录>/hook-endpoint.env`。 */
  readonly hookEndpoint?: () => LocalHookEndpoint | undefined;
  /** 断线后隔多久自己重连；测试调短。 */
  readonly reconnectMs?: number;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * 从本机终端环境转到远端 shell 的变量：节点身份、会话代次、权限等待。路径类的
 * 换成远端的，Codex 那两个长值不转——远端的在垫片里。
 */
const NOT_FORWARDED = new Set([
  "ARMADRA_ENDPOINT_FILE",
  "ARMADRA_CODEX_HOOK",
  "ARMADRA_CODEX_INSTRUCTIONS",
  "ARMADRA_DATA_DIR",
]);

/**
 * 能原样放进 `ssh` 远端命令的值：不管远端登录 shell 是 sh、fish 还是 csh，
 * 单引号里没有 `'`、`\`、`!` 与控制字符就都是字面量。放不进去的变量不转
 * （目前只可能是节点名），而不是冒险让远端 shell 解释它。
 */
const FORWARDABLE = /^[^'\\!\u0000-\u001f\u007f]*$/u;

/** 远端 Hook 客户端的总时限：中继多一趟 ssh 往返，本机的 1.5 秒不够。 */
const REMOTE_HOOK_TIMEOUT_MS = "4000";

/** 一个中继请求交给本机 Hook 服务时的时限：权限请求会等人回答。 */
const FORWARD_TIMEOUT_MS = 15 * 60_000;

interface HostState {
  site?: RemoteIntegrationSite;
  synced?: string;
  listening?: Promise<void>;
  wanted: boolean;
  timer?: NodeJS.Timeout;
}

export class RemoteIntegration implements RemoteListener {
  private readonly hosts = new Map<string, HostState>();
  private readonly inflight = new Set<Promise<void>>();
  readonly controlId: string;

  constructor(private readonly options: RemoteIntegrationOptions) {
    this.controlId = createHash("sha256")
      .update(`${hostname()}\0${options.dataDir}`)
      .digest("hex")
      .slice(0, 16);
  }

  private state(hostId: string): HostState {
    let state = this.hosts.get(hostId);
    if (state === undefined) {
      state = { wanted: false };
      this.hosts.set(hostId, state);
    }
    return state;
  }

  /**
   * 一个画布 SSH 终端要在 `hostId` 上起：确保注入产物与节点令牌在那边、中继
   * 开着，答远端 shell 要带的环境。不是 Agent 终端、没有 Hook 客户端包、Worker
   * 不支持或任何一步失败，答 `undefined`。
   */
  async terminal(hostId: string, env: EnvPairs): Promise<EnvPairs | undefined> {
    const lookup = new Map(env.map(([key, value]) => [key, value]));
    const nodeId = lookup.get("ARMADRA_NODE_ID");
    if (nodeId === undefined || lookup.get("ARMADRA_AGENT_ID") === undefined) {
      return undefined;
    }
    if (!remoteInjectionReady()) return undefined;
    const bundle = (this.options.hookBundle ?? readHookBundle)();
    if (bundle === undefined) {
      this.options.log?.("no hook client bundle to sync to the host", {
        hostId,
      });
      return undefined;
    }
    try {
      const state = this.state(hostId);
      state.wanted = true;
      const site = await this.site(hostId, state);
      const files = remoteIntegrationFiles(site, bundle);
      const print = fingerprint(files);
      if (state.synced !== print) {
        await this.sync(hostId, files, remoteCodexCommand(site.root));
        state.synced = print;
      }
      const token = issueNodeToken(this.options.dataDir, nodeId);
      await this.sync(hostId, [tokenFile(site, nodeId, token)]);
      await this.listen(hostId, state);
      return remoteEnvironment(env, site);
    } catch (failure) {
      this.options.log?.("could not prepare the remote canvas injection", {
        hostId,
        error: failure instanceof Error ? failure.message : String(failure),
      });
      return undefined;
    }
  }

  private async site(
    hostId: string,
    state: HostState,
  ): Promise<RemoteIntegrationSite> {
    if (state.site !== undefined) return state.site;
    const answer = (await this.options.call(hostId, "integration.locate", {
      controlId: this.controlId,
      version: this.options.version.replace(/[^A-Za-z0-9._-]/gu, "_"),
    })) as RemoteIntegrationSite & { platform?: string };
    if (answer.platform === "win32") {
      throw new Error("The execution host is not POSIX");
    }
    const site: RemoteIntegrationSite = {
      root: answer.root,
      node: answer.node,
      socket: answer.socket,
      endpointFile: answer.endpointFile,
      tokenDir: answer.tokenDir,
    };
    state.site = site;
    return site;
  }

  /** 先只报哈希，再只发缺的那些。 */
  private async sync(
    hostId: string,
    files: readonly RemoteFile[],
    codexCommand?: string,
  ): Promise<void> {
    const manifest = files.map(({ path, sha256, mode }) => ({
      path,
      sha256,
      mode,
    }));
    const first = (await this.options.call(hostId, "integration.sync", {
      files: manifest,
      ...(codexCommand === undefined ? {} : { codexCommand }),
    })) as { missing?: string[] };
    const missing = new Set(first.missing ?? []);
    if (missing.size === 0) return;
    const second = (await this.options.call(hostId, "integration.sync", {
      files: files.map((entry) =>
        missing.has(entry.path)
          ? {
              path: entry.path,
              sha256: entry.sha256,
              mode: entry.mode,
              content: entry.content,
            }
          : { path: entry.path, sha256: entry.sha256, mode: entry.mode },
      ),
      ...(codexCommand === undefined ? {} : { codexCommand }),
    })) as { missing?: string[] };
    if ((second.missing ?? []).length > 0) {
      throw new Error("The execution host did not take the injection files");
    }
  }

  private async listen(hostId: string, state: HostState): Promise<void> {
    state.listening ??= (async () => {
      const site = await this.site(hostId, state);
      await this.options.call(hostId, "hook.listen", { socket: site.socket });
    })().catch((failure: unknown) => {
      state.listening = undefined;
      throw failure;
    });
    await state.listening;
  }

  /* ------------------------------ 远端事件 ------------------------------ */

  event(hostId: string, channel: RemoteChannel, event: RemotePushEvent): void {
    if (channel !== "control" || event.type !== "hook.request") return;
    const pending = this.forward(hostId, event).finally(() =>
      this.inflight.delete(pending),
    );
    this.inflight.add(pending);
  }

  /** 等在途的中继答复送完。给测试与关停用。 */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  connected(hostId: string, channel: RemoteChannel): void {
    if (channel !== "control") return;
    const state = this.hosts.get(hostId);
    if (state === undefined || !state.wanted) return;
    // 新的 Worker 会话没有中继：重开。
    void this.listen(hostId, state).catch(() => undefined);
  }

  disconnected(hostId: string, channel: RemoteChannel): void {
    if (channel !== "control") return;
    const state = this.hosts.get(hostId);
    if (state === undefined) return;
    state.site = undefined;
    state.synced = undefined;
    state.listening = undefined;
    if (!state.wanted || state.timer !== undefined) return;
    // 画布上还可能有这台主机的 Agent 在跑：自己把连接拉起来，Hook 才有地方报。
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.listen(hostId, state).catch(() => {
        // 连不上：下一次有请求把连接拉起来时，`connected` 会再开中继。
      });
    }, this.options.reconnectMs ?? 3_000);
    state.timer.unref?.();
  }

  /** 关停：不再重连。 */
  stop(): void {
    for (const state of this.hosts.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      state.wanted = false;
    }
  }

  /** 把一条中继请求交给本机 Hook 服务，再把答复送回 Worker。 */
  private async forward(hostId: string, event: RemotePushEvent): Promise<void> {
    const relayId = event.relayId;
    if (typeof relayId !== "string") return;
    let status = 502;
    let headers: [string, string][] = [];
    let body: Buffer = Buffer.alloc(0);
    const endpoint = (
      this.options.hookEndpoint ??
      (() => readLocalEndpoint(this.options.dataDir))
    )();
    if (endpoint !== undefined) {
      try {
        ({ status, headers, body } = await forwardTo(endpoint, event));
      } catch {
        status = 502;
      }
    }
    try {
      await this.options.call(hostId, "hook.reply", {
        relayId,
        status,
        headers,
        body: body.toString("base64"),
      });
    } catch (failure) {
      this.options.log?.("could not answer a relayed hook request", {
        hostId,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  }
}

function tokenFile(
  site: RemoteIntegrationSite,
  nodeId: string,
  token: string,
): RemoteFile {
  return {
    path: `${site.tokenDir}/${nodeId}`,
    content: token,
    mode: 0o600,
    sha256: createHash("sha256").update(token, "utf8").digest("hex"),
  };
}

/** 远端 shell 带的环境：身份照转，端点换成远端的，再加垫片目录与客户端时限。 */
export function remoteEnvironment(
  env: EnvPairs,
  site: RemoteIntegrationSite,
): EnvPairs {
  const forwarded: [string, string][] = [];
  for (const [key, value] of env) {
    if (!key.startsWith("ARMADRA_") || NOT_FORWARDED.has(key)) continue;
    if (!FORWARDABLE.test(value)) continue;
    forwarded.push([key, value]);
  }
  forwarded.push(
    ["ARMADRA_ENDPOINT_FILE", site.endpointFile],
    ["ARMADRA_HOOK_TIMEOUT_MS", REMOTE_HOOK_TIMEOUT_MS],
    ["ARMADRA_SHIMS", shimDirectory(site.root)],
  );
  return forwarded;
}

/** 构建产物里的 Hook 客户端包；源码树里没有就是 `undefined`。 */
export function readHookBundle(
  candidates: readonly string[] = defaultBundleCandidates(),
): string | undefined {
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      return readFileSync(candidate, "utf8");
    } catch {
      // 下一个。
    }
  }
  return undefined;
}

function readLocalEndpoint(dataDir: string): LocalHookEndpoint | undefined {
  let values: Map<string, string>;
  try {
    values = parseEndpoint(readFileSync(hookEndpointFile(dataDir), "utf8"));
  } catch {
    return undefined;
  }
  const token = values.get("ARMADRA_HOOK_TOKEN");
  if (token === undefined) return undefined;
  const port = Number(values.get("ARMADRA_HOOK_PORT"));
  return {
    token,
    socket: values.get("ARMADRA_HOOK_SOCK"),
    port: Number.isInteger(port) && port > 0 ? port : undefined,
  };
}

/** 中继请求原样发给本机 Hook 服务，只把令牌换成真的。 */
async function forwardTo(
  endpoint: LocalHookEndpoint,
  event: RemotePushEvent,
): Promise<{ status: number; headers: [string, string][]; body: Buffer }> {
  const method = typeof event.method === "string" ? event.method : "GET";
  const path =
    typeof event.path === "string" && event.path.startsWith("/")
      ? event.path
      : "/";
  const body =
    typeof event.body === "string"
      ? Buffer.from(event.body, "base64")
      : Buffer.alloc(0);
  const headers: Record<string, string> = {};
  for (const pair of Array.isArray(event.headers) ? event.headers : []) {
    if (!Array.isArray(pair)) continue;
    const [name, value] = pair as unknown[];
    if (typeof name !== "string" || typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "x-armadra-hook-token"
    ) {
      continue;
    }
    headers[name] = value;
  }
  headers["X-Armadra-Hook-Token"] = endpoint.token;
  headers["Content-Length"] = String(body.byteLength);
  headers.Connection = "close";
  if (endpoint.socket === undefined && endpoint.port === undefined) {
    throw new Error("The hook service has no address");
  }
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        method,
        path,
        headers,
        ...(endpoint.socket !== undefined
          ? { socketPath: endpoint.socket }
          : { host: "127.0.0.1", port: endpoint.port }),
        timeout: FORWARD_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 502,
            headers: headerPairs(response.headers),
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function headerPairs(headers: IncomingHttpHeaders): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const one of value) pairs.push([name, one]);
    } else {
      pairs.push([name, value]);
    }
  }
  return pairs;
}
