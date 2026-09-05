import type { MessageModule } from "./index";

/**
 * 设置 → 更新（画布平台设计 §3 S03 / 路线图 §3.12）。
 *
 * 这一页只说得出它真的问到的结果：没有配置发布来源、或者本机没有签名公钥
 * 时，写「未配置」而不是「已是最新」——没去看和看过没有新版本是两回事。
 */
export const updates: MessageModule = {
  "zh-CN": {
    "updates.nav": "更新",
    "updates.note":
      "只查询是否有新版本，不会下载或安装。安装需要带签名的发布包，由你自己决定何时进行。",
    "updates.version": "当前版本",
    "updates.version.unknown": "未知",
    "updates.channel": "更新通道",
    "updates.channel.stable": "稳定版",
    "updates.channel.beta": "测试版",
    "updates.channel.development": "本地构建",
    "updates.channel.unspecified": "未指定",
    "updates.channel.consulted": "本次查询的通道",
    "updates.check": "检查更新",
    "updates.checking": "正在检查…",
    "updates.status": "检查结果",
    "updates.state.idle": "尚未检查更新",
    "updates.state.upToDate": "已是最新版本",
    "updates.state.available": "有新版本可用",
    "updates.state.unsupported": "未配置",
    "updates.state.unavailable": "无法确认",
    "updates.release": "新版本",
    "updates.release.notes": "查看发布说明",
    "updates.release.size": "安装包大小",
    "updates.signature": "签名",
    "updates.signature.present": "发布包附带签名，由安装程序验证",
    "updates.signature.absent": "发布包没有附带签名",
    "updates.signature.unconfigured": "本机没有配置公钥，无法验证任何签名",
    "updates.install.manual":
      "本版本不自动下载或安装。请按发布说明手动获取并安装。",
    "updates.reason.UPDATES_NOT_CONFIGURED":
      "后台服务没有配置发布来源，因此没有查询任何地方。",
    "updates.reason.SOURCE_UNREACHABLE": "无法读取发布来源，请稍后重试。",
    "updates.reason.SOURCE_MALFORMED": "发布来源返回的内容无法解析。",
    "updates.reason.COMPATIBILITY_REFUSED":
      "存在更新的发布，但它不接受当前版本，因此不会提供升级。",
    "updates.reason.NO_ARTIFACT_FOR_TARGET":
      "更新的发布没有适用于本平台的安装包。",
    "updates.reason.CHANNEL_NOT_UPDATABLE":
      "本地构建或旁载的版本不参与自动更新。",
    "updates.reason.unknown": "后台服务给出了本版本不认识的原因。",
    "updates.blocked.tlsRequired":
      "更新检查需要通过后台服务的 HTTPS 地址访问。",
    "updates.blocked.sameOrigin":
      "当前页面来源与后台服务地址不一致，无法使用已登录的会话。",
    "updates.blocked.disconnected": "无法连接后台服务。",
    "updates.blocked.noSession": "此后台服务版本不支持浏览器会话登录。",
    "updates.blocked.signedOut": "此设备尚未登录后台服务。",
    "updates.blocked.noPermission": "此设备没有读取更新信息的权限。",
    "updates.blocked.action": "前往后台服务设置",
    "updates.error.network": "请求未能完成，请稍后重试。",
    "updates.error.unauthenticated": "登录已失效，请重新登录后再试。",
    "updates.error.permission": "此设备没有读取更新信息的权限。",
    "updates.error.unsupported": "此后台服务不提供更新检查。",
    "updates.error.invalid": "更新检查请求无效。",
    "updates.error.response": "后台服务的回复无法解析。",
    "updates.error.cancelled": "检查已取消。",
    "updates.error.notFound": "此后台服务没有更新检查接口。",
    "updates.error.conflict": "更新信息已变化，请重新检查。",
    "updates.error.unknownOutcome": "请求结果未知，请重新检查。",
  },
  en: {
    "updates.nav": "Updates",
    "updates.note":
      "This only asks whether a newer release exists. Nothing is downloaded or installed; installing needs a signed package and stays your decision.",
    "updates.version": "Current version",
    "updates.version.unknown": "Unknown",
    "updates.channel": "Release channel",
    "updates.channel.stable": "Stable",
    "updates.channel.beta": "Beta",
    "updates.channel.development": "Local build",
    "updates.channel.unspecified": "Unspecified",
    "updates.channel.consulted": "Channel consulted",
    "updates.check": "Check for updates",
    "updates.checking": "Checking…",
    "updates.status": "Result",
    "updates.state.idle": "Not checked yet",
    "updates.state.upToDate": "This is the newest release",
    "updates.state.available": "A newer release is available",
    "updates.state.unsupported": "Not configured",
    "updates.state.unavailable": "Could not be confirmed",
    "updates.release": "New release",
    "updates.release.notes": "Read the release notes",
    "updates.release.size": "Package size",
    "updates.signature": "Signature",
    "updates.signature.present":
      "The release ships a signature; the installer verifies it",
    "updates.signature.absent": "The release ships no signature",
    "updates.signature.unconfigured":
      "No public key is configured here, so nothing could be verified",
    "updates.install.manual":
      "This build neither downloads nor installs updates. Follow the release notes to install one yourself.",
    "updates.reason.UPDATES_NOT_CONFIGURED":
      "The background service has no release source configured, so nothing was consulted.",
    "updates.reason.SOURCE_UNREACHABLE":
      "The release source could not be read. Try again later.",
    "updates.reason.SOURCE_MALFORMED":
      "The release source returned something that could not be parsed.",
    "updates.reason.COMPATIBILITY_REFUSED":
      "A newer release exists but does not accept this installed version, so it is not offered.",
    "updates.reason.NO_ARTIFACT_FOR_TARGET":
      "The newer release ships no package for this platform.",
    "updates.reason.CHANNEL_NOT_UPDATABLE":
      "A locally built or side-loaded build never auto-updates.",
    "updates.reason.unknown":
      "The background service gave a reason this version does not recognize.",
    "updates.blocked.tlsRequired":
      "Update checks need the background service's HTTPS address.",
    "updates.blocked.sameOrigin":
      "This page origin differs from the background service address, so the signed-in session cannot be used.",
    "updates.blocked.disconnected": "Cannot reach the background service.",
    "updates.blocked.noSession":
      "This background service version does not support browser sessions.",
    "updates.blocked.signedOut":
      "This device is not signed in to the background service.",
    "updates.blocked.noPermission":
      "This device is not allowed to read update information.",
    "updates.blocked.action": "Open background service settings",
    "updates.error.network": "The request did not complete. Try again later.",
    "updates.error.unauthenticated":
      "The session expired. Sign in again and retry.",
    "updates.error.permission":
      "This device is not allowed to read update information.",
    "updates.error.unsupported":
      "This background service does not offer update checks.",
    "updates.error.invalid": "The update request was not valid.",
    "updates.error.response":
      "The background service's answer could not be parsed.",
    "updates.error.cancelled": "The check was cancelled.",
    "updates.error.notFound":
      "This background service has no update check method.",
    "updates.error.conflict": "Update information changed. Check again.",
    "updates.error.unknownOutcome": "The result is unknown. Check again.",
  },
};
