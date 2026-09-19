/**
 * GitHub 域的共享地基：授权、仓库引用的规范化、传输拒绝到域意义的翻译，以及
 * 存着的状态映射。移植自 `apps/host/internal/githubhost/service.go`。
 *
 * 这里没有任何东西会返回令牌。外部内容——Issue 正文、评论、diff——作为**给读者的
 * 材料**传输，永远不被赋予指令权限。
 */

import { createHash } from "node:crypto";

import {
  GithubRepositoryRefSchema,
  GithubStatusMappingSchema,
  GithubStatusSource,
  create,
  fromBinary,
  toBinary,
  type GithubReferenceKind,
  type GithubReferenceTargetKind,
  type GithubRepositoryRef,
  type GithubStatusMapping,
} from "@armadra/protocol";

import type { Scope } from "../identity/scopes";
import { permits, scope } from "../identity/scopes";
import type { GithubClient, RateLimit } from "./client";
import type { CredentialService } from "./credentials";
import { codeOf, githubError } from "./errors";
import { validName, webHostFor } from "./remote";
import type { GithubRepositoryKey, GithubStore } from "./store";

export const SCOPE_READ = "github:read";
export const SCOPE_WRITE = "github:write";

/**
 * 这个部署没有 webhook，所以客户端按 core 报出来的间隔轮询，而不是自己编一个。
 *
 * 30 s 是**请求刷新的下限**——面板按它节流一次用户发起的刷新。后台的 Issue / PR
 * 轮询是 60 s，全量对账是 2 min；那两个是客户端侧的节奏，core 只在这里告诉它
 * 下限是多少。
 */
export const POLL_INTERVAL_MS = 30_000;
/** 后台轮询的节奏，和全量对账的节奏。见 {@link POLL_INTERVAL_MS}。 */
export const BACKGROUND_POLL_INTERVAL_MS = 60_000;
export const RECONCILE_INTERVAL_MS = 120_000;

export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_PAGE = 1000;
export const MAX_COMMENTS = 100;
export const MAX_FILES = 300;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/** 核验过的会话。身份只来自会话本身；一次请求从不提供它。 */
export interface Caller {
  readonly principalId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly deviceEpoch: number;
  readonly scopes: readonly Scope[];
}

export interface GithubServiceOptions {
  readonly store: GithubStore;
  readonly credentials: CredentialService;
  readonly hostId: string;
  readonly now?: () => number;
}

export class GithubService {
  readonly store: GithubStore;
  readonly credentials: CredentialService;
  readonly hostId: string;
  readonly now: () => number;

