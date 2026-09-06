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
    "updates.state.checking": "正在检查…",
    "updates.state.upToDate": "已是最新版本",
    "updates.state.available": "有新版本可用",
    "updates.state.unsupported": "未配置",
    "updates.state.unavailable": "无法确认",
    "updates.state.shellUnsupported": "此环境不能自动更新",
    "updates.state.downloading": "正在下载",
    "updates.state.downloaded": "已下载，重启后生效",
    "updates.state.failed": "更新失败",
    "updates.autoCheck": "自动检查更新",
    "updates.autoDownload": "自动下载更新",
    "updates.autoDownload.note":
      "打开后会在后台下载安装包，安装与重启仍需你确认。",
    "updates.notify": "下载完成后通知",
    "updates.notify.note":
      "关掉后只有托盘菜单里会出现「重启以完成更新」，不再发系统通知。",
    "updates.missing.pubkey": "此构建没有内置签名公钥，无法验证任何安装包。",
    "updates.missing.endpoints":
      "此构建没有内置发布地址；更新地址来自后台服务给出的同一次发布。",
    "updates.unsupported.notDesktop": "浏览器里的页面无法替换应用本体。",
    "updates.unsupported.remoteHost":
      "后台服务在另一台机器上，更新它不等于更新这里的应用。",
    "updates.unsupported.managedPackage":
      "此版本由包管理器安装，更新交给包管理器。",
    "updates.partial.hostNotChecked": "后台服务未给出结果。",
    "updates.partial.shellNotChecked": "桌面壳未检查。",
    "updates.progress": "已下载",
    "updates.retryAfter": "可在 {value} 分钟后重试。",
    "updates.checkedAt": "上次检查：{value}",
    "updates.downloaded.note":
      "重启后会安装新版本。终端会话会保留，自动化计划会暂停到重启完成。",
    "updates.action.cancel": "取消",
    "updates.action.download": "下载",
    "updates.action.skip": "跳过此版本",
    "updates.action.restart": "重启并更新",
    "updates.action.retry": "重试",
    "updates.action.notes": "查看发布说明",
    "updates.restart.completed": "已更新到 {value}。",
    "updates.restart.incomplete":
      "更新未完成：{value} 没有报告新版本。请从发布页手动安装，或回到上一版。",
    "updates.restart.previous": "上一版安装包",
    "updates.restart.dismiss": "知道了",
    /** 「应用本体、后台服务」里那个顿号；英文用逗号。 */
    "updates.listSeparator": "、",
    "updates.component.shell": "应用本体",
    "updates.component.host": "后台服务",
    "updates.component.runtime": "运行时",
    "updates.shellReason.sourceUnreachable": "无法读取发布来源。",
    "updates.shellReason.sourceMalformed": "发布来源的内容与本版本对不上。",
    "updates.shellReason.compatibilityRefused":
      "新版本不接受当前安装的版本，因此不会提供升级。",
    "updates.shellReason.noArtifactForTarget":
      "这次发布没有适用于本平台的安装包。",
    "updates.shellReason.signatureMismatch":
      "安装包的签名不是本机公钥签的，已拒绝。",
    "updates.shellReason.digestMismatch":
      "下载到的字节与发布公布的摘要不一致，已丢弃。",
    "updates.shellReason.downloadInterrupted": "下载中断，已丢弃，可重试。",
    "updates.shellReason.diskFull": "磁盘空间不足，无法暂存安装包。",
    "updates.shellReason.hostStopFailed":
      "本应用启动的后台服务没有停止，因此没有开始安装。",
    "updates.shellReason.installFailed": "安装失败，当前版本没有被替换。",
    "updates.shellReason.updaterUnavailable": "此构建的更新器不可用。",
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
    "updates.blocked.nativeSession":
      "桌面壳未能建立本机会话，原因见「后台服务」设置。",
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
    "updates.state.checking": "Checking…",
    "updates.state.upToDate": "This is the newest release",
    "updates.state.available": "A newer release is available",
    "updates.state.unsupported": "Not configured",
    "updates.state.unavailable": "Could not be confirmed",
    "updates.state.shellUnsupported": "This build cannot update itself",
    "updates.state.downloading": "Downloading",
    "updates.state.downloaded": "Downloaded; restart to apply",
    "updates.state.failed": "The update failed",
    "updates.autoCheck": "Check automatically",
    "updates.autoDownload": "Download automatically",
    "updates.autoDownload.note":
      "Downloads the package in the background. Installing and restarting still need your confirmation.",
    "updates.notify": "Notify when downloaded",
    "updates.notify.note":
      "With this off, only the tray menu offers \u201cRestart to finish updating\u201d; no system notification is sent.",
    "updates.missing.pubkey":
      "This build carries no signing key, so it could not verify any package.",
    "updates.missing.endpoints":
      "This build carries no release address; the manifest comes from the release the background service describes.",
    "updates.unsupported.notDesktop":
      "A page in a browser cannot replace the application itself.",
    "updates.unsupported.remoteHost":
      "The background service runs on another machine; updating it is not updating this application.",
    "updates.unsupported.managedPackage":
      "A package manager installed this build and updates it.",
    "updates.partial.hostNotChecked": "The background service did not answer.",
    "updates.partial.shellNotChecked": "The desktop shell did not check.",
    "updates.progress": "Downloaded",
    "updates.retryAfter": "You can try again in {value} minutes.",
    "updates.checkedAt": "Last checked: {value}",
    "updates.downloaded.note":
      "Restarting installs the new version. Terminal sessions are kept; automation is paused until the restart finishes.",
    "updates.action.cancel": "Cancel",
    "updates.action.download": "Download",
    "updates.action.skip": "Skip this version",
    "updates.action.restart": "Restart and update",
    "updates.action.retry": "Try again",
    "updates.action.notes": "Read the release notes",
    "updates.restart.completed": "Updated to {value}.",
    "updates.restart.incomplete":
      "The update did not finish: {value} did not report the new version. Install it by hand from the release page, or go back to the previous one.",
    "updates.restart.previous": "Previous release package",
    "updates.restart.dismiss": "Dismiss",
    "updates.listSeparator": ", ",
    "updates.component.shell": "the application",
    "updates.component.host": "the background service",
    "updates.component.runtime": "the runtime",
    "updates.shellReason.sourceUnreachable":
      "The release source could not be read.",
    "updates.shellReason.sourceMalformed":
      "What the release source published does not match this version.",
    "updates.shellReason.compatibilityRefused":
      "The newer release does not accept this installed version, so it is not offered.",
    "updates.shellReason.noArtifactForTarget":
      "This release publishes no package for this platform.",
    "updates.shellReason.signatureMismatch":
      "The package is signed by a key this build does not carry. It was refused.",
    "updates.shellReason.digestMismatch":
      "The bytes that arrived are not the ones the release published. They were discarded.",
    "updates.shellReason.downloadInterrupted":
      "The download stopped early and was discarded. You can try again.",
    "updates.shellReason.diskFull":
      "There was not enough room to stage the package.",
    "updates.shellReason.hostStopFailed":
      "The background service this application started would not stop, so the install never began.",
    "updates.shellReason.installFailed":
      "The install failed; the running version was not replaced.",
    "updates.shellReason.updaterUnavailable":
      "This build's updater is unusable.",
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
    "updates.blocked.nativeSession":
      "The desktop shell could not open a local session; see the Background service settings.",
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
