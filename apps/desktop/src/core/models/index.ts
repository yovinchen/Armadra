/**
 * 模型域：三条路由。
 *
 *   * `GET  /api/models/catalog` —— 内存里那份目录：从哪来、什么时候取的、覆盖
 *     多少个模型。**从不抓取**。
 *   * `POST /api/models/catalog/refresh` —— 现在就抓一次 models.dev，有冷却。
 *   * `GET  /api/agents/{agentId}/models` —— 那个 CLI 的模型菜单。
 *
 * 第三条的路径在 `/api/agents/` 下，但它属于这里：它回答的是「有哪些模型」，
 * 数据一半来自目录、一半来自 CLI 自己，和 Agent 域的注册表、集成状态不是一回
 * 事。Agent 域照常拥有 `/api/agents` 与集成那几条。
 *
 * **只有 core 碰网络。** 页面从不直接访问 models.dev——它在浏览器安装下也过不了
 * core 自己的 CORS 规矩。
 */

import { definition, validAgentId } from "../agent/registry";
import type { CoreContext } from "../main";
import { parseCustomAgents } from "../settings/custom-agents";
import { settingsDomain } from "../settings";
import { DomainError, notFound } from "../workspaces/support";
import type { HandlerResult } from "../http/router";
import { forgetMenus, menuFor } from "./agents";
import { BUILT_IN_PRICES } from "../usage/cost";
import type { ModelPrice, PriceTable } from "../usage/cost";
import type { Catalog, CatalogModel } from "./catalog";
import { CatalogService } from "./service";

export { CatalogService } from "./service";
export type { Catalog, CatalogModel } from "./catalog";
export type { AgentModel } from "./agents";

export interface ModelsDomain {
  readonly catalog: CatalogService;
  stop(): void;
}

let assembled: ModelsDomain | undefined;

/** 这次装配起来的目录服务，给别的域读一个模型的价格或者上下文上限。 */
export function modelsDomain(): ModelsDomain | undefined {
  return assembled;
}

/**
 * `GET /api/models/catalog` 的文档形状。
 *
 * `pricedModels` 是**现在就能算出价格**的模型数。目录里带价格的条目和内置表的
 * 条目合起来算一次去重——成本面板旁边那行字问的就是这个。
 */
export interface CatalogDocument {
  readonly source: Catalog["source"];
  readonly fetchedAt?: string;
  readonly url: string;
  readonly ageHours?: number;
  readonly pricedModels: number;
  readonly refreshError?: string;
  readonly models: readonly CatalogModel[];
}

export function catalogDocument(
  service: CatalogService,
  refreshError?: string,
): CatalogDocument {
  const catalog = service.current();
  const ageHours = service.ageHours();
  return {
    source: catalog.source,
    ...(catalog.fetchedAt === undefined
      ? {}
      : { fetchedAt: catalog.fetchedAt }),
    url: catalog.url,
    ...(ageHours === undefined ? {} : { ageHours }),
    pricedModels: pricedModels(catalog),
    ...(refreshError === undefined ? {} : { refreshError }),
    models: catalog.models,
  };
}

/**
 * 目录里带价格的那些条目，摆成成本扫描器认得的价目表。
 *
 * 只收四个数都在的条目（`usableCost` 已经保证了这一点），键按**原样**与小写
 * 各存一份：转录里写的模型 id 大小写不一定和目录一致，而 `priceFor` 是精确
 * 匹配——它不猜，所以这里替它把两种写法都摆出来。
 *
 * 单位不用换：目录和内置表都是「每百万 token 多少美元」。
 */
export function catalogPrices(catalog: Catalog | undefined): PriceTable {
  if (catalog === undefined) return {};
  const table: Record<string, ModelPrice> = {};
  for (const model of catalog.models) {
    if (model.cost === undefined) continue;
    const price: ModelPrice = {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    };
    table[model.modelId] = price;
    table[model.modelId.toLowerCase()] = price;
  }
  return table;
}

/** 内置价目表 ∪ 目录里带价格的条目，去重。 */
export function pricedModels(catalog: Catalog): number {
  const ids = new Set(
    Object.keys(BUILT_IN_PRICES).map((id) => id.toLowerCase()),
  );
  for (const model of catalog.models) {
    if (model.cost !== undefined) ids.add(model.modelId.toLowerCase());
  }
  return ids.size;
}

/**
 * 一个 agent id 要用哪个基础适配器、哪个启动程序问模型。
 *
 * 一个 `custom:` 条目借基础适配器的模型，但报的是它自己的启动程序。
 */
export function resolveAgent(agentId: string): {
  baseAgent: string;
  launchCmd: string;
} {
  const custom = parseCustomAgents(
    settingsDomain()?.settings.snapshot() ?? {},
  ).find((entry) => entry.id === agentId);
  if (custom !== undefined) {
    return { baseAgent: custom.baseAgent, launchCmd: custom.launchCmd };
  }
  const builtin = definition(agentId);
  if (builtin === undefined) {
    throw notFound(
      validAgentId(agentId)
        ? `设置里没有 Agent ${agentId}`
        : `不认识的 Agent ${agentId}`,
    );
  }
  return { baseAgent: builtin.id, launchCmd: builtin.launchCmd };
}

export function install(context: CoreContext): ModelsDomain {
  const catalog = new CatalogService({
    dataDir: context.dataDir,
    log: (message, fields) => context.log.info(message, fields ?? {}),
    // 菜单是按上一份目录拼的；刚要求更新的人不该再等满它的 TTL。
    onInstalled: forgetMenus,
  });
  // 只读盘。网络那一趟等到第一次有人读目录才武装。
  catalog.load();

  const { router } = context.server;

  router.handle("GET", "/api/models/catalog", () => {
    catalog.arm();
    return { status: 200, body: catalogDocument(catalog) };
  });

  // 抓不到 models.dev 不是一次失败的请求：手上那份目录还在回答，页面要看见的是
  // 它、外加一行没更新成的原因。一个错误状态码会用「什么都没有」顶掉一份能用的
  // 文档。
  router.handle("POST", "/api/models/catalog/refresh", async () => {
    catalog.arm();
    const outcome = await catalog.refresh();
    return { status: 200, body: catalogDocument(catalog, outcome.error) };
  });

  router.handle(
    "GET",
    "/api/agents/{agentId}/models",
    async (match): Promise<HandlerResult> => {
      try {
        const { baseAgent, launchCmd } = resolveAgent(
          match.params.agentId ?? "",
        );
        return {
          status: 200,
          body: await menuFor({
            baseAgent,
            launchCmd,
            catalog: catalog.current(),
          }),
        };
      } catch (error) {
        if (error instanceof DomainError) {
          const { status, body } = error.response();
          return { status, body };
        }
        throw error;
      }
    },
  );

  assembled = {
    catalog,
    stop: () => catalog.stop(),
  };
  return assembled;
}
