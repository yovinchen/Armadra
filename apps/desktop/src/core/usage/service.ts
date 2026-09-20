/**
 * 缓存好的用量快照加上后台刷新。移植自 `apps/runtime/src/usage/mod.rs` 的
 * `UsageService`。
 */

import type { SettingsStore } from "../settings/store";
import { BUILT_IN_PRICES, CostService, type PriceTable } from "./cost";
import { CopilotLogin } from "./copilot-login";
import {
  CLAUDE_ID,
  CODEX_ID,
  COPILOT_ID,
  ProviderError,
  fetchClaude,
  fetchCodex,
  fetchCopilot,
  type Fetcher,
  type ProviderReport,
} from "./providers";
import { SecretStore } from "./secret-store";
import {
  emptySnapshot,
  USAGE_PROVIDER_IDS,
  type CredentialSource,
  type ProviderUsage,
  type UsageProviderId,
  type UsageSnapshot,
} from "./snapshot";

/** 第一次取在启动这么久之后跑——core 该先答得上板子加载，再去花一次网络往返。 */
export const FIRST_FETCH_DELAY_MS = 10_000;
/** 用户没选节奏时的后台刷新节奏，也是设置页强制的下限。 */
export const REFRESH_INTERVAL_MS = 5 * 60_000;
/** 后台循环多久醒一次去**看**配置的节奏。改节奏不该需要重启。 */
const TICK_INTERVAL_MS = 30_000;
/** `POST /api/usage/refresh` 是一次用户手势；30 秒一次足够，也挡住一个卡住的 UI。 */
export const MANUAL_REFRESH_COOLDOWN_MS = 30_000;

/** Copilot 令牌存在哪个 service 名下。 */
export const COPILOT_SECRET_SERVICE = "Armadra Copilot";

export interface UsageServiceOptions {
  readonly settings: SettingsStore | undefined;
  readonly dataDir: string;
  readonly fetch?: Fetcher;
  readonly now?: () => number;
  /**
   * models.dev 目录里那份价格，成本扫描的第二级回退（内置 → 目录 → 未定价）。
   *
   * 是个函数而不是一张表：目录会在后台被抓回来换掉，而成本扫描每五分钟跑一趟
   * ——下一趟就该用上新价格。不给就只有内置表，和以前一样。
   */
  readonly catalogPrices?: () => PriceTable;
}

export class UsageService {
  private snapshotValue: UsageSnapshot = emptySnapshot();
  private lastFetchMs: number | undefined;
  private refreshing: Promise<UsageSnapshot> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastBackgroundMs: number | undefined;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  readonly cost: CostService;
  readonly copilot: CopilotLogin;

  constructor(private readonly options: UsageServiceOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.cost = new CostService(() => this.costEnabled(), this.now, () =>
      options.catalogPrices === undefined
        ? BUILT_IN_PRICES
        : [BUILT_IN_PRICES, options.catalogPrices()],
    );
    this.copilot = new CopilotLogin(
      new SecretStore(COPILOT_SECRET_SERVICE, options.dataDir),
      this.now,
    );
  }

  private enabled(): boolean {
    return this.options.settings?.usageEnabled() ?? true;
  }

  private providerEnabled(id: string): boolean {
    return this.options.settings?.usageProviderEnabled(id) ?? true;
  }

  private costEnabled(): boolean {
    const value = this.options.settings?.get("usage.cost.enabled");
    return typeof value === "boolean" ? value : true;
  }

  private codexCliFallback(): boolean {
    const value = this.options.settings?.get("usage.codexCliFallback");
    return typeof value === "boolean" ? value : false;
  }

  /** `usage.refreshMinutes`，`0` 表示只手动。 */
  private refreshIntervalMs(): number | undefined {
    const value = this.options.settings?.get("usage.refreshMinutes");
    if (typeof value !== "number" || value <= 0) {
      return value === 0 ? undefined : REFRESH_INTERVAL_MS;
    }
    return value * 60_000;
  }

  /** 缓存着的快照。从不在网络上阻塞。 */
  snapshot(): UsageSnapshot {
    return this.enabled() ? this.snapshotValue : emptySnapshot();
  }

