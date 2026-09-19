/**
 * 兼容垫片：会话令牌的持有者现在是 `api/identity.ts`。
 *
 * 还在用 `packages/host-client` 的那两个面（GitHub、自动化）通过
 * `onCsrfToken` 回调把令牌送进来，它们改打 JSON 面之后这个文件随之删除。
 */
export {
  onIdentitySessionChange as onHostSessionChange,
  rememberCsrf as rememberHostCsrf,
} from "../api/identity";
