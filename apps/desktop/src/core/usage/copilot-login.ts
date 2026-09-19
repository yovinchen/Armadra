/**
 * GitHub Copilot 的设备流。移植自 `apps/runtime/src/usage/copilot.rs` 的登录那一半
 * 与 `copilot_login.rs`。
 *
 * 和别的供应商不同，这台机器上没有一个 Copilot CLI 的凭据可以借，所以 core 自己跑
 * GitHub 的**设备流**并拥有得到的令牌：
 *
 * 1. `POST {oauth}/login/device/code` 带 `client_id` 与 `scope=read:user`，返回一个
 *    用户要在 `verification_uri` 里敲的 `user_code`。
 * 2. `POST {oauth}/login/oauth/access_token` 按 GitHub 指定的间隔轮询，直到它答出一
 *    个 `access_token`（或者 `expired_token` / `access_denied`）。
 * 3. 令牌进 {@link SecretStore}——macOS 钥匙串，或者别处一个 0600 文件，设置页把后者
 *    标成降级。
 *
 * 进行中的流**只在内存里**：一次半完成的登录不值得持久化，而 `device_code` 是一个
 * 等价于 bearer 的密钥，不能到磁盘、也不能到一条 API 响应里。
 */

import type { Fetcher } from "./providers";
import type { SecretBackend, SecretStore } from "./secret-store";

/**
 * GitHub Copilot 编辑器集成的公开设备流 client id。设备流的 client id 不是密钥
 * （这个授权里没有 client secret）；`ARMADRA_COPILOT_CLIENT_ID` 为测试和自带 OAuth
 * 应用的企业部署覆盖它。
 */
const DEFAULT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
/** `read:user` 就是全部的请求：`copilot_internal/user` 只要一个认证过的用户。 */
const SCOPE = "read:user";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** GitHub 拒绝比它返回的间隔更快的轮询，并答 `slow_down`。 */
const MIN_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;

export function oauthBase(): string {
  const configured = process.env.ARMADRA_GITHUB_OAUTH_BASE;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : "https://github.com";
}

function clientId(): string {
  const configured = process.env.ARMADRA_COPILOT_CLIENT_ID;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : DEFAULT_CLIENT_ID;
}

/** 进行中的流。`deviceCode` 不在 {@link LoginPrompt} 上。 */
interface PendingLogin {
  /** 等价于 bearer。从不被序列化。 */
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresAtMs: number;
}

/** `GET`/`POST /api/usage/copilot/*` 答什么。 */
export interface LoginPrompt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresAt: string;
}

/**
 * 一次登录尝试走到哪了。`pending` 的意思是「继续轮询」；其余每一个都是终态，调用方
 * 把这条流丢掉。
 */
export type LoginProgress =
  | "pending"
  | "authorized"
  | "expired"
  | "denied"
  | "error";

/** 给设置页的登录态。报令牌**在哪儿**，从不报令牌。 */
export interface AuthState {
  readonly signedIn: boolean;
  readonly backend: SecretBackend;
  readonly pending?: LoginPrompt;
}

export interface CopilotPollResult {
  readonly progress: LoginProgress;
  readonly state: AuthState;
}

function prompt(pending: PendingLogin): LoginPrompt {
  return {
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    intervalSeconds: pending.intervalSeconds,
    expiresAt: new Date(pending.expiresAtMs).toISOString(),
  };
}