  /** 并发地取支持的供应商并替换缓存。 */
  async refresh(): Promise<UsageSnapshot> {
    // 在已有的那次刷新上排队，两个调用方共享同一次完成的取数。
    if (this.refreshing !== undefined) return this.refreshing;
    const running = this.refreshLocked();
    this.refreshing = running;
    try {
      return await running;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async refreshLocked(): Promise<UsageSnapshot> {
    if (!this.enabled()) {
      // 暂停查询不该覆盖一份真的快照，也不该为一件没做的事开始冷却。
      return emptySnapshot();
    }
    const nowMs = this.now();
    const results = await Promise.all([
      this.run(CLAUDE_ID, () => fetchClaude(this.fetcher, nowMs)),
      this.run(CODEX_ID, () =>
        fetchCodex(this.fetcher, this.codexCliFallback(), nowMs),
      ),
      this.run(COPILOT_ID, async () =>
        fetchCopilot(
          this.fetcher,
          await this.copilot.token(),
          this.copilot.backend(),
        ),
      ),
    ]);
    const snapshot: UsageSnapshot = {
      refreshAvailableAt: new Date(
        nowMs + MANUAL_REFRESH_COOLDOWN_MS,
      ).toISOString(),
      providers: results,
    };
    this.snapshotValue = snapshot;
    this.lastFetchMs = nowMs;
    return snapshot;
  }

  /**
   * 跑一个供应商，并把结果映射到线上形状。错误文本被记录、不被返回；看板拿到的是
   * 原因码。
   */
  private async run(
    id: UsageProviderId,
    fetchOne: () => Promise<{
      report: ProviderReport | undefined;
      source: CredentialSource;
    }>,
  ): Promise<ProviderUsage> {
    // 开关关掉的供应商被整个跳过：不读凭据、不发请求，它报 `unavailable`，和一个
    // 从没装过的 CLI 一模一样。
    if (!this.providerEnabled(id)) {
      return unavailable(id, "none");
    }
    try {
      const { report, source } = await fetchOne();
      if (report === undefined) {
        // 没有窗口意味着没有可用的凭据，所以来源按找到的样子报而不是被强制成
        // `none`：一个过期的钥匙串令牌仍然该说「钥匙串」。
        return unavailable(id, source);
      }
      // 光有余额也够渲染一张卡：一个有余额但没有活跃限流窗口的 Codex 账号是
      // `ok`，不是 `error`。
      if (report.windows.length === 0 && report.credits === undefined) {
        return errored(id, source, "no_windows");
      }
      return {
        id,
        status: "ok",
        credentialSource: source,
        windows: report.windows,
        ...(report.credits === undefined ? {} : { credits: report.credits }),
        ...(report.viaCli === true ? { viaCli: true } : {}),
        fetchedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      return errored(
        id,
        "none",
        error instanceof ProviderError ? error.reason : "provider_error",
      );
    }
  }

  /** `POST /api/usage/refresh`：除非我们刚做过，否则刷新。 */
  async refreshThrottled(): Promise<UsageSnapshot> {
    if (
      this.lastFetchMs !== undefined &&
      this.now() - this.lastFetchMs < MANUAL_REFRESH_COOLDOWN_MS
    ) {
      return this.snapshot();
    }
    return this.refresh();
  }

  /**
   * 启动之后 10 秒，然后按 `usage.refreshMinutes` 指的节奏。循环每 30 秒醒一次，所以
   * 改节奏——包括切成手动——不用重启就生效。
   */
  start(): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      const interval = this.refreshIntervalMs();
      if (
        interval !== undefined &&
        (this.lastBackgroundMs === undefined ||
          this.now() - this.lastBackgroundMs >= interval)
      ) {
        this.lastBackgroundMs = this.now();
        void this.refreshThrottled();
        void this.cost.refreshThrottled();
      }
      this.timer = setTimeout(tick, TICK_INTERVAL_MS);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, FIRST_FETCH_DELAY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function unavailable(
  id: UsageProviderId,
  credentialSource: CredentialSource,
): ProviderUsage {
  return {
    id,
    status: "unavailable",
    credentialSource,
    windows: [],
    fetchedAt: null,
  };
}

function errored(
  id: UsageProviderId,
  credentialSource: CredentialSource,
  reason: ProviderUsage["reason"],
): ProviderUsage {
  return {
    id,
    status: "error",
    ...(reason === undefined ? {} : { reason }),
    credentialSource,
    windows: [],
    fetchedAt: null,
  };
}

export { USAGE_PROVIDER_IDS };
