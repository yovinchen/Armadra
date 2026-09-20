/**
 * 内存里那一份目录，和让它保持新鲜的那点机制。
 *
 * 一个对象而不是一堆模块级变量：两个读者（每个 Agent 的模型菜单、设置页的来源
 * 面板）都通过 {@link modelsDomain} 拿到同一个实例，测试则可以自己 new 一个、
 * 给一个假的 fetch 和一个假的时钟，一次网络都不发。
 *
 * 三件事写在这里而不是路由里：
 *
 *   * **抓取失败不改变目录。** 只有解析成功了才安装、才写缓存，所以一次坏答复
 *     不会顶掉一份好缓存。
 *   * **刷新有冷却**（{@link REFRESH_COOLDOWN_MS}）。冷却期内返回当前这份，不
 *     算失败：目录没变，只是没去问。
 *   * **同一时刻只有一次抓取在飞。** 冷却期外同时来的两个请求共用那一次。
 */

import {
  type Catalog,
  type CatalogFetch,
  FIRST_REFRESH_DELAY_MS,
  REFRESH_COOLDOWN_MS,
  REFRESH_INTERVAL_MS,
  CATALOG_URL,
  ageMs,
  cachePath,
  emptyCatalog,
  fetchCatalog,
  isStale,
  parse,
  readCache,
  writeCache,
} from "./catalog";

export interface CatalogServiceOptions {
  readonly dataDir: string;
  readonly fetch?: CatalogFetch;
  readonly now?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 目录换了以后要作废的缓存（每个 Agent 的模型菜单）。 */
  readonly onInstalled?: () => void;
}

/** 一次刷新之后交给调用方的东西。`error` 是这一次没成的原因。 */
export interface RefreshOutcome {
  readonly catalog: Catalog;
  readonly error?: string;
}

export class CatalogService {
  private catalog: Catalog = emptyCatalog();
  private lastRefreshMs: number | undefined;
  private inFlight: Promise<RefreshOutcome> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private armed = false;
  private readonly file: string;
  private readonly fetch: CatalogFetch;
  private readonly now: () => number;
  private readonly log: (
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  private readonly onInstalled: () => void;

  constructor(options: CatalogServiceOptions) {
    this.file = cachePath(options.dataDir);
    this.fetch = options.fetch ?? fetchCatalog;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.onInstalled = options.onInstalled ?? (() => {});
  }

  /** 现在这份目录。从不阻塞在网络上，也从不失败。 */
  current(): Catalog {
    return this.catalog;
  }

  /** 读缓存。装配时调用一次——只读盘，不联网。 */
  load(): void {
    const cached = readCache(this.file);
    if (cached === undefined) return;
    this.catalog = cached;
    this.onInstalled();
    this.log("加载了缓存的模型目录", {
      models: cached.models.length,
      fetchedAt: cached.fetchedAt ?? "unknown",
    });
  }

  /**
   * 武装后台刷新：{@link FIRST_REFRESH_DELAY_MS} 之后，如果那份数据过期就抓一
   * 次，之后一天一次。
   *
   * 惰性武装（第一次有人读目录时才调），理由和用量域那条一样：core 现在被大量
   * 集成测试反复拉起，一个每次装配都发网络请求的循环会让那些测试去下载没人看的
   * 东西。两个定时器都 `unref`，所以它们一秒也不会拖住进程退出。
   */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), REFRESH_INTERVAL_MS);
      this.timer.unref?.();
    }, FIRST_REFRESH_DELAY_MS);
    this.timer.unref?.();
  }

  /** 后台那一趟：只有过期了才去抓。 */
  private async tick(): Promise<void> {
    if (!isStale(this.catalog, this.now())) return;
    const outcome = await this.refresh({ force: true });
    if (outcome.error !== undefined) {
      this.log("没能刷新模型目录，继续用手上这份", { error: outcome.error });
    }
  }

  /** 停掉后台刷新。壳关掉 core 之前调，测试也用它。 */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.armed = false;
  }

  /**
   * 现在就抓一次。
   *
   * `force` 是后台那一趟用的（它自己已经判过过期了）；用户发起的那一次走冷却。
   */
  async refresh(options: { force?: boolean } = {}): Promise<RefreshOutcome> {
    if (this.inFlight !== undefined) return this.inFlight;
    const startedAt = this.now();
    if (
      options.force !== true &&
      this.lastRefreshMs !== undefined &&
      startedAt - this.lastRefreshMs < REFRESH_COOLDOWN_MS
    ) {
      return { catalog: this.catalog };
    }
    this.lastRefreshMs = startedAt;
    this.inFlight = this.fetchOnce(startedAt).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchOnce(startedAt: number): Promise<RefreshOutcome> {
    try {
      const document = await this.fetch(CATALOG_URL);
      const parsed = parse(document, new Date(startedAt).toISOString());
      try {
        writeCache(this.file, parsed);
      } catch (error) {
        // 数据目录不可写损失的是缓存，不是目录本身。
        this.log("没能缓存模型目录", { error: describe(error) });
      }
      this.catalog = parsed;
      this.onInstalled();
      this.log("刷新了模型目录", { models: parsed.models.length });
      return { catalog: parsed };
    } catch (error) {
      // 抓不到不是一次失败的请求：手上这份目录照常回答，页面要看见的是**它**
      // 外加一行没更新成的原因。
      return { catalog: this.catalog, error: describe(error) };
    }
  }

  /** 数据的年龄，整小时。页面据此说「3 小时前更新」，不用和 core 对表。 */
  ageHours(): number | undefined {
    const age = ageMs(this.catalog, this.now());
    return age === undefined ? undefined : Math.floor(age / 3_600_000);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
