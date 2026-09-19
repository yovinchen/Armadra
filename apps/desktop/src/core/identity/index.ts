import type { CoreContext } from "../main";
import { instanceId } from "../instance";
import { coreCapabilities } from "../schedule/capabilities";
import { AccountsService } from "./accounts";
import { installAuditSink } from "./audit";
import { Authorizer } from "./authorize";
import { startControlChannel } from "./control";
import { installAccessGate } from "./gate";
import { API_PREFIX, IdentityHttp } from "./http";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

export { IdentityService } from "./service";
export { IdentityStore } from "./store";
export { IdentityError } from "./errors";
export { AccountsService } from "./accounts";
export { Authorizer, compileGrants, permitsSubject } from "./authorize";
export type { AuthorizationSubject } from "./authorize";
export { audit, installAuditSink, resetAuditSink } from "./audit";
export type { AuditEvent } from "./audit";
export {
  OWNER_GATE,
  accessGate,
  allows,
  installAccessGate,
  resetAccessGate,
} from "./gate";
export type { AccessGate } from "./gate";
export { SHARE_ROLES, rolePermissions, roleScopes } from "./roles";
export type { ShareRole } from "./roles";
export {
  API_PREFIX,
  BROWSER_SESSION_CAPABILITY,
  NATIVE_SESSION_CAPABILITY,
} from "./http";
export { CONTROL_SOCKET, TICKET_PATH, controlSocketPath } from "./control";

/**
 * 这一轮 core 的实例标识，按身份域的拼法：32 位十六进制。
 *
 * `instanceId()` 是带连字符的 UUID，`/health` 与 `endpoints.json` 用的就是它，
 * 壳按那一行对账，所以它不能改。身份域这边继承的是 Go Host 的形状——票据、
 * 会话、以及 `packages/host-client` 校验 `hostInstanceId` 的那条正则，全都要
 * 32 位十六进制。去掉连字符正好是同一串字节的另一种写法，两边说的是同一次运行。
 */
export function identityInstanceId(): string {
  return instanceId().replace(/-/g, "");
}

/**
 * 身份域的装配。
 *
 * 三样东西挂上去：新面 `/api/identity/*`、兼容面 `/rpc/armadra.v1.*`、以及数据
 * 目录下那个 0600 的私有通道（签票的唯一入口）。
 *
 * **只在统一库迁移已经应用时装**。没过单向门的库里没有身份表，这时候装上去，
 * 第一个请求会撞上一条「没有这张表」的 SQL 错误；不装，路由继续按路由表回
 * 501，页面据此退化——这正是 501 存在的理由。
 */
export function installIdentity(context: CoreContext): void {
  if (!context.db.unified) {
    context.log.info(
      "身份域未装配：统一库迁移尚未应用",
    );
    return;
  }
  const runInstance = identityInstanceId();
  const store = new IdentityStore(context.db.database);
  const service = new IdentityService(store, runInstance);
  // Hello 报的能力名里多出的那些来自各域自己的注册表（`core/schedule/capabilities`）。
  // 身份域不该知道有哪些域存在，所以这里只转发；自动化面板认的
  // `automation.plans.v1` 就是这样传到页面的。
  const accounts = new AccountsService({ store });
  const http = new IdentityHttp({
    service,
    accounts,
    instanceId: runInstance,
    capabilities: coreCapabilities,
  });

  // 判定入口与审计写入点（设计 §4）。装上之后它们仍然对 owner 恒真、对每条
  // 动作各写一条——真正变了的只有「问的是库，而不是那个恒真的兜底实现」。
  const authorizer = new Authorizer(store);
  installAccessGate({
    // 域路由今天还不携带会话（服务器壳才会让匿名请求成为可能），所以主体恒为
    // 本机 owner，授权是配对时签给壳的那一份。
    subject: () => ({ principalId: "", kind: "owner", scopes: allScopes() }),
    permits: (subject, required) => authorizer.permits(subject, required),
  });
  installAuditSink((event) => {
    store.transaction((tx) => {
      tx.accounts.appendAudit({
        atMs: Date.now(),
        principalId: event.principalId ?? "",
        deviceId: event.deviceId ?? "",
        action: event.action,
        target: (event.target ?? "").slice(0, 256),
        workspaceId: (event.workspaceId ?? "").slice(0, 256),
        detailJson:
          event.detail === undefined
            ? ""
            : JSON.stringify(event.detail).slice(0, 8192),
      });
    });
  });

  context.server.raw(API_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );

  // 私有通道是异步绑的，但装配是同步的：起不来不该拖住 core，壳会在取票时拿到
  // 一个明确的失败，而不是一个永远起不来的进程。
  void startControlChannel({
    service,
    instanceId: runInstance,
    dataDir: context.dataDir,
    log: context.log,
  })
    .then((channel) => {
      if (channel !== undefined) {
        context.log.info("身份私有通道已就绪", { spec: channel.spec });
      }
    })
    .catch((error: unknown) => {
      context.log.warn("身份私有通道未能绑定；本次无法取票", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
