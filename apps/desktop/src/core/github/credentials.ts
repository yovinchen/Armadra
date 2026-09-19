/**
 * GitHub API 凭据服务。移植自 `apps/host/internal/githubcred/`。
 *
 * 它和 Worker 的 git 凭据处理是**两件事**：SSH 密钥和 git credential helper 属于
 * 执行主机，而 API 令牌属于这台机器。
 *
 * 支持两种来源。已有的 `gh` 登录只被按需读取，什么都不存；粘进来的令牌写进 OS
 * 密钥存储的一个引用名下——令牌本身从不进数据库、日志、项目目录，也不进任何一条
 * core 送回去的 protobuf 消息。
 *
 * 令牌按请求产生，只在内存里待一小会儿，加一个短缓存，好让一页 Issue 不去敲十几
 * 次钥匙串。撤销会立刻清掉那个缓存：一份内存里的副本不该活得比「决定不再用它」
 * 更久。
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

import {
  GithubCredentialSource,
  GithubSecretStore,
  type GithubCredentialStatus,
} from "./types";
import { GithubCredentialStatusSchema } from "./schema";
import { create } from "../contract/message";

import { GithubClient, type GithubClientOptions } from "./client";
import { codeOf, githubError } from "./errors";
import {
  PUBLIC_API_BASE,
  apiHost,
  normalizeApiBase,
  webHostFor,
} from "./remote";
import {
  GITHUB_SOURCE_GH_CLI,
  GITHUB_SOURCE_NONE,
  GITHUB_SOURCE_TOKEN_REF,
  GITHUB_STORE_FILE_FALLBACK,
  GITHUB_STORE_NONE,
  GITHUB_STORE_OS_KEYCHAIN,
  type GithubConfig,
  type GithubStore,
} from "./store";

/**
 * 一个 GitHub 令牌是一串不透明的 ASCII。拒绝别的东西，就让换行进不了写往钥匙串
 * 工具 stdin 的值，也让控制字符进不了 Authorization 头。
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_.~+/=-]{8,512}$/;

export function validToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** 通用密码的 service 名。account 带着 API 主机，企业版和公有版不会撞。 */
const KEYCHAIN_SERVICE = "armadra-github-api";

/**
 * 令牌缓存的有效期：让钥匙串提示或一次 gh 调用不必每个请求都来一遍，又不让一个
 * 已经被撤销的凭据活得明显更久。
 */
const TOKEN_TTL_MS = 60_000;

/** 一个存起来的密钥的名字。它是账号标签，从来不是密钥本身。 */
export function reference(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!HOST_PATTERN.test(normalized)) throw githubError("invalid");
  return `api@${normalized}`;
}

export type SecretStoreKind = "none" | "os_keychain" | "file_fallback";

/**
 * 读写一个令牌。接口存在是为了让测试永远不碰开发者真正的钥匙串或家目录。
 */
