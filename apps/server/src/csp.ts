import { contentSecurityPolicy } from "../../desktop/src/shell-core/csp";

/**
 * 页面的 Content-Security-Policy，与桌面壳**同一个来源**。
 *
 * 策略本体不在这里：它是 `apps/desktop/src/shell-core/csp.ts` 的那一份纯函数
 * （不 import electron，所以服务器壳可以直接用）。这里只做一件事——把其中的
 * 回环授权摘掉。
 *
 * 为什么必须摘：桌面壳的页面和 core 都在回环上，`connect-src` 里那几条
 * `http://127.0.0.1:*` 就是页面访问 core 的授权。服务器壳的页面和 core 在
 * **同一个 HTTPS 来源**上，`'self'` 已经覆盖了 `https` 与 `wss` 两种连接；继续
 * 带着回环授权，等于允许这张页面去连**观看者那台设备**上的任意本地端口，而那
 * 是一台服务器壳从来不该代表页面碰的机器。
 *
 * 其余每一条（`default-src`、`style-src`、`frame-ancestors 'none'`、
 * `object-src 'none'`、`base-uri`、`form-action`）逐字继承，所以桌面壳那边收紧
 * 了什么，这边自动跟着收紧——单测盯的就是这条继承关系。
 */

/** 摘掉的授权：回环的 http / ws 字面量。 */
const LOOPBACK = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\*)?$/;

export function serverContentSecurityPolicy(): string {
  return contentSecurityPolicy()
    .split("; ")
    .map((directive) => {
      const tokens = directive.split(" ");
      const kept = tokens.filter(
        (token, index) => index === 0 || !LOOPBACK.test(token),
      );
      return kept.join(" ");
    })
    .join("; ");
}
