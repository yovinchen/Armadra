/**
 * 三家的用量读取。移植自 `apps/runtime/src/usage/{claude,codex,copilot}.rs`。
 *
 * 模块的三条规矩在这里逐条成立：
 *
 * 1. **令牌不离开这个模块。** 它们从 OS 钥匙串或一个 0600 文件读出来、在一次请求的
 *    生命周期里待在一个局部变量里、然后丢掉。它们从不写进 SQLite、从不被日志（连
 *    trace 级都不）、从不被序列化进一条 API 响应。
 * 2. **只有百分比与重置时间到达 API。** 上游的载荷带着账号 id、邮箱和套餐名；那些
 *    一个都不被映射进 {@link UsageSnapshot}。
 * 3. **失败带原因码，不带消息。** 一个只看到「取不到用量」的用户分不清一次过期的
 *    登录和一个代理问题。
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  CredentialSource,
  UsageCredits,
  UsageFailure,
  UsageWindow,
} from "./snapshot";

const HTTP_TIMEOUT_MS = 10_000;

/** 一个供应商模块成功时产出什么。 */
export interface ProviderReport {
  readonly windows: UsageWindow[];
  readonly credits?: UsageCredits;
  /**
   * 值不是从这家自己的 OAuth 路来的时候设上——今天只有 Codex 的本地 CLI 兜底。
   * 报出来好让看板能说这个数字从哪儿来。
   */
  readonly viaCli?: boolean;
}

/**
 * 一个供应商模块返回什么：`undefined` = 这台机器上没有凭据（→ unavailable），
 * 一个 report = 解析成功（→ ok），抛出 {@link ProviderError} = 其余（→ error）。
 */
export type ProviderResult =
  | { readonly report: ProviderReport | undefined; readonly source: CredentialSource }
  | never;

export class ProviderError extends Error {
  constructor(readonly reason: UsageFailure) {
    super(reason);
    this.name = "ProviderError";
  }
}

export function failureFromStatus(status: number): UsageFailure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

/** `~`，Windows 用 `USERPROFILE`。 */
export function homeDir(): string | undefined {
  const value = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return value === "" ? undefined : value;
}

/**
 * `604800 → "7d"`、`18000 → "5h"`。供应商按秒报窗口大小；胶囊要的是 CLI 打印的
 * 那个短标签。
 */
