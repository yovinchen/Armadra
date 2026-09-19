/**
 * `github_config` / `github_status_mappings` / `github_references` 三张表的读写。
 * 移植自 `apps/host/internal/storage/github.go`。
 *
 * **令牌永远不在这里**。`GithubConfig` 记来源、密钥存储种类以及那个存储里持有
 * 值的引用名；读凭据本身永远回到 OS 存储。
 *
 * 三张表都用显式 revision CAS：0 表示「还没有这一行」，其他值必须和调用方读到的
 * 那个相等。这不是乐观锁的装饰——两台设备同时改一个仓库的分组配置时，第二台必须
 * 在碰到远端之前就被拒。
 */

import type { DatabaseSync } from "node:sqlite";

import { githubError } from "./errors";

export const GITHUB_SOURCE_NONE = "none";
export const GITHUB_SOURCE_GH_CLI = "gh_cli";
export const GITHUB_SOURCE_TOKEN_REF = "token_ref";

export const GITHUB_STORE_NONE = "none";
export const GITHUB_STORE_OS_KEYCHAIN = "os_keychain";
export const GITHUB_STORE_FILE_FALLBACK = "file_fallback";

export const GITHUB_REFERENCE_ISSUE = 1;
export const GITHUB_REFERENCE_PULL = 2;

export const GITHUB_TARGET_SESSION = 1;
export const GITHUB_TARGET_BRANCH = 2;
export const GITHUB_TARGET_WORKTREE = 3;

export const MAX_GITHUB_MAPPING_BYTES = 256 << 10;
const MAX_PAGE_SIZE = 500;

