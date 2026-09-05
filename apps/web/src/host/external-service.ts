import { isHostServed } from "../api/runtime-url";
import { ensureHostCsrf, forgetHostCsrf } from "./proxy-session";

/**
 * 「对外服务」开关（H02，host-protocol-design §5）。
 *
 * 这是 Host 自己的一条管理路由，不是跨端业务契约：没有工作空间、会话或文件
 * 数据经过它，所以是一份小 JSON 文档，和 `/health` 是纯文本同理。读要
 * `settings:read`、写要 `settings:write` 与会话 CSRF，判定全在 Host 那边——
 * 这里不替它猜权限，拿到什么就显示什么。
 */

export const EXTERNAL_SERVICE_PATH = "/host/external-service";

/** 这个开关只有在页面本身由 Host 托管时才有对象可读写。 */
export function hostServedPage(
  pageUrl: string = globalThis.location?.href ?? "http://localhost/",
): boolean {
  return isHostServed(import.meta.env.VITE_RUNTIME_URL, pageUrl);
}

export interface ExternalService {
  /** Host 没配 HTTPS 时为 false：开关看得见，但打不开。 */
  supported: boolean;
  enabled: boolean;
  address: string;
  port: number;
  allowLan: boolean;
  /** 证书与 Cookie 绑定的来源，设备必须用它访问。 */
  publicOrigin: string;
  /** 实际正在监听的 `ip:port`，关掉时为空。 */
  boundAddress: string;
  /** 现在可以扫的地址，未开启时为空。 */
  accessUrl: string;
  /** 本机可选的局域网 IPv4，仅供选择，Host 不会自己挑一个。 */
  interfaces: string[];
}

export interface ExternalServicePatch {
  enabled?: boolean;
  address?: string;
  port?: number;
  allowLan?: boolean;
}

/** Host 拒绝时带回来的稳定代码与说明。 */
export class ExternalServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalServiceError";
  }
}

function parse(value: unknown): ExternalService {
  const record = (value ?? {}) as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  return {
    supported: record.supported === true,
    enabled: record.enabled === true,
    address: text("address"),
    port: typeof record.port === "number" ? record.port : 0,
    allowLan: record.allowLan === true,
    publicOrigin: text("publicOrigin"),
    boundAddress: text("boundAddress"),
    accessUrl: text("accessUrl"),
    interfaces: Array.isArray(record.interfaces)
      ? record.interfaces.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };
}

async function call(
  method: "GET" | "PUT",
  body: ExternalServicePatch | undefined,
  fetcher: typeof fetch,
  origin: string,
  csrf: string,
): Promise<Response> {
  return fetcher(`${origin}${EXTERNAL_SERVICE_PATH}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-Armadra-CSRF": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
    redirect: "error",
    cache: "no-store",
  });
}

async function result(response: Response): Promise<ExternalService> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const document = (payload ?? {}) as { code?: unknown; message?: unknown };
    throw new ExternalServiceError(
      response.status,
      typeof document.code === "string" ? document.code : "UNKNOWN",
      typeof document.message === "string" ? document.message : "",
    );
  }
  return parse(payload);
}

export async function readExternalService(
  fetcher: typeof fetch = fetch,
  origin: string | undefined = globalThis.location?.origin,
): Promise<ExternalService> {
  if (!origin) throw new ExternalServiceError(0, "UNSUPPORTED", "");
  return result(await call("GET", undefined, fetcher, origin, ""));
}

export async function saveExternalService(
  patch: ExternalServicePatch,
  fetcher: typeof fetch = fetch,
  origin: string | undefined = globalThis.location?.origin,
): Promise<ExternalService> {
  if (!origin) throw new ExternalServiceError(0, "UNSUPPORTED", "");
  let response = await call(
    "PUT",
    patch,
    fetcher,
    origin,
    await ensureHostCsrf(fetcher, origin),
  );
  // A rotated token is the one failure worth retrying: the switch was not
  // touched, so nothing was applied twice.
  if (response.status === 403) {
    forgetHostCsrf();
    const renewed = await ensureHostCsrf(fetcher, origin);
    if (renewed) response = await call("PUT", patch, fetcher, origin, renewed);
  }
  return result(response);
}
