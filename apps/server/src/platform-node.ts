import type { CoreLog, CorePlatform } from "../../desktop/src/core/platform";

/**
 * `CorePlatform` 的服务器实现。
 *
 * core 与壳之间只有这一条缝，而服务器壳能填的比桌面壳少三样，每一样都是**明确
 * 的缺席**而不是一个悄悄的空实现：
 *
 *   * **没有 `safeStorage`**。`sealSecret` / `unsealSecret` 两个都不提供（成对
 *     可选，缺其一是编程错误），core 因此落到已有的那条路径：凭据降级为数据
 *     目录下的 0600 文件，并在设置页标注「已降级」。服务器上没有登录会话持有的
 *     钥匙串，假装有一个才是错的。
 *   * **没有 `resourcesPath`**。没有应用包，迁移目录与静态资源都从检出或部署
 *     目录里找。
 *   * **`openExternal` 是 no-op**。无头机器上没有「打开一个链接」这件事；调用
 *     方拿到的是一个成功的 Promise 和一条日志，因为让它抛异常会把「这台机器
 *     没有浏览器」变成一次业务失败。
 *
 * `notify` 同理落日志：托盘通知与更新提示在服务器上没有收件人。
 */

export interface ServerPlatformOptions {
  readonly dataDir: string;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly log: CoreLog;
}

export function serverPlatform(options: ServerPlatformOptions): CorePlatform {
  const { log } = options;
  return {
    dataDir: options.dataDir,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged,
    // 明确的 undefined：没有应用包，就没有资源目录。
    resourcesPath: undefined,
    log,
    openExternal: (url: string) => {
      log.info("服务器壳没有可以打开链接的桌面，已忽略", { url });
      return Promise.resolve();
    },
    notify: (channel: string, payload: unknown) => {
      log.info("notify", { channel, payload });
    },
  };
}