  constructor(options: GithubServiceOptions) {
    if (options.hostId === "") throw githubError("invalid");
    this.store = options.store;
    this.credentials = options.credentials;
    this.hostId = options.hostId;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 检查这个核验过的会话自己在这个工作空间、这台执行主机上的授权。它从不把一个
   * 空的或者全局的请求放宽。
   */
  authorize(caller: Caller, permission: string): void {
    if (
      caller.principalId === "" ||
      caller.deviceId === "" ||
      caller.deviceEpoch <= 0 ||
      !ID_PATTERN.test(caller.workspaceId) ||
      caller.scopes.length === 0
    ) {
      throw githubError("permission");
    }
    if (
      !permits(caller.scopes, [
        scope(permission, caller.workspaceId, this.hostId),
      ])
    ) {
      throw githubError("permission");
    }
  }

  /**
   * 解析配置好的凭据。一台没有凭据的机器拒绝，而不是发一个匿名请求、悄悄只读到
   * 公开数据。
   */
  client(): GithubClient {
    return this.credentials.apiClient();
  }

  /**
   * 把一次传输拒绝映射到域层的意义，并记一次凭据失败，这样设置页可以说「这个
   * 令牌不再工作了」。
   */
  translate(error: unknown): Error {
    this.credentials.noteFailure(error);
    switch (codeOf(error)) {
      case "UNAUTHENTICATED":
        return githubError("unsupported");
      case "PERMISSION_DENIED":
        return githubError("permission");
      case "NOT_FOUND":
        return githubError("notFound");
      case "CONFLICT":
        return githubError("conflict");
      case "RESOURCE_EXHAUSTED":
        return githubError("rateLimited");
      case "UNKNOWN_OUTCOME":
        return githubError("unknownOutcome");
      case "INVALID_ARGUMENT":
      case "UNSUPPORTED":
        return githubError("invalid");
      default:
        return error instanceof Error ? error : githubError("internal");
    }
  }

  /**
   * 规范化并检查一次请求指名的引用。
   *
   * API base **永远来自这台机器的配置，从不来自请求**，所以客户端没法把一次调用
   * 重新指向另一个服务。
   */
  repository(ref: GithubRepositoryRef | undefined): GithubRepositoryRef {
    const client = this.client();
    if (
      ref === undefined ||
      !validName(ref.owner) ||
      !validName(ref.name)
    ) {
      throw githubError("invalid");
    }
    const base = client.apiBase();
    if (ref.apiBase !== "" && ref.apiBase !== base) throw githubError("invalid");
    const host = webHostFor(base);
    // 指名另一个 web 主机的引用会把这个仓库的名字送到错误的服务上去；它被拒绝
    // 而不是被改写。
    if (ref.host !== "" && ref.host !== host) throw githubError("invalid");
    return create(GithubRepositoryRefSchema, {
      owner: ref.owner,
      name: ref.name,
      apiBase: base,
      host,
    });
  }

  /**
   * 读一个仓库的配置。还没有配过的仓库返回一份 revision 为零的空 NONE 映射，而不是
   * 一个错误：「没配」是面板要展示的正常状态。
   */
  storedMapping(
    workspaceId: string,
    ref: GithubRepositoryRef,
  ): GithubStatusMapping {
    const record = this.store.statusMapping(workspaceId, key(ref));
    if (record === undefined) {
      return create(GithubStatusMappingSchema, {
        repository: ref,
        source: GithubStatusSource.NONE,
      });
    }
    let mapping: GithubStatusMapping;
    try {
      mapping = fromBinary(GithubStatusMappingSchema, record.mapping);
    } catch {
      throw githubError("corrupt");
    }
    mapping.repository = ref;
    mapping.revision = BigInt(record.revision);
    mapping.updatedAtUnixMs = BigInt(record.updatedAtMs);
    return mapping;
  }
}

export function key(ref: GithubRepositoryRef): GithubRepositoryKey {
  return {
    owner: ref.owner,
    name: ref.name,
    apiBase: ref.apiBase,
    webHost: ref.host,
  };
}

/** 把存下来的那份编成确定性的 protobuf 字节。 */
export function encodeMapping(mapping: GithubStatusMapping): Uint8Array {
  const stored = create(GithubStatusMappingSchema, {
    source: mapping.source,
    groups: mapping.groups,
    stateGroups: mapping.stateGroups,
    projectId: mapping.projectId,
    projectFieldId: mapping.projectFieldId,
  });
  // revision 和时间戳是存储来赋的；客户端在那两项里写了什么都丢掉，不作为事实
  // 持久化。
  return toBinary(GithubStatusMappingSchema, stored);
}

export function rateLimit(value: RateLimit): {
  $typeName: "armadra.v1.GithubRateLimit";
  limit: bigint;
  remaining: bigint;
  resetsAtUnixMs: bigint;
  throttled: boolean;
  retryAfterUnixMs: bigint;
} {
  return {
    $typeName: "armadra.v1.GithubRateLimit",
    limit: BigInt(value.limit),
    remaining: BigInt(value.remaining),
    resetsAtUnixMs: BigInt(value.resetsAtMs),
    throttled: value.throttled,
    retryAfterUnixMs: BigInt(value.retryAfterMs),
  };
}

/** 游标是页码，不是远端 URL。是 URL 的游标会让响应操纵下一次请求。 */
export function decodeCursor(value: string): number {
  if (value === "") return 1;
  const page = Number.parseInt(value, 10);
  if (!Number.isInteger(page) || page < 2 || page > MAX_CURSOR_PAGE) {
    throw githubError("invalid");
  }
  return page;
}

export function encodeCursor(page: number): string {
  return page < 2 || page > MAX_CURSOR_PAGE ? "" : String(page);
}

export function pageLimit(value: number): number {
  const limit = Number(value);
  return limit <= 0 || limit > MAX_PAGE_LIMIT ? 50 : limit;
}

/**
 * 标识由**这条连接的含义**导出，所以把同一个 Issue 连到同一个目标两次是同一条
 * 记录，而不是一个节点上的两个徽标。
 */
export function referenceId(
  workspaceId: string,
  ref: GithubRepositoryRef,
  kind: GithubReferenceKind,
  number: bigint,
  targetKind: GithubReferenceTargetKind,
  target: string,
): string {
  // 分隔符是 NUL 而不是别的可打印字符：目标标识可以合法地含空格或冒号，用那些
  // 分隔会让两组不同的字段拼出同一串材料，于是两条不同的连接得到同一个 id。
  const material = [
    workspaceId,
    ref.apiBase,
    `${ref.owner}/${ref.name}`,
    String(kind),
    String(number),
    String(targetKind),
    target,
  ].join("\u0000");
  return createHash("sha256")
    .update(material, "utf8")
    .digest("hex")
    .slice(0, 32);
}
