import type { AddressInfo } from "node:net";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { allowOrigins } from "../../desktop/src/core/http/cors";
import { DOMAINS, type RunningCore, run } from "../../desktop/src/core/main";
import { identityInstanceId } from "../../desktop/src/core/identity";
import { IdentityService } from "../../desktop/src/core/identity/service";
import { IdentityStore } from "../../desktop/src/core/identity/store";
import { canonicalOrigin } from "../../desktop/src/core/identity/origin";
import { allScopes } from "../../desktop/src/core/identity/scopes";
import type { CoreLog } from "../../desktop/src/core/platform";
import { type ListenAddress, loopbackHost } from "./cli";
import { type Refusal, gate } from "./auth";
import { serverPlatform } from "./platform-node";
import { type TlsMaterial, resolveTls } from "./tls";
import {
  type WebRoot,
  openWebRoot,
  resolveFile,
  sendFile,
  staticHeaders,
} from "./web-root";

/**
 * `serve`：在**同一个进程**里装配 core，并在它前面放一层 TLS。
 *
 * 没有代理。`run()` 装出来的 `CoreServer` 已经是一台完整的 HTTP 服务，只是它
 * 自己创建的监听都在回环上；这里向它要一个**不绑定任何地址**的 `http.Server`
 * 当作交接点，然后把 TLS 那一侧收到的 `request` / `upgrade` 原样转给它。走的是
 * 同一个事件循环里的一次函数调用，没有第二个套接字、没有一次多余的序列化，也
 * 没有 Go Host 时代那个 `proxy.go`——那份东西存在的唯一理由是两个进程。
 *
 * core 仍然自己在回环上监听一个内核分配的端口：hook 客户端、`endpoints.json`
 * 的发现提示、以及同机的诊断都打那里，公网这一侧只认 TLS 上的那个地址。
 *
 * 打包选型：`esbuild`（`scripts/build.mjs`）。理由是 core 与桌面壳共用的
 * electron-vite 也是 esbuild 系，同一个 bundler 的外部化规则不会在两种壳之间
 * 分叉；`node-pty` 等原生模块一律 `--external`，因为它们要按自己的相对路径找
 * `build/Release/*.node`。
 */

export interface ServeOptions {
  readonly listen: ListenAddress;
  readonly publicOrigins: readonly string[];
  readonly dataDir?: string | undefined;
  readonly webRoot: string;
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly deviceName: string;
  /** 启动时铸一张配对票并打印。`--no-pairing` 时为假。 */
  readonly pairing: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly moduleDir?: string;
}

export interface RunningServer {
  readonly core: RunningCore;
  readonly address: ListenAddress;
  readonly origin: string;
  readonly origins: readonly string[];
  readonly tls: TlsMaterial;
  readonly webRoot: WebRoot;
  readonly hostId: string;
  /** 这次启动铸的配对票，`--no-pairing` 时是 `undefined`。 */
  readonly pairingTicket: string | undefined;
  /** 再铸一张，用于 SIGUSR2 与测试。 */
  pair(): { ticket: string; url: string; expiresAtMs: number };
  stop(): Promise<void>;
}

/**
 * 这次运行接受的来源集合：显式给的 `--public-origin`，加上监听地址自己那个。
 * 后者是为了「直接用 IP 访问」这条路能走通；它不会放宽任何东西——那个地址本来
 * 就是这台服务器自己。
 */
export function originsFor(
  address: ListenAddress,
  publicOrigins: readonly string[],
): string[] {
  const own = canonicalOrigin(
    `https://${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}`,
  );
  const all = [...publicOrigins];
  if (own !== undefined) all.push(own);
  return [...new Set(all)];
}

/** 自签名证书要覆盖的名字。 */
export function certificateHosts(
  address: ListenAddress,
  publicOrigins: readonly string[],
): string[] {
  const hosts = publicOrigins.map((origin) => new URL(origin).hostname);
  hosts.push(address.host);
  // `0.0.0.0` 是「所有接口」，不是一个名字；它进不了 SAN。
  return [
    ...new Set(hosts.filter((host) => host !== "0.0.0.0" && host !== "::")),
  ];
}

