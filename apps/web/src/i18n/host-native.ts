import type { MessageModule } from "./index";

/** 桌面壳取不到本机会话票据时的原因（桌面壳原生 Host 会话 §4.3）。 */
export const hostNative: MessageModule = {
  "zh-CN": {
    "hostNative.blocked.hostUnavailable":
      "后台服务尚未就绪，桌面壳还没有发现它；稍后重试，或在「后台服务」检查连接。",
    "hostNative.blocked.originUnsupported":
      "当前页面不是桌面壳的原生来源，无法自动登录后台服务。",
    "hostNative.blocked.cliFailed":
      "桌面壳向后台服务申请本机票据失败；请重启应用后再试。",
    "hostNative.blocked.timeout": "桌面壳申请本机票据超时，请稍后重试。",
    "hostNative.blocked.malformed":
      "桌面壳返回的本机票据无法验证；请重启应用后再试。",
    "hostNative.blocked.shellUnavailable":
      "桌面壳没有响应取票请求，无法自动登录后台服务。",
  },
  en: {
    "hostNative.blocked.hostUnavailable":
      "The background service is not ready yet and the desktop shell has not found it. Try again shortly, or check the connection under Background service.",
    "hostNative.blocked.originUnsupported":
      "This page is not the desktop shell's native origin, so it cannot sign in to the background service automatically.",
    "hostNative.blocked.cliFailed":
      "The desktop shell could not obtain a local ticket from the background service. Restart the app and try again.",
    "hostNative.blocked.timeout":
      "The desktop shell timed out obtaining a local ticket. Try again later.",
    "hostNative.blocked.malformed":
      "The desktop shell returned a local ticket that could not be verified. Restart the app and try again.",
    "hostNative.blocked.shellUnavailable":
      "The desktop shell did not answer the ticket request, so automatic sign-in to the background service is unavailable.",
  },
};