/** 单例的凭据与 API base 选择。 */
export interface GithubConfig {
  readonly source: string;
  readonly apiBase: string;
  readonly secretStore: string;
  readonly secretRef: string;
  readonly accountLogin: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * 一个 API base 上的一个仓库。base 是键的一部分，所以企业版仓库和碰巧同名的
 * 公有仓库永远不是同一条记录。
 */
export interface GithubRepositoryKey {
  readonly owner: string;
  readonly name: string;
  readonly apiBase: string;
  readonly webHost: string;
}

export interface GithubStatusMappingRecord {
  readonly workspaceId: string;
  readonly repository: GithubRepositoryKey;
  readonly mapping: Uint8Array;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface GithubReferenceRecord {
  readonly referenceId: string;
  readonly workspaceId: string;
  readonly repository: GithubRepositoryKey;
  readonly kind: number;
  readonly number: number;
  readonly targetKind: number;
  readonly targetId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

function textValid(value: string, max: number, allowEmpty: boolean): boolean {
  if (typeof value !== "string") return false;
  if (value === "") return allowEmpty;
  if (Buffer.byteLength(value, "utf8") > max) return false;
  // 控制字符那一条不是洁癖：这些值会进日志、进 protobuf、进 SQL 的 CHECK，
  // 一个换行或者 DEL 在其中任何一处都是一次注入的入口。
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validateKey(key: GithubRepositoryKey): void {
  if (
    !textValid(key.owner, 256, false) ||
    !textValid(key.name, 256, false) ||
    !textValid(key.apiBase, 2048, false) ||
    !textValid(key.webHost, 256, false)
  ) {
    throw githubError("invalid");
  }
}

function validateConfig(config: GithubConfig): void {
  if (
    ![GITHUB_SOURCE_NONE, GITHUB_SOURCE_GH_CLI, GITHUB_SOURCE_TOKEN_REF].includes(
      config.source,
    )
  ) {
    throw githubError("invalid");
  }
  if (
    ![
      GITHUB_STORE_NONE,
      GITHUB_STORE_OS_KEYCHAIN,
      GITHUB_STORE_FILE_FALLBACK,
    ].includes(config.secretStore)
  ) {
    throw githubError("invalid");
  }
  // 只有粘进来的令牌才由密钥存储持有；gh CLI 那一支在静态存储里什么都不留，
  // 所以那里出现一个引用名等于描述了一件不存在的事。
  if ((config.source === GITHUB_SOURCE_TOKEN_REF) !== (config.secretRef !== "")) {
    throw githubError("invalid");
  }
  if (
    config.source !== GITHUB_SOURCE_TOKEN_REF &&
    config.secretStore !== GITHUB_STORE_NONE
  ) {
    throw githubError("invalid");
  }
  if (
    !textValid(config.apiBase, 2048, false) ||
    !textValid(config.secretRef, 256, true) ||
    !textValid(config.accountLogin, 256, true)
  ) {
    throw githubError("invalid");
  }
  if (config.createdAtMs <= 0 || config.updatedAtMs <= 0) {
    throw githubError("invalid");
  }
}

function validateReference(record: GithubReferenceRecord): void {
  if (
    !textValid(record.referenceId, 256, false) ||
    !textValid(record.workspaceId, 256, false)
  ) {
    throw githubError("invalid");
  }
  if (
    record.kind !== GITHUB_REFERENCE_ISSUE &&
    record.kind !== GITHUB_REFERENCE_PULL
  ) {
    throw githubError("invalid");
  }
  if (
    record.targetKind < GITHUB_TARGET_SESSION ||
    record.targetKind > GITHUB_TARGET_WORKTREE
  ) {
    throw githubError("invalid");
  }
  if (
    record.number <= 0 ||
    !textValid(record.targetId, 512, false) ||
    !textValid(record.title, 1024, true)
  ) {
    throw githubError("invalid");
  }
}

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" ? value : 0;
}

export class GithubStore {
  constructor(private readonly database: DatabaseSync) {}

  /* -------------------------------- 配置 ---------------------------------- */

  config(): GithubConfig | undefined {
    const row = this.database
      .prepare(
        "SELECT source, api_base, secret_store, secret_ref, account_login, revision, created_at_ms, updated_at_ms FROM github_config WHERE singleton = 1",
      )
      .get() as Row | undefined;
    if (row === undefined) return undefined;
    const revision = integer(row, "revision");
    if (revision < 1) throw githubError("corrupt");
    const config: GithubConfig = {
      source: text(row, "source"),
      apiBase: text(row, "api_base"),
      secretStore: text(row, "secret_store"),
      secretRef: text(row, "secret_ref"),
      accountLogin: text(row, "account_login"),
      revision,
      createdAtMs: integer(row, "created_at_ms"),
      updatedAtMs: integer(row, "updated_at_ms"),
    };
    try {
      validateConfig(config);
    } catch {
      throw githubError("corrupt");
    }
    return config;
  }

  /**
   * 按显式 revision CAS 替换单例。0 表示「还没配过」，其他值必须和调用方读到的
   * 那个相等。
   */
  putConfig(record: GithubConfig, expectedRevision: number): GithubConfig {
    validateConfig(record);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.config();
      if (existing === undefined) {
        if (expectedRevision !== 0) throw githubError("conflict");
        this.database
          .prepare(
            "INSERT INTO github_config(singleton, source, api_base, secret_store, secret_ref, account_login, revision, created_at_ms, updated_at_ms) VALUES(1, ?, ?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            record.source,
            record.apiBase,
            record.secretStore,
            record.secretRef,
            record.accountLogin,
            record.createdAtMs,
            record.updatedAtMs,
          );
        this.database.exec("COMMIT");
        return { ...record, revision: 1 };
      }
      if (existing.revision !== expectedRevision) throw githubError("conflict");
      const next = expectedRevision + 1;
      const result = this.database
        .prepare(
          "UPDATE github_config SET source = ?, api_base = ?, secret_store = ?, secret_ref = ?, account_login = ?, revision = ?, updated_at_ms = ? WHERE singleton = 1 AND revision = ?",
        )
        .run(
          record.source,
          record.apiBase,
          record.secretStore,
          record.secretRef,
          record.accountLogin,
          next,
          record.updatedAtMs,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) throw githubError("conflict");
      this.database.exec("COMMIT");
      return { ...record, revision: next, createdAtMs: existing.createdAtMs };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /* -------------------------------- 映射 ---------------------------------- */

  statusMapping(
    workspaceId: string,
    repository: GithubRepositoryKey,
  ): GithubStatusMappingRecord | undefined {
    if (!textValid(workspaceId, 256, false)) throw githubError("invalid");
    validateKey(repository);
    const row = this.database
      .prepare(
        "SELECT workspace_id, api_base, owner, name, web_host, mapping, revision, created_at_ms, updated_at_ms FROM github_status_mappings WHERE workspace_id = ? AND api_base = ? AND owner = ? AND name = ?",
      )
      .get(
        workspaceId,
        repository.apiBase,
        repository.owner,
        repository.name,
      ) as Row | undefined;
    if (row === undefined) return undefined;
    const revision = integer(row, "revision");
    if (revision < 1) throw githubError("corrupt");
    const mapping = row.mapping;
    return {
      workspaceId: text(row, "workspace_id"),
      repository: {
        apiBase: text(row, "api_base"),
        owner: text(row, "owner"),
        name: text(row, "name"),
        webHost: text(row, "web_host"),
      },
      mapping:
        mapping instanceof Uint8Array ? mapping : new Uint8Array(0),
      revision,
      createdAtMs: integer(row, "created_at_ms"),
      updatedAtMs: integer(row, "updated_at_ms"),
    };
  }

  /**
   * 按 revision CAS 存一个仓库的映射。`mapping` 的字节在这里是不透明的——验证
   * 配置好的分组不构成环是 GitHub 服务的活儿，在调用这里之前做。
   */
  putStatusMapping(
    record: GithubStatusMappingRecord,
    expectedRevision: number,
  ): GithubStatusMappingRecord {
    if (
      !textValid(record.workspaceId, 256, false) ||
      record.mapping.byteLength === 0 ||
      record.mapping.byteLength > MAX_GITHUB_MAPPING_BYTES ||
      record.createdAtMs <= 0 ||
      record.updatedAtMs <= 0
    ) {
      throw githubError("invalid");
    }
    validateKey(record.repository);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.statusMapping(record.workspaceId, record.repository);
      if (existing === undefined) {
        if (expectedRevision !== 0) throw githubError("conflict");
        this.database
          .prepare(
            "INSERT INTO github_status_mappings(workspace_id, api_base, owner, name, web_host, mapping, revision, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            record.workspaceId,
            record.repository.apiBase,
            record.repository.owner,
            record.repository.name,
            record.repository.webHost,
            record.mapping,
            record.createdAtMs,
            record.updatedAtMs,
          );
        this.database.exec("COMMIT");
        return { ...record, revision: 1 };
      }
      if (existing.revision !== expectedRevision) throw githubError("conflict");
      const next = expectedRevision + 1;
      const result = this.database
        .prepare(
          "UPDATE github_status_mappings SET web_host = ?, mapping = ?, revision = ?, updated_at_ms = ? WHERE workspace_id = ? AND api_base = ? AND owner = ? AND name = ? AND revision = ?",
        )
        .run(
          record.repository.webHost,
          record.mapping,
          next,
          record.updatedAtMs,
          record.workspaceId,
          record.repository.apiBase,
          record.repository.owner,
          record.repository.name,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) throw githubError("conflict");
      this.database.exec("COMMIT");
      return { ...record, revision: next, createdAtMs: existing.createdAtMs };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /* -------------------------------- 连接 ---------------------------------- */

  /**
   * 按 revision CAS 建立或更新一条连接。
   *
   * 一条连接永远不会跨工作空间或跨仓库移动：把一个徽标指向另一个远端对象是**一条
   * 新连接**，不是对这一条的编辑。
   */
  putReference(
    record: GithubReferenceRecord,
    expectedRevision: number,
  ): GithubReferenceRecord {
    validateReference(record);
    validateKey(record.repository);
    if (record.createdAtMs <= 0 || record.updatedAtMs <= 0) {
      throw githubError("invalid");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.reference(record.referenceId);
      if (existing === undefined) {
        if (expectedRevision !== 0) throw githubError("conflict");
        this.database
          .prepare(
            "INSERT INTO github_references(reference_id, workspace_id, api_base, owner, name, web_host, kind, number, target_kind, target_id, title, revision, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            record.referenceId,
            record.workspaceId,
            record.repository.apiBase,
            record.repository.owner,
            record.repository.name,
            record.repository.webHost,
            record.kind,
            record.number,
            record.targetKind,
            record.targetId,
            record.title,
            record.createdAtMs,
            record.updatedAtMs,
          );
        this.database.exec("COMMIT");
        return { ...record, revision: 1 };
      }
      if (existing.revision !== expectedRevision) throw githubError("conflict");
      if (
        existing.workspaceId !== record.workspaceId ||
        existing.repository.apiBase !== record.repository.apiBase ||
        existing.repository.owner !== record.repository.owner ||
        existing.repository.name !== record.repository.name ||
        existing.kind !== record.kind ||
        existing.number !== record.number
      ) {
        throw githubError("conflict");
      }
      const next = expectedRevision + 1;
      const result = this.database
        .prepare(
          "UPDATE github_references SET target_kind = ?, target_id = ?, title = ?, revision = ?, updated_at_ms = ? WHERE reference_id = ? AND revision = ?",
        )
        .run(
          record.targetKind,
          record.targetId,
          record.title,
          next,
          record.updatedAtMs,
          record.referenceId,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) throw githubError("conflict");
      this.database.exec("COMMIT");
      return { ...record, revision: next, createdAtMs: existing.createdAtMs };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reference(referenceId: string): GithubReferenceRecord | undefined {
    const row = this.database
      .prepare(`${REFERENCE_COLUMNS} WHERE reference_id = ?`)
      .get(referenceId) as Row | undefined;
    return row === undefined ? undefined : toReferenceRecord(row);
  }

  /**
   * 删掉一条连接。取消连接既不碰远端的 Issue / PR，也不碰它指向的本地会话。
   */
  deleteReference(
    workspaceId: string,
    referenceId: string,
    expectedRevision: number,
  ): void {
    if (
      !textValid(workspaceId, 256, false) ||
      !textValid(referenceId, 256, false) ||
      expectedRevision === 0
    ) {
      throw githubError("invalid");
    }
    const result = this.database
      .prepare(
        "DELETE FROM github_references WHERE reference_id = ? AND workspace_id = ? AND revision = ?",
      )
      .run(referenceId, workspaceId, expectedRevision);
    if (Number(result.changes) !== 1) throw githubError("conflict");
  }

  /**
   * 列一个工作空间的连接，可以只看一个目标。空目标列整个工作空间；它从来不是一次
   * 隐式匹配。
   */
  references(
    workspaceId: string,
    targetId: string,
    afterId: string,
    limit: number,
  ): GithubReferenceRecord[] {
    if (limit <= 0 || limit > MAX_PAGE_SIZE) throw githubError("invalid");
    if (
      !textValid(workspaceId, 256, false) ||
      !textValid(targetId, 512, true) ||
      !textValid(afterId, 256, true)
    ) {
      throw githubError("invalid");
    }
    const rows = this.database
      .prepare(
        `${REFERENCE_COLUMNS} WHERE workspace_id = ? AND reference_id > ? AND (? = '' OR target_id = ?) ORDER BY reference_id LIMIT ?`,
      )
      .all(workspaceId, afterId, targetId, targetId, limit) as Row[];
    return rows.map(toReferenceRecord);
  }
}

const REFERENCE_COLUMNS =
  "SELECT reference_id, workspace_id, api_base, owner, name, web_host, kind, number, target_kind, target_id, title, revision, created_at_ms, updated_at_ms FROM github_references";

function toReferenceRecord(row: Row): GithubReferenceRecord {
  const revision = integer(row, "revision");
  if (revision < 1) throw githubError("corrupt");
  const record: GithubReferenceRecord = {
    referenceId: text(row, "reference_id"),
    workspaceId: text(row, "workspace_id"),
    repository: {
      apiBase: text(row, "api_base"),
      owner: text(row, "owner"),
      name: text(row, "name"),
      webHost: text(row, "web_host"),
    },
    kind: integer(row, "kind"),
    number: integer(row, "number"),
    targetKind: integer(row, "target_kind"),
    targetId: text(row, "target_id"),
    title: text(row, "title"),
    revision,
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
  };
  try {
    validateReference(record);
    validateKey(record.repository);
  } catch {
    throw githubError("corrupt");
  }
  return record;
}
