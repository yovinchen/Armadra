/**
 * `process.resourcesPath` 是 Electron 加在 `process` 上的字段。
 *
 * core 读它是为了在打好包的桌面壳里找暂存的资源，读法是「有就用，没有就往上
 * 找」——所以它在纯 Node 下本来就可能不存在。桌面壳那边这个声明由 electron 的
 * 类型带进来；服务器壳不依赖 electron，于是在这里按它真实的形状声明一次：
 * **可选**。这不是给 core 开的后门，core 一行都不 import electron
 * （`core/no-electron.test.ts` 扫这件事），这里声明的只是一个 Node 进程上可能
 * 有的字段。
 */
declare namespace NodeJS {
  interface Process {
    readonly resourcesPath?: string;
  }
}
