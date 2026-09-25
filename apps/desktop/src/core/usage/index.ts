/**
 * 用量域：九条 `/api/usage/*` 路由。
 *
 * R1b 先落了 `mini` 一条——托盘条每次启动都问它，而它绝不能挂住或者编一个数字。
 * 这一批补上其余八条：快照与手动刷新、本地成本扫描与它的刷新、以及 Copilot 的四条
 * 设备流。
 *
 * 三条规矩贯穿整个域，写在 `snapshot.ts` 的开头，这里只重复最容易在重写里走样的
 * 那一条：**失败带原因码，从不带消息**。一个只看到「取不到用量」的用户分不清一次
 * 过期的登录和一个代理问题。
 */

import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import type { UsageSnapshot } from "./snapshot";
import { UsageService } from "./service";
import { StatusService, statusSources } from "./status";
import { catalogPrices, modelsDomain } from "../models";

export { emptySnapshot, USAGE_PROVIDER_IDS } from "./snapshot";
export type {
  CredentialSource,
  ProviderUsage,
  UsageFailure,
  UsageSnapshot,
  UsageStatus,
  UsageWindow,
} from "./snapshot";
export { UsageService } from "./service";
export { StatusService, STATUS_PROVIDER_IDS, STATUS_SOURCES } from "./status";
export type { ProviderStatus, StatusIndicator } from "./status";
export { CopilotLogin } from "./copilot-login";
export type { AuthState, LoginProgress, LoginPrompt } from "./copilot-login";
export { SecretStore } from "./secret-store";
export type { SecretBackend } from "./secret-store";
export {
  BUILT_IN_PRICES,
  CostService,
  ScanState,
  costOf,
  emptySummary,
  priceFor,
  summarize,
  undated,
} from "./cost";
export type {
  CostSummary,
  ModelPrice,
  PriceLookup,
  PriceTable,
  TokenTotals,
} from "./cost";
export {
  claudeWindows,
  codexCliWindows,
  codexCredits,
  copilotWindows,
  durationLabel,
  clampPercent,
  selectCredential,
  tokenFromPayload,
} from "./providers";

export interface UsageDomain {
  readonly service: UsageService;
  stop(): void;
}

let assembled: UsageDomain | undefined;

export function usageDomain(): UsageDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): UsageDomain {
  const service = new UsageService({
    settings: settingsDomain()?.settings,
    dataDir: context.dataDir,
    // 目录域装在用量域**后面**，所以这里问的是「扫描那一刻」的那份目录，而不是
    // 装配这一刻的（那时候它还不存在）。
    catalogPrices: () => catalogPrices(modelsDomain()?.catalog.current()),
  });

  const { router } = context.server;

  // 缓存着的快照（plan §19）。只有百分比和重置时间：没有令牌、没有账号 id、没有
  // 套餐名。
  //
  // 后台循环在**第一次有人问**时才武装，而不是在装配时。Rust 那边是在 `main` 里
  // 无条件起的；这里改成惰性，理由是 core 现在被大量集成测试反复拉起，一个每次
  // 装配都去读钥匙串、发网络请求的循环会让那些测试花钱在没人看的数据上。语义没
  // 变：第一次取仍然在启动之后 10 秒，只是「启动」从「装配」挪到了「第一次读」。
  router.handle("GET", "/api/usage", () => {
    service.start();
    return { status: 200, body: service.snapshot() };
  });

  // 现在就取，最多 30 秒一次。两种情况都返回快照，所以调用方不必为节流分支。
  router.handle("POST", "/api/usage/refresh", async () => {
    service.start();
    return { status: 200, body: await service.refreshThrottled() };
  });

  // 缓存着的本地记录汇总。计数、模型 id 和日期；从不是一行记录文本。
  router.handle("GET", "/api/usage/cost", () => ({
    status: 200,
    body: service.cost.summary(),
  }));

  router.handle("POST", "/api/usage/cost/refresh", async () => ({
    status: 200,
    body: await service.cost.refreshManual(),
  }));

  // 登录标志、令牌在哪儿、以及待处理的设备流提示。从不是令牌或者 device code。
  router.handle("GET", "/api/usage/copilot", async () => ({
    status: 200,
    body: await service.copilot.state(),
  }));

  router.handle("POST", "/api/usage/copilot/login", async () => {
    try {
      return {
        status: 200,
        body: await service.copilot.begin(globalThis.fetch),
      };
    } catch (error) {
      // 规矩 3：上游细节被记录，不被返回。
      context.log.debug("Copilot 设备流启动失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 500,
        body: {
          code: "internal",
          message: "Could not start the GitHub sign-in",
        },
      };
    }
  });

  router.handle("POST", "/api/usage/copilot/poll", async () => {
    const result = await service.copilot.poll(globalThis.fetch);
    if (result.progress === "authorized") {
      // 一个新令牌该在下一次板子轮询时出现，而不是五分钟以后。
      void service.refresh();
    }
    // 线上是**扁平**的一条：`progress` 加上 `AuthState` 的字段，和 Rust 的
    // `#[serde(flatten)]` 一样。
    return {
      status: 200,
      body: { progress: result.progress, ...result.state },
    };
  });

  router.handle("POST", "/api/usage/copilot/logout", async () => {
    try {
      const state = await service.copilot.logout();
      void service.refresh();
      return { status: 200, body: state };
    } catch (error) {
      context.log.debug("Copilot 登出失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 500,
        body: {
          code: "internal",
          message: "Could not remove the stored GitHub token",
        },
      };
    }
  });

  // Provider 状态页（roadmap §3.9）。和用量一样惰性：第一次有人问才联网，
  // 开关关着就一个请求都不发，只回 `enabled: false`。
  const status = new StatusService({
    sources: statusSources(process.env.ARMADRA_STATUS_PAGE_BASE),
  });
  router.handle("GET", "/api/usage/status", async () => {
    const enabled =
      settingsDomain()?.settings.get("usage.statusPage") !== false;
    if (!enabled) {
      return { status: 200, body: { enabled: false, providers: [] } };
    }
    return {
      status: 200,
      body: { enabled: true, providers: await status.current() },
    };
  });

  assembled = { service, stop: () => service.stop() };
  return assembled;
}
