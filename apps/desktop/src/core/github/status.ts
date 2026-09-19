/**
 * `GetStatusMapping` / `PutStatusMapping` 两个动词。校验规则在 `mapping.ts`，
 * 存储在 `store.ts`；这里只做授权、规范化和 CAS 的拼接。
 */

import {
  GithubStatusMappingSchema,
  create,
  type GithubRepositoryRef,
  type GithubStatusMapping,
} from "@armadra/protocol";

import { githubError } from "./errors";
import { validateMapping } from "./mapping";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  encodeMapping,
  key,
  type Caller,
  type GithubService,
} from "./service";

/** 面板按它给 Issue 分组的那份配置。 */
export function getStatusMapping(
  service: GithubService,
  caller: Caller,
  ref: GithubRepositoryRef | undefined,
): GithubStatusMapping {
  service.authorize(caller, SCOPE_READ);
  const repository = service.repository(ref);
  return service.storedMapping(caller.workspaceId, repository);
}

/** 校验并在 revision CAS 下存一个仓库的配置。 */
export function putStatusMapping(
  service: GithubService,
  caller: Caller,
  mapping: GithubStatusMapping | undefined,
  expectedRevision: bigint,
): GithubStatusMapping {
  service.authorize(caller, SCOPE_WRITE);
  if (mapping === undefined) throw githubError("invalid");
  const repository = service.repository(mapping.repository);
  validateMapping(mapping);
  const now = service.now();
  const record = service.store.putStatusMapping(
    {
      workspaceId: caller.workspaceId,
      repository: key(repository),
      mapping: encodeMapping(mapping),
      revision: 0,
      createdAtMs: now,
      updatedAtMs: now,
    },
    Number(expectedRevision),
  );
  // 答案是客户端发来的那份，加上**存储赋的** revision 和时间戳——客户端在那两项
  // 里写的东西从不被当成事实回显。
  return create(GithubStatusMappingSchema, {
    repository,
    source: mapping.source,
    groups: mapping.groups,
    stateGroups: mapping.stateGroups,
    projectId: mapping.projectId,
    projectFieldId: mapping.projectFieldId,
    revision: BigInt(record.revision),
    updatedAtUnixMs: BigInt(record.updatedAtMs),
  });
}
