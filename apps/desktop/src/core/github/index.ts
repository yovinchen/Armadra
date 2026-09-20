/**
 * GitHub 域的装配。
 *
 * `/api/github/*` 挂上去，24 个动词。它是一条 raw 路由：这一面自己拥有编解码与
 * 认证，不走路由表那一层。
 *
 * **只在统一库迁移已经应用时装**。没过单向门的库里没有 `github_*` 表，这时候装上
 * 去，第一个请求会撞上一条「没有这张表」的 SQL 错误。不装，页面拿到 404——这正是
 * 「没有凭据服务」与「没配凭据」被分开的理由。
 */

import type { CoreContext } from "../main";
import {
  GITHUB_CAPABILITY,
  registerCapability,
} from "../schedule/capabilities";
import {
  IdentityService,
  IdentityStore,
  identityInstanceId,
} from "../identity";
import { CredentialService, openSecretStore } from "./credentials";
import { API_PREFIX, GITHUB_METHODS, GithubHttp } from "./http";
import { GithubService } from "./service";
import { GithubStore } from "./store";

export { GithubClient } from "./client";
export { CredentialService, openSecretStore, validToken } from "./credentials";
export { GithubError, githubError, githubFailure } from "./errors";
export { API_METHODS, API_PREFIX, GITHUB_METHODS, GithubHttp } from "./http";
export { checkMapping, validateMapping } from "./mapping";
export {
  belongsTo,
  normalizeApiBase,
  parseRemote,
  webHostFor,
  PUBLIC_API_BASE,
} from "./remote";
export { GithubService, referenceId } from "./service";
export { GithubStore } from "./store";
export type { Caller } from "./service";

export interface GithubDomain {
  readonly service: GithubService;
  readonly credentials: CredentialService;
}

let assembled: GithubDomain | undefined;

/** 正在跑的这一轮的 GitHub 域，给需要读一条连接的别的域。 */
export function githubDomain(): GithubDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): GithubDomain | undefined {
  if (!context.db.unified) {
    context.log.info("GitHub 域未装配：统一库迁移尚未应用");
    return undefined;
  }
  const store = new GithubStore(context.db.database);
  const credentials = new CredentialService({
    store,
    secrets: openSecretStore(context.dataDir),
    // 运维可以把第一次配置落到一个企业版 base 上；客户端不能。
    ...(process.env.ARMADRA_GITHUB_API_BASE === undefined
      ? {}
      : { defaultApiBase: process.env.ARMADRA_GITHUB_API_BASE }),
  });
  const identityStore = new IdentityStore(context.db.database);
  const service = new GithubService({
    store,
    credentials,
    hostId: identityStore.hostId(),
  });
  const http = new GithubHttp({
    service,
    // 身份服务是对着同一张库的无状态包装，所以这里建一个自己的实例，而不是让
    // 身份域多导出一个可变的全局句柄。
    identity: new IdentityService(identityStore, identityInstanceId()),
  });

  context.server.raw(API_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );
  // 面板先看 Hello 的能力表再决定要不要发请求，所以装配成功要报出去。
  registerCapability(GITHUB_CAPABILITY);
  context.log.info("GitHub 域已装配", { methods: GITHUB_METHODS.length });

  assembled = { service, credentials };
  return assembled;
}