export interface SecretStore {
  kind(): SecretStoreKind;
  put(reference: string, token: string): Promise<void>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

/**
 * 挑这台机器能给的最强的存储。macOS 用登录钥匙串；别的地方退到数据目录下一个
 * 0600 文件，**并且报告自己退了**。
 *
 * `ARMADRA_GITHUB_SECRET_STORE=file` 强制退化。它是给无人值守的运行和核验用的
 * ——那些场合不该往操作者真正的钥匙串里写——也给任何宁愿把值留在 core 自己目录
 * 里的人。更弱的保护仍然如实报告，所以选它永远不会看起来像钥匙串。
 */
export function openSecretStore(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore {
  const fallback = new FileSecretStore(join(dataDir, "github-credentials"));
  if ((env.ARMADRA_GITHUB_SECRET_STORE ?? "").trim().toLowerCase() === "file") {
    return fallback;
  }
  if (process.platform === "darwin") return new KeychainSecretStore();
  return fallback;
}

/** 一个子进程的输出，超时和最小环境都在里面。 */
function run(
  tool: string,
  args: readonly string[],
  options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      tool,
      [...args],
      {
        // 一个 helper 进程不该继承 core 的整个环境。
        env: minimalEnv(),
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 1 << 20,
        encoding: "utf8",
      },
      (error, stdout) => {
        resolve({
          ok: error === null,
          stdout: typeof stdout === "string" ? stdout : "",
        });
      },
    );
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "TMPDIR",
    "LANG",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

class KeychainSecretStore implements SecretStore {
  kind(): SecretStoreKind {
    return "os_keychain";
  }

  /**
   * 经钥匙串工具的交互提示写，而不是它的 `-w` 参数：参数值会出现在进程命令行
   * 里，这个用户的任何进程都读得到。
   */
  async put(name: string, token: string): Promise<void> {
    if (!validToken(token)) throw githubError("invalid");
    await run(
      "security",
      ["add-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-U", "-w"],
      { stdin: `${token}\n${token}\n` },
    );
    // 即使两次提示对不上，工具也退 0，所以这次写靠读回来确认而不是信它。
    const stored = await this.get(name).catch(() => "");
    if (stored !== token) throw githubError("unavailable");
  }

  async get(name: string): Promise<string> {
    const result = await run("security", [
      "find-generic-password",
      "-a",
      name,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    if (!result.ok) throw githubError("unavailable");
    const token = result.stdout.replace(/[\r\n]+$/, "");
    if (!validToken(token)) throw githubError("unavailable");
    return token;
  }

  async delete(name: string): Promise<void> {
    const result = await run("security", [
      "delete-generic-password",
      "-a",
      name,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    if (result.ok) return;
    // 已经不在了正是调用方要的状态。
    try {
      await this.get(name);
    } catch {
      return;
    }
    throw githubError("unavailable");
  }
}

class FileSecretStore implements SecretStore {
  constructor(private readonly directory: string) {}

  kind(): SecretStoreKind {
    return "file_fallback";
  }

  private path(name: string): string {
    // 引用名的形状是固定的，但路径还是从一个清洗过的名字拼出来：一个存进来的值
    // 永远逃不出这个目录。
    const cleaned = name.replace(/@/g, "_at_").replace(/[.:]/g, "_");
    if (cleaned === "" || /[/\\]/.test(cleaned) || cleaned.includes("..")) {
      throw githubError("invalid");
    }
    return join(this.directory, `${cleaned}.token`);
  }

  async put(name: string, token: string): Promise<void> {
    if (!validToken(token)) throw githubError("invalid");
    const path = this.path(name);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.new`;
    rmSync(temporary, { force: true });
    // 从创建那一刻就是 0600，之后不再放宽，所以这个值不会有一瞬间是全世界可读的。
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeSync(handle, token);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, path);
    return Promise.resolve();
  }

  async get(name: string): Promise<string> {
    const path = this.path(name);
    if (!existsSync(path)) throw githubError("unavailable");
    const info = statSync(path);
    // 被放宽过的文件不再被信任：别的东西已经有过读它的机会，所以凭据报告成不可用
    // 而不是照用不误。
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw githubError("unavailable");
    }
    if (info.size > 4096) throw githubError("unavailable");
    const token = readFileSync(path, "utf8").replace(/[\r\n]+$/, "");
    if (!validToken(token)) throw githubError("unavailable");
    return Promise.resolve(token);
  }

  async delete(name: string): Promise<void> {
    rmSync(this.path(name), { force: true });
    return Promise.resolve();
  }
}

/**
 * 从一个已有的 `gh` 登录里读令牌。用户必须显式打开这一项；这里没有任何东西会
 * 自己去翻一份 gh 配置。
 */
export interface GhCli {
  token(apiHostName: string): Promise<string>;
}

export const realGhCli: GhCli = {
  async token(apiHostName: string): Promise<string> {
    if (!HOST_PATTERN.test(apiHostName)) throw githubError("invalid");
    const tool = process.platform === "win32" ? "gh.exe" : "gh";
    // 主机显式传进去，这样企业版登录不会被答以一个公有令牌，反过来也一样。
    const result = await run(
      tool,
      ["auth", "token", "--hostname", apiHostName],
      { timeoutMs: 10_000 },
    );
    if (!result.ok) throw githubError("unsupported");
    if (result.stdout.length > 8192) throw githubError("unavailable");
    const token = result.stdout.trim();
    if (!validToken(token)) throw githubError("unavailable");
    return token;
  },
};

export interface CredentialServiceOptions {
  readonly store: GithubStore;
  readonly secrets: SecretStore;
  readonly gh?: GhCli;
  readonly now?: () => number;
  /** client 的传输选项；测试用它指向本地 mock。 */
  readonly client?: Omit<GithubClientOptions, "token" | "apiBase">;
  /** 第一次配置时落在哪个 API base。这是运维设置，从来不是客户端的选择。 */
  readonly defaultApiBase?: string;
}

export class CredentialService {
  private readonly store: GithubStore;
  private readonly secrets: SecretStore;
  private readonly gh: GhCli;
  private readonly now: () => number;
  private readonly clientOptions: Omit<
    GithubClientOptions,
    "token" | "apiBase"
  >;
  private readonly defaultBase: string;

  private token = "";
  private tokenAt = 0;
  private client: GithubClient | undefined;
  private base = "";
  private revision = 0;
  private scopes: string[] = [];
  private checkedAtMs = 0;
  private failure = "";

  constructor(options: CredentialServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.gh = options.gh ?? realGhCli;
    this.now = options.now ?? (() => Date.now());
    this.clientOptions = options.client ?? {};
    this.defaultBase = normalizeApiBase(options.defaultApiBase);
  }

  private config(): GithubConfig {
    const record = this.store.config();
    if (record !== undefined) return record;
    return {
      source: GITHUB_SOURCE_NONE,
      apiBase: this.defaultBase,
      secretStore: GITHUB_STORE_NONE,
      secretRef: "",
      accountLogin: "",
      revision: 0,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
  }

  /**
   * 描述配置好的凭据，不花远端配额。它报的是「现在能不能产生一个令牌」，这和
   * 「配了一个来源」不是一回事：一个被撤销的 gh 登录是配过的，而且没法用。
   */
  async status(): Promise<GithubCredentialStatus> {
    const record = this.config();
    const status = create(GithubCredentialStatusSchema, {
      source: sourceOf(record.source),
      store: storeOf(record.secretStore),
      apiBase: record.apiBase,
      enterprise: record.apiBase !== PUBLIC_API_BASE,
      revision: BigInt(record.revision),
    });
    if (record.source === GITHUB_SOURCE_NONE) {
      status.reasonCode = "NOT_CONFIGURED";
      return status;
    }
    status.accountLogin = record.accountLogin;
    status.tokenScopes = [...this.scopes];
    status.checkedAtUnixMs = BigInt(this.checkedAtMs);
    const failure = this.failure;
    try {
      await this.tokenFor(record);
    } catch (error) {
      status.reasonCode = reasonFor(error);
      return status;
    }
    status.available = true;
    // 令牌存在，但上一次用它发的请求被拒了。只说「可用」会藏起一个远端不再认的
    // 令牌。
    if (failure !== "") status.reasonCode = failure;
    return status;
  }

  private async tokenFor(record: GithubConfig): Promise<string> {
    const now = this.now();
    if (
      this.token !== "" &&
      this.base === record.apiBase &&
      this.revision === record.revision &&
      now - this.tokenAt < TOKEN_TTL_MS
    ) {
      return this.token;
    }
    let token: string;
    if (record.source === GITHUB_SOURCE_GH_CLI) {
      token = await this.gh.token(webHostFor(record.apiBase));
    } else if (record.source === GITHUB_SOURCE_TOKEN_REF) {
      token = await this.secrets.get(record.secretRef);
    } else {
      throw githubError("unavailable");
    }
    this.token = token;
    this.tokenAt = now;
    this.base = record.apiBase;
    this.revision = record.revision;
    return token;
  }

  /** 丢掉凭据和用它建出来的 client 的每一份内存副本。 */
  private forget(): void {
    this.token = "";
    this.tokenAt = 0;
    this.client = undefined;
    this.base = "";
    this.revision = 0;
    this.scopes = [];
    this.checkedAtMs = 0;
    this.failure = "";
  }

  /**
   * 为配置好的 base 建（或复用）API client。
   *
   * 它**拒绝**而不是返回一个没有凭据的 client，这样没有任何调用方能发出一次匿名
   * 请求、悄悄只读到公开数据。
   */
  apiClient(): GithubClient {
    const record = this.config();
    if (record.source === GITHUB_SOURCE_NONE) throw githubError("unsupported");
    if (
      this.client !== undefined &&
      this.base === record.apiBase &&
      this.revision === record.revision
    ) {
      return this.client;
    }
    const client = new GithubClient({
      ...this.clientOptions,
      apiBase: record.apiBase,
      token: async () => {
        const current = this.config();
        if (current.source === GITHUB_SOURCE_NONE) {
          throw githubError("unsupported");
        }
        return this.tokenFor(current);
      },
    });
    this.client = client;
    this.base = record.apiBase;
    this.revision = record.revision;
    return client;
  }

  /**
   * 记下来源与 API base，核验一次凭据，**然后**才存。先核验意味着一个状态不会
   * 声称一个 core 其实没连上过的账号。
   */
  async configure(
    source: GithubCredentialSource,
    token: string,
    apiBase: string,
    expectedRevision: number,
  ): Promise<GithubCredentialStatus> {
    const name = sourceName(source);
    const base = normalizeApiBase(
      apiBase.trim() === "" ? this.defaultBase : apiBase,
    );
    const pasted = token.trim();
    if (name !== GITHUB_SOURCE_TOKEN_REF && pasted !== "") {
      // 一个发给不存令牌的来源的令牌会被悄悄丢掉；拒绝等于把这件事说出来。
      throw githubError("invalid");
    }
    if (name === GITHUB_SOURCE_TOKEN_REF && !validToken(pasted)) {
      throw githubError("invalid");
    }
    const now = this.now();
    const previous = this.config();
    if (previous.revision !== expectedRevision) throw githubError("conflict");

    let record: GithubConfig = {
      source: name,
      apiBase: base,
      secretStore: GITHUB_STORE_NONE,
      secretRef: "",
      accountLogin: "",
      revision: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    if (name === GITHUB_SOURCE_NONE) {
      return this.commit(record, previous, expectedRevision, "");
    }
    let secretRef = "";
    if (name === GITHUB_SOURCE_TOKEN_REF) {
      secretRef = reference(apiHost(base));
      await this.secrets.put(secretRef, pasted);
      record = {
        ...record,
        secretRef,
        secretStore: storeName(this.secrets.kind()),
      };
    }
    // 核验用的是绑在**正在配置的那个值**上的 client，不是当前存着的那个。
    let verified: { login: string; scopes: string[] };
    try {
      verified = await this.verify(base, async () =>
        name === GITHUB_SOURCE_GH_CLI
          ? this.gh.token(webHostFor(base))
          : pasted,
      );
    } catch (error) {
      if (secretRef !== "")
        await this.secrets.delete(secretRef).catch(() => {});
      throw error;
    }
    record = { ...record, accountLogin: verified.login };
    const status = await this.commit(
      record,
      previous,
      expectedRevision,
      secretRef,
    );
    this.scopes = verified.scopes;
    this.checkedAtMs = now;
    status.tokenScopes = verified.scopes;
    status.checkedAtUnixMs = BigInt(now);
    return status;
  }

  private async commit(
    record: GithubConfig,
    previous: GithubConfig,
    expectedRevision: number,
    secretRef: string,
  ): Promise<GithubCredentialStatus> {
    let stored: GithubConfig;
    try {
      stored = this.store.putConfig(record, expectedRevision);
    } catch (error) {
      if (secretRef !== "")
        await this.secrets.delete(secretRef).catch(() => {});
      throw error;
    }
    // 被替换掉的令牌引用只在新的那个落定之后才删，所以一次失败的写永远不会让这
    // 台机器一个凭据都不剩。
    if (previous.secretRef !== "" && previous.secretRef !== stored.secretRef) {
      await this.secrets.delete(previous.secretRef).catch(() => {});
    }
    this.forget();
    return create(GithubCredentialStatusSchema, {
      source: sourceOf(stored.source),
      store: storeOf(stored.secretStore),
      available: stored.source !== GITHUB_SOURCE_NONE,
      apiBase: stored.apiBase,
      enterprise: stored.apiBase !== PUBLIC_API_BASE,
      accountLogin: stored.accountLogin,
      revision: BigInt(stored.revision),
      reasonCode: stored.source === GITHUB_SOURCE_NONE ? "NOT_CONFIGURED" : "",
    });
  }

  /**
   * 删掉存着的密钥，把这台机器退回「未配置」。它**从不碰用户的 gh 登录**：这台
   * 机器不再用它，和把人登出是两件事。
   */
  async revoke(expectedRevision: number): Promise<GithubCredentialStatus> {
    const previous = this.config();
    if (previous.revision !== expectedRevision || expectedRevision === 0) {
      throw githubError("conflict");
    }
    const now = this.now();
    return this.commit(
      {
        source: GITHUB_SOURCE_NONE,
        apiBase: previous.apiBase,
        secretStore: GITHUB_STORE_NONE,
        secretRef: "",
        accountLogin: "",
        revision: 0,
        createdAtMs: now,
        updatedAtMs: now,
      },
      previous,
      expectedRevision,
      "",
    );
  }

  /** 在存下来之前先证明这个凭据真的能到达一个账号。 */
  private async verify(
    base: string,
    token: () => Promise<string>,
  ): Promise<{ login: string; scopes: string[] }> {
    const client = new GithubClient({
      ...this.clientOptions,
      apiBase: base,
      token,
    });
    let response;
    try {
      response = await client.get("/user");
    } catch {
      throw githubError("unavailable");
    }
    let login = "";
    try {
      login =
        (JSON.parse(response.body.toString("utf8")) as { login?: string })
          .login ?? "";
    } catch {
      throw githubError("unavailable");
    }
    if (login === "") throw githubError("unavailable");
    return { login, scopes: [...response.oauthScopes] };
  }

  /**
   * 记下「用当前凭据发的一次请求被拒了」，这样下一次状态可以说令牌不再工作，而
   * 不只是说它存在。
   */
  noteFailure(error: unknown): void {
    const code = codeOf(error);
    if (code === "UNAUTHENTICATED") {
      this.failure = "TOKEN_REJECTED";
      // 一个被拒的令牌不能再从缓存里放回来。
      this.token = "";
      this.tokenAt = 0;
      return;
    }
    if (code === "PERMISSION_DENIED") {
      this.failure = "INSUFFICIENT_SCOPES";
    }
  }

  /** 一次成功之后清掉记着的失败。 */
  noteSuccess(): void {
    this.failure = "";
  }
}

function reasonFor(error: unknown): string {
  if (error instanceof Error && "kind" in error) {
    const kind = (error as { kind: string }).kind;
    if (kind === "unsupported") return "SOURCE_UNAVAILABLE";
    if (kind === "invalid") return "CONFIGURATION_INVALID";
  }
  return "TOKEN_UNAVAILABLE";
}

export function sourceOf(value: string): GithubCredentialSource {
  if (value === GITHUB_SOURCE_GH_CLI) return GithubCredentialSource.GH_CLI;
  if (value === GITHUB_SOURCE_TOKEN_REF)
    return GithubCredentialSource.TOKEN_REF;
  return GithubCredentialSource.NONE;
}

export function storeOf(value: string): GithubSecretStore {
  if (value === GITHUB_STORE_OS_KEYCHAIN) return GithubSecretStore.OS_KEYCHAIN;
  if (value === GITHUB_STORE_FILE_FALLBACK) {
    return GithubSecretStore.FILE_FALLBACK;
  }
  return GithubSecretStore.NONE;
}

export function sourceName(value: GithubCredentialSource): string {
  switch (value) {
    case GithubCredentialSource.NONE:
      return GITHUB_SOURCE_NONE;
    case GithubCredentialSource.GH_CLI:
      return GITHUB_SOURCE_GH_CLI;
    case GithubCredentialSource.TOKEN_REF:
      return GITHUB_SOURCE_TOKEN_REF;
    default:
      throw githubError("invalid");
  }
}

function storeName(kind: SecretStoreKind): string {
  return kind;
}