export function durationLabel(seconds: number): string | undefined {
  if (seconds <= 0) return undefined;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.max(Math.floor(seconds / 60), 1)}m`;
}

/** 百分比带着长尾巴来；胶囊和浮层只会显示一位小数。 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(Math.max(value, 0), 100) * 10) / 10;
}

/** 注入的 `fetch`，测试用它指向本地 mock；没有一条测试会连真的服务。 */
export type Fetcher = typeof globalThis.fetch;

async function getJson(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("network");
  }
  if (!response.ok) {
    // 正文会回显账号细节；状态是我们唯一留下的东西。
    throw new ProviderError(failureFromStatus(response.status));
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderError("parse");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* ---------------------------------- Claude -------------------------------- */
//
// 凭据来自 CLI 自己用的那两个地方：
//
//   * macOS 钥匙串条目 `Claude Code-credentials`，载荷是
//     `{"claudeAiOauth":{"accessToken":…,"expiresAt":<ms>,…}}`；
//   * `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`，同一份 JSON。
//
// 端点是 CLI 的 `/usage` 调的那个：`api.anthropic.com` 上的
// `GET /api/oauth/usage`，用 OAuth 访问令牌认证（`Authorization: Bearer …` 加
// `anthropic-beta: oauth-2025-04-20`——OAuth 令牌不是 `x-api-key`）。

export const CLAUDE_ID = "claude";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** 一条过期的钥匙串条目不能盖住一份可用的文件凭据。 */
export function tokenFromPayload(
  raw: string,
  nowMs: number,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const oauth = record(record(parsed)?.claudeAiOauth);
  if (oauth === undefined) return undefined;
  const expiresAt = num(oauth.expiresAt);
  if (expiresAt !== undefined && expiresAt <= nowMs) return undefined;
  const token = oauth.accessToken;
  return typeof token === "string" && token !== "" ? token : undefined;
}

export function selectCredential(
  entries: readonly (readonly [string | undefined, CredentialSource])[],
  nowMs: number,
): { token: string | undefined; source: CredentialSource } {
  let found: CredentialSource = "none";
  for (const [raw, source] of entries) {
    if (raw === undefined) continue;
    if (found === "none") found = source;
    const token = tokenFromPayload(raw, nowMs);
    if (token !== undefined) return { token, source };
  }
  return { token: undefined, source: found };
}

function claudeKeychainPayload(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: 3_000, encoding: "utf8", maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error !== null) return resolve(undefined);
        const value = String(stdout).trim();
        resolve(value === "" ? undefined : value);
      },
    );
  });
}

function claudeFilePayload(): string | undefined {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const directory =
    configured !== undefined && configured !== ""
      ? configured
      : homeDir() === undefined
        ? undefined
        : join(homeDir() as string, ".claude");
  if (directory === undefined) return undefined;
  try {
    return readFileSync(join(directory, ".credentials.json"), "utf8");
  } catch {
    return undefined;
  }
}

export interface ClaudeUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string | null } | null;
  seven_day?: { utilization?: number; resets_at?: string | null } | null;
  [key: string]: unknown;
}

export function claudeWindows(usage: ClaudeUsageResponse): UsageWindow[] {
  const result: UsageWindow[] = [];
  for (const [key, window] of [
    ["5h", usage.five_hour],
    ["7d", usage.seven_day],
  ] as const) {
    const value = record(window);
    const utilization = num(value?.utilization);
    if (utilization === undefined) continue;
    result.push({
      key,
      label: key,
      usedPercent: clampPercent(utilization),
      resetsAt: typeof value?.resets_at === "string" ? value.resets_at : null,
    });
  }
  // 每个模型自己的 7d 窗口。上游新加的键不会变成这里的错误。
  for (const [key, raw] of Object.entries(usage)) {
    if (!key.startsWith("seven_day_")) continue;
    const model = key.slice("seven_day_".length);
    const value = record(raw);
    const utilization = num(value?.utilization);
    if (utilization === undefined) continue;
    const group =
      model === "opus" ? "Opus" : model === "sonnet" ? "Sonnet" : model.replace(/_/g, " ");
    result.push({
      key,
      label: "7d",
      group,
      usedPercent: clampPercent(utilization),
      resetsAt: typeof value?.resets_at === "string" ? value.resets_at : null,
    });
  }
  return result;
}

export async function fetchClaude(
  fetcher: Fetcher,
  nowMs: number = Date.now(),
): Promise<ProviderResult> {
  const keychain = [await claudeKeychainPayload(), "keychain"] as const;
  const file = [claudeFilePayload(), "file"] as const;
  // 显式配过 `CLAUDE_CONFIG_DIR` 的人是在说「用这个目录」，所以它排在前面。
  const entries =
    (process.env.CLAUDE_CONFIG_DIR ?? "") !== ""
      ? ([file, keychain] as const)
      : ([keychain, file] as const);
  const { token, source } = selectCredential(entries, nowMs);
  if (token === undefined) {
    if (source === "none") return { report: undefined, source };
    // 找到了载荷但里面没有还有效的令牌。CLI 下次运行会续它；这个模块不写凭据。
    throw new ProviderError("expired_credentials");
  }
  const usage = (await getJson(fetcher, CLAUDE_USAGE_URL, {
    authorization: `Bearer ${token}`,
    "anthropic-beta": CLAUDE_OAUTH_BETA,
    "content-type": "application/json",
  })) as ClaudeUsageResponse;
  return { report: { windows: claudeWindows(usage) }, source };
}

/* ----------------------------------- Codex -------------------------------- */
//
// 凭据来自 `${CODEX_HOME:-~/.codex}/auth.json`，即 `codex login` 写的那个文件。
// `account_id` 缺席时从 `id_token` 的 `chatgpt_account_id` claim 里恢复——那个 JWT
// 只被**解码**、从不被验证：它是我们自己的文件，而后端无论如何都会验它。

export const CODEX_ID = "codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
/** 握手加一次 RPC 是一次亚秒级交换；更久意味着 CLI 在提示或者卡住了。 */
const CODEX_CLI_TIMEOUT_MS = 8_000;

export function accountIdFromJwt(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = record(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const auth = record(claims?.[CODEX_AUTH_CLAIM]);
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

export function codexCredentials():
  | { token: string; accountId: string }
  | undefined {
  const configured = process.env.CODEX_HOME;
  const directory =
    configured !== undefined && configured !== ""
      ? configured
      : homeDir() === undefined
        ? undefined
        : join(homeDir() as string, ".codex");
  if (directory === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(directory, "auth.json"), "utf8");
  } catch {
    return undefined;
  }
  let tokens: Record<string, unknown> | undefined;
  try {
    tokens = record(record(JSON.parse(raw))?.tokens);
  } catch {
    return undefined;
  }
  const token = tokens?.access_token;
  if (typeof token !== "string" || token === "") return undefined;
  const direct = tokens?.account_id;
  const accountId =
    typeof direct === "string" && direct !== ""
      ? direct
      : typeof tokens?.id_token === "string"
        ? accountIdFromJwt(tokens.id_token)
        : undefined;
  return accountId === undefined ? undefined : { token, accountId };
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

function codexResetsAt(window: CodexWindow, nowMs: number): string | null {
  if (window.reset_at !== undefined && window.reset_at > 0) {
    return new Date(window.reset_at * 1000).toISOString();
  }
  if (
    window.reset_after_seconds !== undefined &&
    window.reset_after_seconds > 0
  ) {
    return new Date(nowMs + window.reset_after_seconds * 1000).toISOString();
  }
  return null;
}

function codexRateWindows(
  rateLimit: Record<string, unknown> | undefined,
  id: string | undefined,
  group: string | undefined,
  nowMs: number,
): UsageWindow[] {
  const result: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const window = record(rateLimit?.[`${key}_window`]) as
      | CodexWindow
      | undefined;
    if (window === undefined) continue;
    const percent = num(window.used_percent);
    if (percent === undefined) continue;
    result.push({
      key: id === undefined ? key : `${id}:${key}`,
      label:
        (window.limit_window_seconds === undefined
          ? undefined
          : durationLabel(window.limit_window_seconds)) ?? key,
      ...(group === undefined ? {} : { group }),
      usedPercent: clampPercent(percent),
      resetsAt: codexResetsAt(window, nowMs),
    });
  }
  return result;
}

/** `credits.balance` 在有些套餐上是字符串、有些上是数字，所以按未定型读再强制。 */
export function codexCredits(raw: unknown): UsageCredits | undefined {
  const balance = record(raw)?.balance;
  const value =
    typeof balance === "number"
      ? balance
      : typeof balance === "string"
        ? Number.parseFloat(balance.trim())
        : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return undefined;
  // 两位小数：余额是钱，原始值带着会渲染成 12.299999999999999 的浮点尾巴。
  return { balance: Math.round(value * 100) / 100 };
}

export function codexReport(usage: unknown, nowMs: number): ProviderReport {
  const value = record(usage);
  const windows = codexRateWindows(
    record(value?.rate_limit),
    undefined,
    undefined,
    nowMs,
  );
  const additional = Array.isArray(value?.additional_rate_limits)
    ? value.additional_rate_limits
    : [];
  for (const [index, entry] of additional.entries()) {
    const limit = record(entry);
    const rateLimit = record(limit?.rate_limit);
    if (rateLimit === undefined) continue;
    const metered = limit?.metered_feature;
    const id =
      typeof metered === "string" && metered !== ""
        ? metered
        : `additional-${index}`;
    const name = limit?.limit_name;
    windows.push(
      ...codexRateWindows(
        rateLimit,
        id,
        typeof name === "string" && name !== "" ? name : id,
        nowMs,
      ),
    );
  }
  const credits = codexCredits(value?.credits);
  return { windows, ...(credits === undefined ? {} : { credits }) };
}

/**
 * `cliFallback` 是 `usage.codexCliFallback`。它只**增加**一次答上来的机会：一次
 * 成功的 OAuth 读永远不会拉起 CLI。
 */
export async function fetchCodex(
  fetcher: Fetcher,
  cliFallback: boolean,
  nowMs: number = Date.now(),
): Promise<ProviderResult> {
  const credentials = codexCredentials();
  if (credentials === undefined) {
    return {
      report: cliFallback ? await codexCliReport() : undefined,
      source: "none",
    };
  }
  let report: ProviderReport | undefined;
  let failure: unknown;
  try {
    const usage = await getJson(fetcher, CODEX_USAGE_URL, {
      authorization: `Bearer ${credentials.token}`,
      "chatgpt-account-id": credentials.accountId,
      originator: CODEX_ORIGINATOR,
      accept: "application/json",
    });
    report = codexReport(usage, nowMs);
  } catch (error) {
    failure = error;
  }
  if ((report?.windows.length ?? 0) > 0 || !cliFallback) {
    if (failure !== undefined) throw failure;
    return { report, source: "file" };
  }
  // OAuth 那条路失败了或者答了没用的东西。CLI 帮不上忙时保留它的结果，这样一个
  // 无关的 CLI 问题不会盖住一个真的 401。
  const fallback = await codexCliReport();
  if (fallback !== undefined) return { report: fallback, source: "file" };
  if (failure !== undefined) throw failure;
  return { report, source: "file" };
}

/** `codex` 可执行文件。`ARMADRA_CODEX_BIN` 覆盖它，测试用它指向一个桩。 */
function codexBinary(): string {
  const configured = process.env.ARMADRA_CODEX_BIN;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : "codex";
}

async function codexCliReport(): Promise<ProviderReport | undefined> {
  const windows = await codexCliRateLimits().catch(() => undefined);
  if (windows === undefined || windows.length === 0) return undefined;
  return { windows, viaCli: true };
}

/**
 * `codex app-server` 在 stdio 上说换行分隔的 JSON-RPC 2.0。交换是
 * `initialize` → `initialized` → `account/rateLimits/read`；答案一到就杀掉进程。
 */
export function codexCliRateLimits(
  binary: string = codexBinary(),
  nowMs: number = Date.now(),
): Promise<UsageWindow[] | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      // 没装不是失败：兜底只是没有东西可加，OAuth 的结果仍然成立。
      return resolve(undefined);
    }
    let settled = false;
    const finish = (value: UsageWindow[] | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), CODEX_CLI_TIMEOUT_MS);
    child.on("error", () => finish(undefined));
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        let message: Record<string, unknown> | undefined;
        try {
          message = record(JSON.parse(line));
        } catch {
          continue;
        }
        if (message?.id !== 1) continue;
        if (message.error !== undefined) return finish(undefined);
        return finish(codexCliWindows(message.result, nowMs));
      }
    });
    for (const line of [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "armadra", version: "0" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 1, method: "account/rateLimits/read", params: {} },
    ]) {
      child.stdin?.write(`${JSON.stringify(line)}\n`);
    }
  });
}

/**
 * RPC 结果里嵌着 HTTP 那条路返回的同一批 primary / secondary 窗口，但字段名在不同
 * CLI 版本之间变过。两种拼法都认；认不出来的产出没有窗口，而不是一个零。
 */
export function codexCliWindows(result: unknown, nowMs: number): UsageWindow[] {
  const root = record(result) ?? {};
  const limits =
    record(root.rateLimits) ??
    record(root.rate_limits) ??
    record(root.rateLimit) ??
    record(root.rate_limit) ??
    root;
  const windows: UsageWindow[] = [];
  for (const [key, aliases] of [
    ["primary", ["primary", "primary_window", "primaryWindow"]],
    ["secondary", ["secondary", "secondary_window", "secondaryWindow"]],
  ] as const) {
    let window: Record<string, unknown> | undefined;
    for (const alias of aliases) {
      window = record(limits[alias]);
      if (window !== undefined) break;
    }
    if (window === undefined) continue;
    const percent = num(window.used_percent) ?? num(window.usedPercent);
    if (percent === undefined) continue;
    const minutes = num(window.window_minutes) ?? num(window.windowMinutes);
    const seconds =
      minutes !== undefined
        ? minutes * 60
        : (num(window.limit_window_seconds) ?? num(window.windowSeconds));
    const resets =
      num(window.resets_in_seconds) ?? num(window.resetsInSeconds);
    windows.push({
      key,
      label:
        (seconds === undefined ? undefined : durationLabel(seconds)) ?? key,
      usedPercent: clampPercent(percent),
      resetsAt:
        resets === undefined
          ? null
          : new Date(nowMs + Math.max(resets, 0) * 1000).toISOString(),
    });
  }
  return windows;
}

/* ---------------------------------- Copilot ------------------------------- */

export const COPILOT_ID = "copilot";

export interface CopilotUser {
  quota_snapshots?: Record<
    string,
    { percent_remaining?: number; unlimited?: boolean }
  >;
  quota_reset_date?: string;
}

/**
 * `2026-10-01` → 那一天在 UTC 的 RFC 3339 起点。GitHub 给的是日期不是瞬间；UTC
 * 午夜是唯一一个不凭空发明时区的读法。
 */
export function copilotResetTimestamp(date: string): string | null {
  const parsed = Date.parse(`${date.trim()}T00:00:00Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z")
    : null;
}

