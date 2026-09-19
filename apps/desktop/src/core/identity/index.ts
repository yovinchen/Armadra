import type { CoreContext } from "../main";
import { instanceId } from "../instance";
import { startControlChannel } from "./control";
import { API_PREFIX, IdentityHttp, RPC_PREFIX } from "./http";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

export { IdentityService } from "./service";
export { IdentityStore } from "./store";
export { IdentityError } from "./errors";
export {
  API_PREFIX,
  BROWSER_SESSION_CAPABILITY,
  NATIVE_SESSION_CAPABILITY,
  RPC_METHODS,
  RPC_PREFIX,
} from "./http";
export { CONTROL_SOCKET, TICKET_PATH, controlSocketPath } from "./control";

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
      "身份域未装配：统一库迁移尚未应用（ARMADRA_CORE=ts 才应用）",
    );
    return;
  }
  const store = new IdentityStore(context.db.database);
  const service = new IdentityService(store, instanceId());
  const http = new IdentityHttp({ service, instanceId: instanceId() });

  context.server.raw(RPC_PREFIX, (request, response, cors) =>
    http.rpc(request, response, cors),
  );
  context.server.raw(API_PREFIX, (request, response, cors) =>
    http.api(request, response, cors),
  );

  // 私有通道是异步绑的，但装配是同步的：起不来不该拖住 core，壳会在取票时拿到
  // 一个明确的失败，而不是一个永远起不来的进程。
  void startControlChannel({
    service,
    instanceId: instanceId(),
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
