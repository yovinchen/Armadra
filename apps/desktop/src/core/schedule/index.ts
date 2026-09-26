import { collab } from "../agent";
import type { CoreContext } from "../main";
import { identityInstanceId } from "../identity";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { AutomationApi, API_PREFIX } from "./api";
import { AUTOMATION_CAPABILITY, registerCapability } from "./capabilities";
import { TerminalDispatcher, type DispatchContext } from "./dispatch";
import { ScheduleEngine } from "./engine";
import { ScheduleService } from "./service";
import { ScheduleStore } from "./store";

/**
 * 定时与自动化域的装配。
 *
 * 挂两样东西：`/api/automations/*`，以及那个**属于 core 生命周期**的调度
 * 循环——它不属于任何一次请求，页面关掉之后计划照跑。
 *
 * **只在统一库迁移已经应用时装**。没过 0017 的库里没有自动化的表，这时候装上去
 * 第一个请求会撞上一条「没有这张表」的 SQL 错误；不装，这一面根本不在，而
 * `Hello` 的能力表里也没有 `automation.plans.v1`，页面据此退化成「这台 core 不
 * 支持自动化」——那正是它给这种情况准备的那条路。
 *
 * 装配顺序上它必须排在终端域**之后**：投递要往 pane 里写，而那个桥是终端域装好
 * 之后才有的。
 */

export { API_PREFIX } from "./api";
export { ScheduleEngine } from "./engine";
export { ScheduleService } from "./service";
export { ScheduleStore } from "./store";
export { TerminalDispatcher } from "./dispatch";
export {
  AUTOMATION_CAPABILITY,
  coreCapabilities,
  registerCapability,
} from "./capabilities";

export interface ScheduleDomain {
  readonly engine: ScheduleEngine;
  readonly service: ScheduleService;
  stop(): void;
}

let assembled: ScheduleDomain | undefined;

/** 运行中的调度域，给要观察它的用例与后续域。 */
export function scheduleDomain(): ScheduleDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): ScheduleDomain | undefined {
  if (!context.db.unified) {
    context.log.info("定时与自动化域未装配：统一库迁移尚未应用");
    return undefined;
  }
  if (!tablesReady(context)) {
    context.log.info("定时与自动化域未装配：0017 迁移尚未应用");
    return undefined;
  }
  const store = new ScheduleStore(context.db.database);
  const identityStore = new IdentityStore(context.db.database);
  const identity = new IdentityService(identityStore, identityInstanceId());
  const hostId = identityStore.hostId();

  // 桥每次现取：终端域装在这之后把它交给协作域，而协作域重建上下文时那个对象
  // 是新的。存一份下来就会一直对着旧的写。
  const dispatchContext: DispatchContext = {
    database: context.db.database,
    store,
    hostId,
    terminals: () => collab()?.terminals,
    // 冷启动（自动化设计 §4.2）：程序名按协作域那份注册表解析，写回节点之后
    // 经同一条事件流告诉页面重读画布。启动器本身由终端域经接缝交回。
    settings: () => collab()?.settings,
    publish: () => collab()?.publish,
    dataDir: context.dataDir,
  };
  const dispatcher = new TerminalDispatcher(dispatchContext);
  // 内核要一个授权方，而授权方是服务层——两者互相需要，所以先留一个转发。
  // 转发而不是把两者合成一个类：内核不该看得见 HTTP 面，服务层不该看得见槽位。
  const authority: { service?: ScheduleService } = {};
  const engine = new ScheduleEngine({
    store,
    dispatcher,
    authorizer: {
      verify: async (authorization, config) => {
        const target = authority.service;
        if (target === undefined) throw new Error("调度域还没有装配完");
        await target.verify(authorization, config);
      },
    },
    hostId,
  });
  const service = new ScheduleService({
    store,
    engine,
    identity: identityStore,
    hostId,
    generationOf: (sessionId) =>
      dispatchContext.terminals()?.generation(sessionId),
  });

  authority.service = service;

  const api = new AutomationApi({ service, identity });
  context.server.raw(API_PREFIX, (request, response, cors) =>
    api.handle(request, response, cors),
  );

  engine.start();
  const unregister = registerCapability(AUTOMATION_CAPABILITY);
  assembled = {
    engine,
    service,
    stop: () => {
      engine.stop();
      unregister();
      assembled = undefined;
    },
  };
  context.log.info("定时与自动化域已装配", { hostId });
  return assembled;
}

function tablesReady(context: CoreContext): boolean {
  try {
    const row = context.db.database
      .prepare(
        "SELECT count(*) AS total FROM sqlite_schema WHERE type = 'table' " +
          "AND name IN ('automation_plans', 'automation_runs', 'automation_gates')",
      )
      .get() as { total?: unknown } | undefined;
    return Number(row?.total ?? 0) === 3;
  } catch {
    return false;
  }
}