export function copilotWindows(user: CopilotUser): UsageWindow[] {
  const resetsAt =
    user.quota_reset_date === undefined
      ? null
      : copilotResetTimestamp(user.quota_reset_date);
  const windows: UsageWindow[] = [];
  for (const [key, snapshot] of Object.entries(user.quota_snapshots ?? {})) {
    // 一个没有上限的桶没有百分比可显示。它带着 `usedPercent: 0` **和**
    // `unlimited: true` 报出去，好让看板打印「无限制」而不是一条空条——那条
    // 「不要把缺失值显示成 0」的规矩针对的是失败，不是一个真的没有天花板的配额。
    if (snapshot.unlimited === true) {
      windows.push({
        key,
        label: key.replace(/_/g, " "),
        usedPercent: 0,
        unlimited: true,
        resetsAt,
      });
      continue;
    }
    const remaining = num(snapshot.percent_remaining);
    if (remaining === undefined) continue;
    windows.push({
      key,
      label: key.replace(/_/g, " "),
      usedPercent: clampPercent(100 - remaining),
      resetsAt,
    });
  }
  return windows;
}

export function githubApiBase(): string {
  const configured = process.env.ARMADRA_GITHUB_API_BASE;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : "https://api.github.com";
}

export async function fetchCopilot(
  fetcher: Fetcher,
  token: string | undefined,
  backend: "keychain" | "file",
): Promise<ProviderResult> {
  if (token === undefined) return { report: undefined, source: "none" };
  const source: CredentialSource = backend === "keychain" ? "keychain" : "file";
  const user = (await getJson(
    fetcher,
    `${githubApiBase()}/copilot_internal/user`,
    {
      // Copilot 的内部端点吃的是经典的 `token` 方案，不是 `Bearer`。
      authorization: `token ${token}`,
      accept: "application/json",
    },
  )) as CopilotUser;
  return { report: { windows: copilotWindows(user) }, source };
}