async function form(
  fetcher: Fetcher,
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${oauthBase()}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`github answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export class CopilotLogin {
  private pending: PendingLogin | undefined;
  /** 串行化 `begin`/`poll`，两个窗口不能抢同一个 device code。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async authState(): Promise<AuthState> {
    return {
      signedIn: await this.store.isSet(),
      backend: this.store.backend(),
      ...(this.pending === undefined ? {} : { pending: prompt(this.pending) }),
    };
  }

  /** `GET /api/usage/copilot` —— 登录标志、后端，以及有流在跑时那个提示。 */
  async state(): Promise<AuthState> {
    // 过期的提示在这里被丢掉而不是展示：上面那个 user code 已经不管用了，给出去
    // 是一条死路。
    if (this.pending !== undefined && this.pending.expiresAtMs <= this.now()) {
      this.pending = undefined;
    }
    return this.authState();
  }

  /**
   * `POST /api/usage/copilot/login` —— 开始（或者接着）一条设备流。一个还有效的提示
   * 原样返回，所以一个被重新打开的设置页继续显示用户正在敲的那个码。
   */
  begin(fetcher: Fetcher): Promise<AuthState> {
    return this.serialize(async () => {
      if (this.pending !== undefined && this.pending.expiresAtMs > this.now()) {
        return this.authState();
      }
      const body = await form(fetcher, "/login/device/code", {
        client_id: clientId(),
        scope: SCOPE,
      });
      const deviceCode = body.device_code;
      const userCode = body.user_code;
      if (typeof deviceCode !== "string" || deviceCode === "") {
        throw new Error("no device code");
      }
      if (typeof userCode !== "string" || userCode === "") {
        throw new Error("no user code");
      }
      const expiresIn =
        typeof body.expires_in === "number" && body.expires_in > 0
          ? body.expires_in
          : DEFAULT_EXPIRES_IN_SECONDS;
      this.pending = {
        deviceCode,
        userCode,
        verificationUri:
          typeof body.verification_uri === "string" &&
          body.verification_uri !== ""
            ? body.verification_uri
            : `${oauthBase()}/login/device`,
        intervalSeconds: Math.max(
          typeof body.interval === "number"
            ? body.interval
            : MIN_POLL_INTERVAL_SECONDS,
          MIN_POLL_INTERVAL_SECONDS,
        ),
        expiresAtMs: this.now() + expiresIn * 1000,
      };
      return this.authState();
    });
  }

  /**
   * `POST /api/usage/copilot/poll` —— 跑一次轮询。没有流在进行时答 `expired`，UI 把
   * 它读成「重新开始」而不是一次失败。
   */
  poll(fetcher: Fetcher): Promise<CopilotPollResult> {
    return this.serialize(async () => {
      const pending = this.pending;
      if (pending === undefined) {
        return { progress: "expired" as const, state: await this.authState() };
      }
      const progress = await this.pollOnce(fetcher, pending);
      if (progress !== "pending") this.pending = undefined;
      return { progress, state: await this.authState() };
    });
  }

  private async pollOnce(
    fetcher: Fetcher,
    pending: PendingLogin,
  ): Promise<LoginProgress> {
    if (pending.expiresAtMs <= this.now()) return "expired";
    let body: Record<string, unknown>;
    try {
      body = await form(fetcher, "/login/oauth/access_token", {
        client_id: clientId(),
        device_code: pending.deviceCode,
        grant_type: GRANT_TYPE,
      });
    } catch {
      // 规矩 3：细节被记录、从不返回。device code 不在错误里，因为我们从不把它
      // 格式化进一个错误。
      return "error";
    }
    const token = body.access_token;
    if (typeof token === "string" && token !== "") {
      try {
        await this.store.write(token);
      } catch {
        return "error";
      }
      return "authorized";
    }
    switch (body.error) {
      // `slow_down` 的意思也是「继续」——调用方已经在两次轮询之间等 GitHub 要的
      // 那个间隔了。
      case undefined:
      case "authorization_pending":
      case "slow_down":
        return "pending";
      case "expired_token":
        return "expired";
      case "access_denied":
        return "denied";
      default:
        return "error";
    }
  }

  /** `POST /api/usage/copilot/logout` —— 丢掉令牌和任何进行中的流。 */
  logout(): Promise<AuthState> {
    return this.serialize(async () => {
      this.pending = undefined;
      await this.store.clear();
      return this.authState();
    });
  }

  /** 存着的令牌，给 `fetchCopilot`。值不经过任何别的地方。 */
  token(): Promise<string | undefined> {
    return this.store.read();
  }

  backend(): SecretBackend {
    return this.store.backend();
  }
}
