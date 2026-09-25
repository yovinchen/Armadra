import { BUILD, instanceId } from "../instance";

/**
 * `/health` and `/api/health` — the liveness document the shell and the hook
 * clients probe.
 *
 * `instanceId` is the field that makes this answer "*which* core is this?"
 * rather than only "is something alive?". The shell compares it with the id its
 * own child announced; two builds of the same version are otherwise
 * indistinguishable, which is how a core from a previous session was once
 * adopted as the current one.
 *
 * The field list and their order are the Rust Runtime's, byte for byte
 * (the pre-merge implementation): the shell parses one document whichever
 * implementation wrote it, and `/api/health` is the older spelling the
 * launcher script still uses.
 */
export interface HookHealth {
  /** Absent when the hook service listens on no socket. */
  readonly sock?: string;
  /** Absent when it listens on no port. */
  readonly port?: number;
  /** The endpoint file exists and names this core. */
  readonly ok: boolean;
}

export interface HealthDocument {
  readonly status: "ok";
  readonly version: string;
  readonly instanceId: string;
  readonly build: string;
  readonly hook: HookHealth;
  /**
   * 这个 core 带了哪些要让页面知道的能力，追加在末尾。
   *
   * 页面光凭「有没有壳」判断不了所有事：服务器壳没有窗口，但如果 core 起得了
   * headless Chromium，浏览器节点照样能建。键名稳定、值只有布尔，旧页面不认
   * 的键直接忽略。
   */
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface HealthSource {
  readonly version: string;
  hookHealth(): HookHealth;
  /** 省略时一项能力都不报。 */
  capabilities?(): Readonly<Record<string, boolean>>;
}

/**
 * R0 has no hook service, so the section reports `ok: false` with neither
 * transport — which is exactly what it would report for a core whose endpoint
 * file does not name it. R3 replaces this with the real reconciliation.
 */
export const NO_HOOK_SERVICE: HookHealth = { ok: false };

export function healthDocument(source: HealthSource): HealthDocument {
  return {
    status: "ok",
    version: source.version,
    instanceId: instanceId(),
    build: BUILD,
    hook: source.hookHealth(),
    capabilities: source.capabilities?.() ?? {},
  };
}