export async function serve(options: ServeOptions): Promise<RunningServer> {
  if (
    !loopbackHost(options.listen.host) &&
    options.publicOrigins.length === 0
  ) {
    throw new Error(
      `拒绝在 ${options.listen.host} 上监听而不声明对外来源：加 --public-origin https://主机名`,
    );
  }
  const webRoot = await openWebRoot(options.webRoot);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    // 服务器壳只在统一库上跑：身份表是它的认证前提，没过单向门的库里没有它们。
    ARMADRA_CORE: "ts",
  };
  const stdout =
    options.stdout ?? ((line: string) => process.stdout.write(line));
  const core = await run({
    // core 自己的监听留在回环：公网这一侧由本文件的 TLS 服务负责。
    argv: [
      "--listen",
      "tcp:127.0.0.1:0",
      ...(options.dataDir === undefined ? [] : ["--data-dir", options.dataDir]),
    ],
    env,
    domains: DOMAINS,
    stdout,
    ...(options.moduleDir === undefined
      ? {}
      : { moduleDir: options.moduleDir }),
    platform: serverPlatform,
  });
  const log = core.platform.log;
  if (!core.db.unified) {
    await core.stop();
    throw new Error(
      "这个数据目录还没过统一库迁移，服务器壳没有身份表可用；先用桌面壳跑一次 ARMADRA_CORE=ts",
    );
  }

  const service = new IdentityService(
    new IdentityStore(core.db.database),
    identityInstanceId(),
  );
  const hostId = service.hostId();

  let tls: TlsMaterial;
  let https: Server;
  let bound: ListenAddress;
  let origins: string[];
  try {
    tls = resolveTls({
      certFile: options.certFile,
      keyFile: options.keyFile,
      dataDir: core.dataDir,
      hosts: certificateHosts(options.listen, options.publicOrigins),
    });
    const delegate = core.server.createListener();
    https = createHttpsServer({ cert: tls.cert, key: tls.key });
    bound = await listen(https, options.listen);
    origins = originsFor(bound, options.publicOrigins);
    // core 的 CORS 默认只放行回环来源。服务器壳的页面不在回环上，所以这里把
    // 这次运行的来源注入进去——注入点在 `core/http/cors.ts`，判定仍然只有一处。
    allowOrigins(origins);
    const context = { origins: new Set(origins), service, hostId };
    https.on("request", (request, response) => {
      void handle(request, response, {
        context,
        delegate,
        webRoot,
        log,
      });
    });
    https.on("upgrade", (request, socket, head) => {
      const refusal = gate(
        {
          method: request.method ?? "GET",
          path: pathOf(request),
          headers: request.headers,
          upgrade: true,
        },
        context,
      );
      if (refusal !== undefined) {
        socket.write(
          `HTTP/1.1 ${refusal.status} ${refusal.body.code}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      delegate.emit("upgrade", request, socket as Duplex, head);
    });
  } catch (error) {
    await core.stop();
    throw error;
  }

  const origin = origins[0] as string;
  const pair = (): { ticket: string; url: string; expiresAtMs: number } => {
    const issued = service.issueBootstrap({
      hostId,
      instanceId: identityInstanceId(),
      origin,
      deviceName: options.deviceName,
      // 单 owner 的服务器壳：配对出来的设备拿全套授权。R6b 的账号线会把这里
      // 换成按 principal 编译出来的 scope，接口点就是这一个参数。
      scopes: allScopes(),
    });
    return {
      ...issued,
      // 票只进片段，不进路径也不进查询：片段不上请求行，因此不进任何访问日志。
      url: `${origin}/#pair=${issued.ticket}`,
    };
  };

  log.info("Armadra 服务器壳已就绪", {
    origin,
    tls: tls.selfSigned ? "自签名" : tls.certFile,
    webRoot: webRoot.directory,
  });
  let pairingTicket: string | undefined;
  if (options.pairing) {
    const issued = pair();
    pairingTicket = issued.ticket;
    stdout(`armadra-server pairing ${issued.url}\n`);
  }

  return {
    core,
    address: bound,
    origin,
    origins,
    tls,
    webRoot,
    hostId,
    pairingTicket,
    pair,
    stop: async () => {
      await new Promise<void>((done) => {
        https.close(() => done());
        https.closeAllConnections();
      });
      await core.stop();
    },
  };
}

interface HandleContext {
  readonly context: {
    readonly origins: ReadonlySet<string>;
    readonly service: IdentityService;
    readonly hostId: string;
  };
  readonly delegate: import("node:http").Server;
  readonly webRoot: WebRoot;
  readonly log: CoreLog;
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "https://server").pathname;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: HandleContext,
): Promise<void> {
  const path = pathOf(request);
  const method = (request.method ?? "GET").toUpperCase();
  const refusal = gate(
    { method, path, headers: request.headers },
    options.context,
  );
  if (refusal !== undefined) {
    refuse(response, refusal);
    return;
  }
  if (path === "/health" || path === "/api" || path.startsWith("/api/")) {
    options.delegate.emit("request", request, response);
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { ...staticHeaders(), allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const file = await resolveFile(options.webRoot, request.url ?? "/");
    if (file === undefined) {
      response.writeHead(404, staticHeaders()).end();
      return;
    }
    sendFile(response, file, method);
  } catch (error) {
    options.log.error("静态产物读取失败", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    response.writeHead(500, staticHeaders()).end();
  }
}

function refuse(response: ServerResponse, refusal: Refusal): void {
  const payload = Buffer.from(JSON.stringify(refusal.body), "utf8");
  response.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function listen(
  server: Server,
  address: ListenAddress,
): Promise<ListenAddress> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(address.port, address.host, () => {
      const bound = server.address() as AddressInfo | null;
      if (bound === null) {
        failed(new Error("TLS 服务没有绑定到任何地址"));
        return;
      }
      server.removeListener("error", failed);
      done({ host: address.host, port: bound.port });
    });
  });
}
