import type { AddressInfo } from "node:net";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { allowOrigins } from "../../desktop/src/core/http/cors";
import { DOMAINS, type RunningCore, run } from "../../desktop/src/core/main";
import { identityInstanceId } from "../../desktop/src/core/identity";
import { AccountsService } from "../../desktop/src/core/identity/accounts";
import type { AuthorizationSubject } from "../../desktop/src/core/identity/authorize";
import {
  type RequestIdentity,
  runAs,
} from "../../desktop/src/core/identity/gate";
import {
  IdentityService,
  type Principal,
} from "../../desktop/src/core/identity/service";
import { IdentityStore } from "../../desktop/src/core/identity/store";
import { canonicalOrigin } from "../../desktop/src/core/identity/origin";
import { allScopes } from "../../desktop/src/core/identity/scopes";
import type { CoreLog } from "../../desktop/src/core/platform";
import { type ListenAddress, loopbackHost } from "./cli";
import { type Admission, type Refusal, admit, impliedOrigin } from "./auth";
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
 * 没有 Go Host 时代那道代理层——那份东西存在的唯一理由是两个进程。
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
  /** 这台服务器有没有管理员（owner）了。没有时第一张配对票兑换出来的就是它。 */
  hasAdmin(): boolean;
  /**
   * 以管理员的名义签一张邀请，给运维在命令行上发链接用；页面上签的是同一种。
   * 链接落在页面根上的片段里（{@link invitationUrl}）。
   */
  invite(input: {
    role: string;
    targetGroupId?: string;
    targetWorkspaceId?: string;
  }): { invitationId: string; url: string; expiresAtMs: number };
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

/**
 * 邀请兑换页的入口：页面根上的 `#invite=<令牌>`。
 *
 * 和配对票同一条理由放在片段里：片段不上请求行，于是令牌不进任何访问日志，
 * 也不进 `Referer`。页面读到它就打开兑换对话框（起名、设口令），兑换走的是
 * `POST /api/identity/register`——身份域自己的匿名面，门在 `auth.ts` 里放行。
 */
export function invitationUrl(origin: string, token: string): string {
  return `${origin}/#invite=${token}`;
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

  const store = new IdentityStore(core.db.database);
  const service = new IdentityService(store, identityInstanceId());
  const accounts = new AccountsService({ store });
  const hostId = service.hostId();
  const hasAdmin = () => store.transaction((tx) => tx.owner() !== undefined);

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
      const admission = admit(
        {
          method: request.method ?? "GET",
          path: pathOf(request),
          headers: request.headers,
          upgrade: true,
        },
        context,
      );
      const refusal = admission.refusal;
      if (refusal !== undefined) {
        socket.write(
          `HTTP/1.1 ${refusal.status} ${refusal.body.code}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      // 升级在这个人的身份下进行：事件流的订阅判定与之后的复核都认它。
      runAs(requestIdentityOf(admission, context), () =>
        delegate.emit("upgrade", request, socket as Duplex, head),
      );
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

  const invite = (input: {
    role: string;
    targetGroupId?: string;
    targetWorkspaceId?: string;
  }): { invitationId: string; url: string; expiresAtMs: number } => {
    const owner = store.transaction((tx) => tx.owner());
    if (owner === undefined) {
      throw new Error("还没有管理员：先用配对链接成为第一个管理员");
    }
    const issued = accounts.issueInvitation(
      { principalId: owner.principalId, kind: "owner", scopes: allScopes() },
      input,
    );
    return {
      invitationId: issued.invitationId,
      url: invitationUrl(origin, issued.token),
      expiresAtMs: issued.expiresAtMs,
    };
  };

  log.info("Armadra 服务器壳已就绪", {
    origin,
    tls: tls.selfSigned ? "自签名" : tls.certFile,
    webRoot: webRoot.directory,
  });
  let pairingTicket: string | undefined;
  if (!hasAdmin()) {
    // 首个管理员：服务器上还没有 owner 时，第一张被兑换的配对票就铸出它，此后
    // 它在「设置 → 账号与共享」里管理成员、组与共享。
    log.info("这台服务器还没有管理员：打开下面的配对链接成为第一个管理员");
  }
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
    hasAdmin,
    invite,
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
  // 补在请求头上而不是只给门看：core 的身份域（`GET /api/identity/session`）
  // 与 CORS 也各自读 Origin，三处必须看到同一个来源。
  const implied = impliedOrigin(
    method,
    request.headers,
    options.context.origins,
  );
  if (implied !== undefined) request.headers.origin = implied;
  const admission = admit(
    { method, path, headers: request.headers },
    options.context,
  );
  if (admission.refusal !== undefined) {
    refuse(response, admission.refusal);
    return;
  }
  if (path === "/health" || path === "/api" || path.startsWith("/api/")) {
    // core 里的路由门与各域的判定按这个身份判（`core/identity/gate.ts`）。
    runAs(requestIdentityOf(admission, options.context), () =>
      options.delegate.emit("request", request, response),
    );
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

/**
 * 匿名面上的请求身份：一个什么授权都没有的成员。
 *
 * 不留空（留空 core 会当成本机 owner）：身份域自己的登录面不经路由门，而除它
 * 以外任何一处判定问到这个身份，答案都该是「不行」。
 */
const ANONYMOUS: RequestIdentity = {
  subject: { principalId: "", kind: "member", scopes: [] },
};

function subjectOf(principal: Principal): AuthorizationSubject {
  return {
    principalId: principal.principalId,
    kind: principal.role === "member" ? "member" : "owner",
    scopes: principal.scopes,
  };
}

function requestIdentityOf(
  admission: Admission,
  context: HandleContext["context"],
): RequestIdentity {
  const principal = admission.principal;
  if (principal === undefined) return ANONYMOUS;
  const accessToken = admission.accessToken ?? "";
  const origin = admission.origin ?? "";
  return {
    subject: subjectOf(principal),
    // 长连接的复核：会话还在就给出当前主体。访问密钥过期（页面会刷新出一把
    // 新的）也算失效——被关掉的 socket 由页面带着新 Cookie 重连，门在升级前。
    revalidate: () => {
      try {
        return subjectOf(
          context.service.authenticate({
            accessToken,
            hostId: context.hostId,
            origin,
          }),
        );
      } catch {
        return undefined;
      }
    },
  };
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
