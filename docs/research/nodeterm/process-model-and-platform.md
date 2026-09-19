# nodeterm 的进程模型与平台抽象层

> 只读分析。参考项目在 `/Users/yovinchen/Projects/Rust/Tauri/nodeterm`（Electron + React + React Flow），
> 行号对应克隆时的工作树；Armadra 侧引用 `feature/host-protocol-foundation`。

## 结论

nodeterm 的进程模型不是「Electron 三件套」的默认样子，而是围绕一条**平台缝（`CorePlatform`）**组织的：
业务逻辑全在 `src/core/`，一条源码扫描测试禁止它 import `electron`；Electron main、Linux 服务器版、
iOS 伴侣三个壳各自实现同一个 seam。对 Armadra 迁移最有价值的三点：

1. **seam 的纪律，而不是 seam 的体量**。Armadra 的业务在 Rust Runtime 里，不需要照抄 `src/core` 的规模，
   但需要照抄「一条扫描测试把壳专有能力和可移植逻辑钉死在两侧」。Armadra 已有的
   `apps/web/src/platform/index.ts`（`isTauri() ? 桌面分支 : web 回退`）就是同一条缝，只是没有测试守住。
2. **自定义协议 + 回环转发可以整体删掉**。Tauri 的 `armadra://`、`__armadra/transport` 端口发布、
   以及由 `tauri://localhost` 这个非 HTTP 来源逼出来的「原生会话票据」整条链路，
   在 Electron 里被普通 `http://127.0.0.1` 来源取代。诊断桥同理（打包 WKWebView 没有开发者工具）。
3. **子进程监管与更新状态机必须原样保留**。nodeterm 的 `updater.ts` 只有 149 行，是因为它没有
   Armadra「先停 Host 再装」的约束；Armadra 的 `updates::machine` 十一态语义是自己挣来的，
   应整段移植成 TypeScript，而不是退回 electron-updater 的默认生命周期。

---

## 1. Electron 三上下文的职责划分

### 边界

`CLAUDE.md:101-160` 把五个目录钉死：`src/main/` 是 `src/core/` 的**壳**（窗口、IPC 接线、对话框、
`CorePlatform` 实现），渲染进程绝不能 import；`src/core/` 是 **Electron-free 服务核**
（pty、workspace/settings store、git、hook server、转录、license），只经 `CorePlatform` 与壳说话；
`src/server/` 是服务器版壳，复用同一份 core；`src/preload/` 是**唯一的桥**；`src/shared/` 放三边共享的
类型与通道名，且 `ipc.ts` 是通道字符串的**唯一真相**（CLAUDE.md:157-159）。

### 通道命名与类型安全

通道是 `域:动作` 的扁平字符串，集中在 `src/shared/ipc.ts`（579 行，每条带注释说明方向与语义），
如 `ptyCreate: 'pty:create'`、`ptyWrite: 'pty:write'`（`ipc.ts:3-9`）。PTY 输出是**每会话一条通道**
（`pty:data:<sessionId>`，main → renderer），输入统一走 `pty:write`（CLAUDE.md:153-156）——
这样渲染端每个终端只挂一个监听器，而不是在总线上按 sessionId 过滤。

类型安全靠三层，而非泛型 IPC 封装：① 通道名只从 `IPC` 常量取；② preload 的对象声明为
`const api: NodeTerminalApi`（`preload/index.ts:75`），该类型在 `shared/types.ts`，
渲染端与服务器版 bridge 共用；③ `preload/index.d.ts` 全文 9 行，把 `window.nodeTerminal` 挂进全局。
服务器版的 `renderer/bridge/ws-bridge.ts` 用 `satisfies NodeTerminalApi` 做同一个门——
CLAUDE.md 的 Conventions 段落明确指出这个门**强制你声明每个成员**，
但 `noopUnsub`/`unsupported` 桩也能编译通过，所以要逐成员做决定。

### preload 暴露什么

`preload/index.ts:1` 只 import `contextBridge, ipcRenderer, webFrame, webUtils`，
暴露面是按域分组的方法对象（`pty`、`updates`、`workspace`、`agentMessage`…），
末行 `contextBridge.exposeInMainWorld('nodeTerminal', api)`（`preload/index.ts:811`）。
事件订阅做了 **fan-out 去重**：

```ts
// src/preload/index.ts:26-32
function subscribe<A extends unknown[] = []>(channel: string) {
  const listeners = new Set<(...args: A) => void>()
  let handler: ((e: unknown, ...args: A) => void) | null = null
  return (listener: (...args: A) => void): (() => void) => {
    if (!handler) {
      handler = (_e, ...args) => listeners.forEach((l) => l(...args))
      ipcRenderer.on(channel, handler)
```

动机在注释里：没有它，每个订阅的节点各挂一个 `ipcRenderer` 监听器，超过 10 个就触发
Node 的 MaxListeners 警告。Armadra 的画布同样是「N 个节点订阅同一类事件」，直接适用。

### 渲染进程被禁止做什么

窗口创建处（`main/index.ts:948-961`）：`contextIsolation: true`、`nodeIntegration: false`、
`sandbox: false`（preload 需要 `webUtils`）、`webviewTag: true`（WebNode 用）、`plugins: true`
——注释专门澄清这不是老 NPAPI 面，当代 Electron 里它只开 Chromium 内置 PDF 查看器，
没有它 EditorNode 打开 `.pdf` 会全白。另外两条：**剪贴板写入在主进程做**
（`main/index.ts:1445`，renderer/preload 的 `clipboard` 已废弃）；**`env:snapshot` 只对桌面窗口开放**，
用裸 `ipcMain.handle` 而非 `platform().handle`（`ipc.ts:68-76`），理由是「一个可被远端 peer 调用的
全量 env dump 正是 PR #195 关掉的凭据泄露类漏洞」。这条被提升为不变式（`platform-electron.ts:46-52`）：

> 一个通道**当且仅当**经 `platform().handle/on` 注册时，才可被远端 peer 触达。
> 核心相关（fs/git/pty/workspace/转录）→ platform；作用于用户本机或涉及宿主安全
> （对话框、shell、通知、更新器、配对控制面）→ 故意用裸 `ipcMain`。

---

## 2. `CorePlatform`：让 `src/core` 不碰 electron 的那道缝

`src/core/platform.ts` 全文 57 行，接口 36 行（`platform.ts:6-42`）：只读的
`userDataDir / appVersion / isPackaged / resourcesPath?`、可选的 `sealSecret? / unsealSecret?`、
四个注册方法（`handle / on / handleWithSender / onWithSender`）、三个发送方法
（`sendTo / broadcast / clientIds`）与 `openExternal`。三处设计值得抄：

- **可选成员的语义是「支持的配置」，不是「降级」**。`resourcesPath` 可选，因为它是 Electron 概念，
  服务器版没有这个目录（`platform.ts:11-15`）；`sealSecret`/`unsealSecret` **要么都给要么都不给**，
  只给一个是编程错误并被 `node-auth-secret.ts` 拒绝（`platform.ts:16-22`）——
  服务器版无 OS keychain，故意用 0600 裸字节存。
- **`clientIds()` 存在是为了表达 broadcast 表达不了的「除发送者外的所有人」**（`platform.ts:36-39`）。
- **单例 + 显式初始化**：`initPlatform()` / `platform()` / `resetPlatformForTests()`，
  未初始化时抛 `core platform not initialized — call initPlatform() at boot`。
  主进程第一件事就是装它（`main/index.ts:317-322`，且必须在 `NT_MULTI` 的 userData 覆盖之后，
  这样 `userDataDir` 读到的是最终路径）。

### 缝是怎么被守住的

`src/core/no-electron.test.ts` 不是类型检查，是**源码扫描**（50 行）：

```ts
// src/core/no-electron.test.ts:14-15
const OFFENDERS =
// src/core/no-electron.test.ts:14-15（摘录为文字，原文是一条正则）
// OFFENDERS 同时命中三类：from/require 裸 "electron"、"electron/<子路径>"、
// 以及任意层 "../" 前缀后跟 "main/" 的反向引用
```

同时拦三类：裸 `electron`、`electron/main` 子路径、任何 `../main/` 反向引用。
更值得学的是**第二个测试用例**（`no-electron.test.ts:26-48`）：把 5 个必须命中的样本和
5 个不得命中的样本（含 `electron-builder`）写进测试，**证明正则本身是对的**。
`src/server/no-electron.test.ts` 是它的服务器版孪生。

### Electron 实现里的两个扩展

`ElectronPlatform extends CorePlatform` 多了 `dispatch` 和 `cast`（`platform-electron.ts:23-30`），
因为「core 从不派发，只有持有 socket 的壳才派发」。每次注册都**同时**写进本地 handler 表和
`ipcMain`（`:86-101`：`handlers.set(ch, …)` 紧跟 `ipcMain.handle(ch, (_e, ...args) => fn(...args))`），
远端 peer 的请求由 `dispatch` 从这张表作答，本地窗口的调用则与改造前逐位相同。
`sendTo` 先查 peer 注册表再落回 `webContents.fromId`（`:159-169`），peer id 从 1_000_000 起分配，
永不与 webContents id 冲突。注释给出了成本承诺：**SOLO COST: zero**——没有 peer 时注册表是空 Map，
`broadcast` 里 `if (peers.size === 0) return`，走的是改造前逐字节相同的代码路径（`:42-44`、`:175`）。

### 测试用 fake platform

`platform-fake.ts` 63 行，是**纯记录对象**，不是 mock 库：`handlers / listeners / sent / opened /
clients` 都可直接断言（`:6-14`）。`userDataDir` 默认一次 `mkdtempSync` 而非写死路径（`:18-26`）：
曾经是 `/tmp/nodeterm-test`，两个并行测试文件共享一个目录会互相覆盖，而且所有经
`platform().userDataDir` 的生产写入**在静态阅读上都像写向可预测临时路径**，
被 CodeQL 判为 `js/insecure-temporary-file`。

---

## 3. 状态与持久化

持久化分两层（CLAUDE.md:207-209）：**布局+配置**（schema v3）与**活的终端会话**（tmux）。
v3 把 `userData` 下的 `workspace.json` 变成一张**索引**，三种 ref 一个形状（CLAUDE.md:216-222）：
`folder-ref` 内容在 `<cwd>/.nodeterm/project.json`（git 共享）、`ssh-ref` 在服务器同一文件
（索引里带离线 `cache`，按 rev 对账）、`local-data-ref` 在 `userData/inline-projects/<id>.json`。

分工规则是关键（CLAUDE.md:223-226、290-296）：**共享文件只装内容，不装身份**——
没有 project `id`、没有 `viewport`、没有 `defaultAccountId`，这些是本机的、跟着索引条目走。
于是同一份 canvas 的两个 worktree 是两个独立项目，而提交进 git 的文件在每台机器上字节相同。
代码切分为 `core/workspace-store.ts`（1922 行，有 I/O）+ 纯函数 `core/workspace-files.ts`（692 行），
渲染端契约不变（`workspace.load()/save()` 仍说 v2 形状）。

**迁移策略**四条可直接搬：① v2 → v3 在首次保存时迁移，留 `workspace.v2.bak` 并给渲染端一次性提示；
② 损坏文件挪到一边而非删除（`project.json.corrupt-<ts>`），读不出的 ref 渲染成**灰掉的 unavailable
标签页，永不丢弃**；③ **rev 单调 + 低 rev 不得覆盖高 rev**（`workspace-store.ts:125` 的 `revs` 表），
承诺写得很克制——保证是「两个实例不会互相抹掉」，**不是**「两个实例保持同步」，且**故意不做合并**；
④ 空候选永不覆盖已填充的文件，未读过的文件永不盲写，且 `projectFileState` 报
`present | absent | unreadable`，**只有明确的 ENOENT 才算缺失**——「读失败从来不是不存在的证据」
（CLAUDE.md:280-284）。

配置迁移用**一次性标记位**而非版本号（`settings-store.ts:44-58`）：`openMarkdownPreviewMigrated`
一旦写入，用户的取消就是永久的；判定**键在已保存文件里是否缺失**，而不是看合并后的值。
另有嵌套对象需一层深合并的理由（`:8-15`）：浅合并会让旧的 `speech` 对象整个盖掉默认对象，
静默吃掉新加的键。

### 原子写

CLAUDE.md:3181-3216 与 `core/fs-atomic.ts:1-47` 是全仓最值得读的动机说明：temp-file-then-rename
在 POSIX 上正确，在 **Windows 上静默丢数据**——只要目标此刻被任何人打开，`MoveFileEx` 就返回 `EPERM`，
而打开你刚写的文件的，正是 Defender 实时扫描、搜索索引器、同步中的 OneDrive，
或我们自己两个并发写者。保存抛错，数据没了：间歇、不可复现，**而且在防护最好的机器上更常发生**。

`renameAtomic` / `writeFileAtomic` 做**有界重试**（5 次约 310ms，`:59-60`），并明确列出**不做什么**
（`:41-47`）：不无限重试（若干调用方的 `persisted:false` 契约优先于「最终会落盘」）、
不重试 `ENOENT`/`ENOSPC`、不按平台分支（否则 Mac 上测的不是 Windows 上跑的）、绝不吞掉最后的错误。

最关键的是**执行方式**：`core/fs-atomic.guard.test.ts` 扫描源码，对 helper 之外的任何裸 `fs.rename`
失败。动机（CLAUDE.md:3202-3208）：28 个文件、三种写法全中招，每处读起来都像正确的原子写；
6000 个测试里唯一的信号是某个 store 的并发保存测试在 Windows 上红了它整个生命周期。
结论一句话——**a comment cannot propagate**，注释只保护它所在的那个文件。

密钥层是一个 7 行接口（`core/secret-store.ts`），
`availability: 'encrypted' | 'restricted-file' | 'unavailable'`
把「有没有 keychain」做成可报告的状态而不是异常。

---

## 4. 打包与更新

**构建**：`electron.vite.config.ts` 76 行，三个 target。两个关键决定（`:18-30`）——
`external: ['electron', /^node-pty/, 'node-pty']`，因为 `electron` 是 devDependency，
`externalizeDepsPlugin`（只读 `dependencies`）不会外置它，npm 包装器会被打进包里导致运行时去下载
Electron；node-pty 是原生模块，内部 require 的相对路径被打包后会断。以及 `format: 'cjs'` +
`entryFileNames: '[name].js'`：electron-vite v5 默认 ESM（`.mjs`），但 asar 打包的主进程入口必须是 CJS。
preload 有**两个入口**（`index` 与 macOS 刘海 HUD 的 `hud`），renderer 相应两个 HTML 入口。

**electron-builder**（`package.json` 的 `build` 块）：`appId com.nodeterm.app`；
`files` 只有 `out/**/*` 与 `package.json`；`asarUnpack` 列出 `node-pty`、`smart-whisper`、
`sharp`、`@img`；mac 为 dmg+zip × arm64/x64，`hardenedRuntime: true`、`notarize: true`、
`entitlements: build/entitlements.mac.plist`；win 为 NSIS + zip；
`publish: { provider: 'generic', url: 'https://nodeterm.dev/updates' }`。
mac 的 `extraResources` 打包了**自带的 tmux 二进制**——这正是 `CorePlatform.resourcesPath`
存在的理由（`platform.ts:11-15`）。

**`build.mac.extendInfo` 缺一条权限声明会静默拒绝**（CLAUDE.md:3134-3155），是整段里最贵的经验：
macOS 15+ 对本机子网的访问按「负责进程」归属，nodeterm 启动的 tmux / shell / agent CLI 全算
nodeterm.app。没有 `NSLocalNetworkUsageDescription` 就没有可供提示的字符串，系统**从不询问**，
隐私设置里**连一行都不出现**，用户无从授予：agent 访问 LAN 地址拿到 `EHOSTUNREACH`，
而同一秒 Apple 签名豁免的 `/usr/bin/curl` 能通——一次权限失败伪装成网络故障（issue #589）。
同时点名旁边的陷阱 `NSBonjourServices`：它只用于**浏览** mDNS 服务，本应用不做，
声明从不浏览的服务类型是对用户和审核的虚假声明。这份 plist 由 `main/info-plist.test.ts`
以「带理由的允许清单」方式守住。

**更新**（`main/updater.ts`，149 行）：`initUpdater(onBeforeRestart?)` **只在 `app.isPackaged` 时启用**，
启动时检查 + 每 6 小时（`:143-148`）；版本查询、手动检查、重启三条在 dev 也可用（`:67-72`）；
完整生命周期转发到渲染端。两个决定带明确权衡：

- **本地打包的构建带 `nodeTermUpdates` 标记**（`dist*` 脚本经 `extraMetadata` 注入，`:24-37`）。
  理由：本地包在运行时与正式版**无法区分**，`app.isPackaged` 都是 true，于是它轮询生产 feed 上
  根本没发布过的版本，每 6 小时记一条 `latest*.yml` 的 404。代价也写明：本地包从此**无法自测更新接线**。
- **Linux `.deb/.rpm`（无 `APPIMAGE` 环境变量）不能自安装**，降级为手动下载链接（`:81-87`），
  否则每 6 小时重下整个 AppImage 再在安装时抛错。

两个反复出现的 Electron 陷阱各踩一次：**窗口在事件发生时才解析，绝不捕获进闭包**
（`updater.ts:52-63`）——macOS 上窗口可关闭而应用仍在、再从 dock 重建，捕获的引用是已销毁窗口，
碰它抛 `TypeError: Object has been destroyed`，这个 bug 上过线；以及 **Electron 会 GC 掉
没人引用的 `Notification`**（`notifications.ts:1-4`，electron/electron#16922）——通知照样显示，
但包装器一被回收 `click` 处理器就没了，`retainUntilDismissed()` 把每条已显示通知留在 `Set` 里
直到 OS 报告消失，上限 50 条以防 macOS 把通知停在通知中心却从不发 `close`。

**原生模块**：`npm run rebuild` = `node scripts/patch-node-pty.mjs && electron-rebuild -f -w
node-pty,smart-whisper`。`patch-node-pty.mjs`（603 行）是**版本钉死的本地补丁**，
在 electron-rebuild 编译前改 `node_modules`，两个补丁都带实测数据（`:6-45`）：macOS 的 fd 泄漏
（已提上游 issue #950），失败的 spawn 漏掉 master+slave，成功的 spawn 因
`for (; count > 0; count--) close(low_fds[count]);` 这个 off-by-one 每次漏一个 ptmx 设备——
实测正常 park/离屏/回收+重连的抖动约 **16 次成功 spawn/分钟**，几小时内撞上 `kern.tty.ptmx_max`
（该机 511），之后每次 pty spawn 都报 `posix_spawnp failed.`；以及 Windows ConPTY 的
baton/HPCON 竞态（调用方先杀进程树时退出线程赢得竞态，留下 conhost 直到整个 session-host 退出）。

**签名/公证**：mac 走 electron-builder 的 `hardenedRuntime` + `notarize`，
**生产签名与更新 feed 托管在仓库之外**；Windows 目前**未签名 beta**（无证书时 electron-builder
跳过签名，SmartScreen 会警告），且 `dist:win` 把 `nodeTermUpdates=disabled` 打进包里让更新器
干净地关掉——没有 `latest.yml`，就没有 404 轮询（CLAUDE.md:3112-3131）。
文档明确写了先后顺序：**先签名，再接 Windows 自动更新**，因为未签名的自动更新是信任上的倒退。

---

## 5. 窗口与系统集成

**`main-window.ts`（93 行）只为一条不变式存在**（`:1-6`）：主进程里每个向渲染端推 IPC 的地方，
都必须在**发送时**经 `getMainWindow()`/`sendToMain()` 解析窗口，绝不在初始化时把 `BrowserWindow`
捕获进闭包。macOS 上窗口可关闭（应用还活着）并从 dock 重建，捕获的引用指向已销毁窗口，
每次发送被静默丢弃——**这个 bug 上过线：close→reopen 之后 agent 状态徽标就死了**。
其余都是可脱离 Electron 单测的纯函数：`MainWindowLike` 是 `BrowserWindow` 的结构化视图（`:9-20`）；
`createCrashReloadPolicy()`（`:55-68`）给渲染端崩溃做有界自动重载（默认 60 秒内最多 2 次），
`clean-exit` 永不重载，否则启动路径上的崩溃会无限重载；`closeAction()`（`:86-93`）在 macOS 上
关闭即隐藏，且**全屏窗口必须先退出全屏再隐藏**，否则留下一个用户还能划过去的黑屏 Space
（issue #78 / electron/electron#20263）。`window-chrome.ts` 只有 17 行，把
`titleBarStyle: 'hiddenInset'` + `trafficLightPosition` 收进一个 macOS-only 函数，
理由是 issue #564：渲染端曾经在 Windows 上也预留交通灯的空位。

**`media-protocol.ts`（198 行）—— 自定义协议怎么做**。`nt-media://` 是给本地视频与大图的
特权流式协议，核心是**路径监狱**。两阶段注册：`registerMediaScheme()` 必须在 `app.whenReady()`
**之前**调用（`:135-144`，`registerSchemesAsPrivileged` 声明 `standard/secure/supportFetchAPI/stream`，
`bypassCSP: false`），在 `main/index.ts:676` 于模块顶层执行；`initMediaProtocol()` 在 ready 之后
装请求处理器。三道闸：① **会话级允许清单**（`allowed: Set<string>`，`:10`），注册本身是
「渲染端可信」的（与已有 `fs:read-binary` IPC 同一信任边界），真正的边界是服务时的词法监狱
+ 符号链接检查（`:70-75`）；② **符号链接监狱**用 `lstat`（不跟随最后一段），一次调用同时完成监狱
检查和取大小——之前的同步 `lstat+stat` 对每个请求阻塞主线程，而 `<video>` 拖动会发很多 Range 请求
（`:157-165`）；③ **Agent 生成的 HTML 有独立严格 CSP**（`:90-92`）：`default-src 'none'`，
允许内联脚本样式但**禁止一切网络请求，也禁止读取其他 nt-media 文件**，所以它既不能外泄也不能读
同级的允许文件；这些文件写在 `userData/agent-web` 下，保留最近 20 个并在启动时清扫历史残留。
URL 编解码那 20 行注释值得整段读（`:16-33`）：按**宿主的分隔符**逐段 `encodeURIComponent`——
只按 `/` 切会把 Windows 反斜杠编成 `%5C`、盘符被吞进 URL authority；但**也不能同时按两种切**，
因为 POSIX 上 `\` 是合法文件名字符。

**`keep-awake.ts`（37 行）**：Electron 侧只是把 `powerSaveBlocker` 绑到 **Electron-free 的核心跟踪器**
`core/keep-awake.ts`（`:17-36`）；`prevent-app-suspension` **只挡空闲休眠**，从不挡显示休眠，
合盖照样睡——「没有应用能覆盖它，面向用户的文案也这么写」（`:2-3`）。

**`trackpad-gesture.ts`（103 行）**：渲染端**分不清**触控板和精密像素鼠标（Magic Mouse、MX Master），
两者到 DOM 都是无修饰的像素模式滚轮事件；主进程**分得清**——macOS 把触控板双指滚动包在
`gestureScrollBegin/End`（惯性阶段是自己的一对）、捏合包在 `gesturePinchBegin/End`，
滚轮鼠标只发裸 `mouseWheel`，这是在 Electron 42 / macOS 上把 MX Master 3S 与 MacBook 触控板
并排实测出来的（`:4-11`）。ledger 把原始流**规约成边沿转换**，一次物理手势只发几条 IPC。
自愈（issue #535）：窗口失焦时 `reset()`，以及 Begin 处的过期检查——否则一次丢失的 End 会让深度
永久卡在 ≥1，之后所有手势都嵌套在幻影里，滚轮缩放静默死掉直到重启。**故意不做**的事也写了：
不在裸 `mouseWheel` 上自愈，因为真实触控板滚动也由它构成，误判的自愈会在 pan 中途报一次 close，
而渲染端对 close 的回应是缩放。

**`keydown-intercept.ts`（444 行）—— 主进程为什么要插手键盘**：菜单快捷键在页面看到按键**之前**
就被处理了，渲染端监听器根本不会跑（`:11-14`）。`before-input-event` 的 `preventDefault` 同时压掉
菜单项和页面事件，因此每条被认领的和弦必须自己通过 IPC 把意图转发给渲染端。当前只有三条
（⌘M / ⌘W / ⌘0），模块本身被声明为**主进程拦截和弦的封闭清单**；其中可重绑的那一半还必须同步写进
`shared/keybindings.ts` 的 `MAIN_INTERCEPTED_COMMAND_IDS`（设置页的「应用级遮蔽」警告读它，
而它无法从 main 推导——main 对渲染端不可 import），由 `keydown-intercept.test.ts` 钉住。
注释还诚实说明这个钉子**盖不到**什么：硬编码的 ⌘0 式拦截没有 command id，不变式测试看不见它。

---

## 6. 对 Armadra 的映射

Armadra 桌面壳是 Rust，约 4600 行（含测试）。

### 6.1 可以整个删掉的子系统

| Tauri 侧 | 位置 | 为什么在 Electron 里消失 |
| --- | --- | --- |
| `armadra://` 自定义协议 HTTP 转发 | `transport.rs:1-23`、`:36` | Electron renderer 可直接 `fetch('http://127.0.0.1:<port>')`；即便仍想用私有 socket，`protocol.handle` 也能做同样的事，但不再必要——见下一行 |
| WebSocket 回环转发器 + `__armadra/transport` 端口发布 | `transport.rs:14-21`、`:32-33`、`main.rs:418-440` | 存在的唯一理由是「WebSocket 不能走自定义协议，WebKit/WebView2 只认 `ws:`/`wss:`」。Electron 里页面来源本身就是 http(s)，`ws://127.0.0.1` 直接可用 |
| 原生会话票据整条链路 | `native_session.rs` 全文、`host/native.rs`、`apps/web/src/host/native-session.ts`（204 行）、`host/mod.rs:29-33` 的 `NATIVE_ORIGINS` | 它存在是因为页面来源是 `tauri://localhost`，**永远满足不了** Host 的「HTTPS 且同源」规则（`native-session.ts:14-18`）。Electron 里页面来源可以就是 `http://127.0.0.1:<Host 端口>`，Host 已有的浏览器会话路径直接可用 |
| 诊断桥 | `main.rs:57-85`、`diagnostic_bridge.js` | 它存在是因为打包后的 WKWebView 没有开发者工具（`main.rs:61-63`）。Electron 打包应用随时可开 DevTools，主进程 stderr 就是应用 stderr |
| `mark_tauri_document` | `main.rs:45-55` | 给 `<html>` 打 `data-tauri` 是为绕过 `default-src 'self'` 挡内联脚本；Electron 里在 preload 同步设置即可 |
| `isTauri()` 分支 | `apps/web/src/platform/index.ts:13-16` 及全部调用点 | 换成 `typeof window.armadra !== 'undefined'`。**语义保留**——仍是「桌面分支 vs 浏览器回退」，只换判定源 |

删掉票据链路是本次迁移**最大的一块净收益**：`native_session.rs` + `host/native.rs` +
`native-session.ts` + Host 侧的 `identity.native-session.v1` 能力位，以及
`docs/design/host-native-session.md` 整篇设计，都是 `tauri://localhost` 这个非 HTTP 来源逼出来的。
Host 侧保留 `identity.browser-session.v1` 一条路径即可。

### 6.2 必须保留、逐职责换实现

| Tauri 壳现在承担的职责 | 现位置 | Electron 里的替代 |
| --- | --- | --- |
| 启动/健康检查/停止 Runtime；instance id 对账；孤儿识别与清理 | `runtime_process.rs:1-25`、`:41-56` | 新建 `src/main/runtime-process.ts`：`spawn` + 读 stdout 的 `armadra-runtime instance ` 公告行 + 轮询 `/health`。「只认自己拉起的那个实例」（用户实测反馈 F1）**一行都不能省**——它解决的是「上一个被强杀的壳留下的子进程应答了新壳的健康检查」 |
| Go Host 的发现/启动/校验；只持短命 CLI 子进程 | `host/mod.rs:1-6`、`host/launch.rs`、`host/verify.rs` | `src/main/host/`，同样的三分法；`HostLaunchError` 的变体照搬成 TS 联合类型 |
| 退出编排：先停 Host 再停 Runtime，失败则**不退出**并弹窗 | `main.rs:89-120`、`lifecycle.rs:15-64` 的 RUNNING/STOPPING/STOPPED | `src/main/lifecycle.ts` + `app.on('before-quit')` 拦截（nodeterm 对应 `main/index.ts:3883`）。`updater.ts` 的 `onBeforeRestart` 回调专为翻 quitting 标志而设（`:59-63`）——Armadra 的「更新前先停 Host」正好挂这里 |
| 关闭前台 = 隐藏，不退出 | `main.rs:402-415`（`prevent_close` + `hide`） | `closeAction()`，`main-window.ts:86-93`。**全屏那个坑 nodeterm 已写好修法，直接抄** |
| 托盘 + 用量条 + 菜单 | `main.rs:177-215`、`usage.rs`、`main.rs:334-350` | Electron `Tray` + `Menu`。用量轮询是纯数据处理，**应放进壳的 core 层而非 main**——对应 nodeterm 的 `core/check.ts`（主进程发请求以保持渲染端 CSP 为 `'self'`） |
| 应用菜单 | `main.rs:122-167` | `Menu.buildFromTemplate`，并**必须同时移植 `keydown-intercept.ts` 的思路**：菜单快捷键先于页面，换壳后 ⌘W/⌘M 之类会被菜单吃掉 |
| 系统全局热键 | `shortcuts.rs:1-23`、`apps/web/src/keybindings/global-shortcuts.ts` | `globalShortcut`。三条设计规则原样保留：默认不注册任何热键；只允许 `KNOWN_IDS` 里的 id；**被占用时报告而不是吞掉**（`shortcuts.rs:8-19`）。页面那一半几乎不用改——它的分工「壳只把窗口叫回前台并发一条事件，真正的动作仍是画布命令」正是 Electron 该有的样子 |
| 目录/文件选择器 | `platform/index.ts:27-74` | `dialog.showOpenDialog`，经 preload 暴露；保留 `canCreateDirectories` 与「返回路径而非字节」的理由（`:50-55`） |
| 外部链接 | `platform/index.ts:77-88` | `shell.openExternal`，但**必须加 nodeterm 那道 scheme 白名单**（`main/index.ts:326-330`：挡掉 `file://`、`smb://` 及可被 markdown 链接走私进来的协议处理器 scheme）。Tauri 现在靠 capability 的 `opener:allow-open-url` scope 做同一件事 |
| 系统通知 | `tauri_plugin_notification`、`updates/notify.rs` | Electron `Notification` + **`notifications.ts` 的 retain 机制** |
| 更新状态机（十一态、稳定 reason token） | `updates/machine.rs:1-23`、`updates/mod.rs:1-18`、`apps/web/src/updates/shell-updater.ts:17-62` | **整段移植成 TypeScript。** `machine.rs` 纯函数、无 Tauri、无网络、无时钟，几乎逐行翻译成 `src/main/updates/machine.ts`，只把 `tauri_plugin_updater` 换成 `electron-updater`。两条硬规则保留：①「没看」「看失败」「看了没有」是三种答案，只有第三种是 `upToDate`；②状态不接受的事件什么也不改，没有兜底分支。`Reason::HostStopFailed` 是 Armadra 独有而 nodeterm 没有的——`coordinate.rs` 的「先停 Host 再装」必须保留 |
| 窗口毛玻璃 | `main.rs:32-40`（`window-vibrancy`） | `BrowserWindow` 的 `vibrancy: 'sidebar'` 原生支持，配 `window-chrome.ts` 那种 macOS-only 收口 |
| 数据目录解析 | `lib.rs:26-48` | `app.getPath('userData')`，但 **Armadra 必须继续自己算**：Runtime 与壳要在互不通信的情况下就 socket 与 `endpoints.json` 的位置达成一致（`lib.rs:27-29`）。Electron 的 userData 默认路径与现在的 `~/Library/Application Support/Armadra` 恰好一致，仍需显式 `app.setPath` 或保留独立解析函数 |
| 生命周期 trace | `lib.rs:18-24` | 原样保留：「生命周期 bug 都是时序 bug，默认关闭的 trace 不花钱」 |

### 6.3 三条结构性建议

1. **Armadra 不需要那么厚的 `src/core`**，业务在 Rust Runtime 里，main 进程只做壳：子进程监管、
   窗口、菜单、托盘、更新、系统对话框。但仍要把**纯逻辑**（更新状态机、用量解析、Host 校验规则、
   accelerator 转换）放进 `src/shell-core/`，用一条 `no-electron.test.ts` 式扫描守住——
   理由与 `lib.rs:1-7` 现在写的一致：「`main.rs` 只是 Tauri builder 和窗口/托盘的管道，
   凡是有规则可陈述的都住在 lib 里」。
2. **IPC 表面一次设计好**。Armadra 现在只有 9 个 Tauri command（`main.rs:190-202`）：
   7 个更新 + 1 个票据（将删）+ 1 个全局热键，是个极小可控的起点。加上文件对话框、外部链接、通知，
   Electron 侧通道总数应控制在 15 条以内，集中在一个 `src/shared/ipc.ts`。并且从第一天起区分
   「可被远端调用」与「只对本窗口」——即使暂时没有 relay peer，那条不变式的成本是零，
   事后补是一次安全审计。
3. **持久化不要搬**。Armadra 的真相在 SQLite（Runtime 拥有）与 `worker-settings.json`，壳不碰用户数据。
   原子写的思路属于 Rust 侧，而 Armadra 的迁移账本已在 `db::connect` 的 `BEGIN IMMEDIATE` 事务里
   做了更强保证。壳里唯一会写的是窗口状态，用同款有界重试即可。

---

## 7. 建议的实施批次

每批可独立跑起来、独立验收。批次 0–2 只新增 `apps/desktop-electron/`，不动现有 Tauri 壳。

**批次 0 — 壳骨架（不接 Runtime）**：electron-vite 三 target 配置，CJS 输出，`electron` 与原生模块
外置；一个 `BrowserWindow` 加载 `apps/web`；preload 暴露空的 `window.armadra`，
`contextIsolation: true` / `nodeIntegration: false`；建立 `src/shared/ipc.ts` 与边界扫描测试
（此时清单为空，先把门装上）。**验收**：`dev` 能打开窗口并渲染现有画布（连外部 Runtime），
`pnpm repo:check` 通过，边界测试通过。

**批次 1 — 子进程监管**：移植 `runtime_process.rs`（spawn、instance 公告行、`/health` 对账、
孤儿识别与 SIGTERM、`RELEASE_TIMEOUT`）、`host/` 三件套、`lifecycle` 的三态与退出编排。
**验收**：把 `runtime_process_tests.rs`（306 行）与 `host/tests.rs`（754 行）的断言清单移植成
vitest 用例并全绿；手工验证冷启动、孤儿 Runtime、Command Q 正常退出、Host 停不下来时不退出并弹窗；
`ARMADRA_DESKTOP_LIFECYCLE_TRACE=1` 的输出与 Tauri 版逐事件一致。

**批次 2 — 删掉 transport 层**：让壳持有的 Runtime 监听 `127.0.0.1` 的内核分配端口；页面改为从
preload 读一次 `{ httpBase, wsBase }`，替换 `armadra://` 与 `__armadra/transport`；
Host 的 `--allow-origin` 改为壳的真实来源；**删除**票据链路的 web 侧与 Rust 侧。
**验收**：终端节点能开能打字能重连；画布事件 WebSocket 在壳内实时更新；
`lsof -i -P | grep -i Armadra` 的端口清单与 `docs/guides/development.md:41-47` 重新对账并更新；
Host「设置 → 连接 → 后台服务」检查通过；`native-session.test.ts` 随实现一并删除。

**批次 3 — 系统集成**：目录/文件选择器、外部链接（带 scheme 白名单）、通知（带 retain）、
托盘+用量条、应用菜单、全局热键、窗口毛玻璃、关闭即隐藏（含全屏那条）；补 `keydown-intercept`
等价物并把菜单会吃掉的和弦列成封闭清单写测试。**验收**：`pnpm --filter @armadra/web test` 全绿
（`global-shortcuts.ts` 的页面一半不应改动）；手工过一遍拖入文件、打开外部链接、通知点击回前台、
托盘用量刷新、热键被占用时设置页显示 `taken`、全屏下关窗不留黑屏 Space。

**批次 4 — 更新**：先把 `updates/machine.rs` 移植成纯 TS 状态机并只写测试；再接 electron-updater，
保留 `coordinate` 的「先停 Host、验证重启成功」语义与 `hostStopFailed` / `installFailed` 的区分、
「无 pubkey = notConfigured，绝不报 upToDate」的规则，以及本地包标记（对应 `nodeTermUpdates`）
避免本地构建轮询生产 feed。**验收**：状态机测试走完 `machine.rs` 转换表的全部条目；
`apps/web/src/updates/state.test.ts` 不改仍通过（十一态线格式不变）；用本地 release server 走一次
check → download → install → restart；人为让 Host 停不下来，确认报 `hostStopFailed` 且未安装任何东西。

**批次 5 — 打包与签名**：electron-builder 配置（`asarUnpack` 原生依赖、`extraResources`、
mac `hardenedRuntime` + entitlements + notarize、Windows NSIS）；**照抄 `info-plist.test.ts`**，
把 `extendInfo` 做成带理由的允许清单测试——Armadra 会用到 `NSLocalNetworkUsageDescription`
（Runtime 与 agent CLI 访问本机网络），这条不做，缺失会**静默拒绝**并表现为网络故障。
**验收**：本地 `dist` 出未签名包能启动并完成批次 1–4 的手工清单；info-plist 测试通过；
未签名阶段先**关闭更新器**，签名与公证接通后再打开更新 feed。

**批次 6 — 收尾**：删除 `apps/desktop/`（Tauri）及其 capability 与 CSP 配置；同步
`docs/guides/architecture.md` §2 三层图、§6 端口表、§7 安全边界，以及
`docs/guides/development.md` 关于桌面壳/自定义协议/回环转发的三段；把
`docs/design/host-native-session.md` 归档进 `history/`（整篇因票据链路删除而失效）。
**验收**：`pnpm check` 全绿（含 `repo:check` 的目录与文档登记规则）；
`cargo test -p armadra-runtime` 与 `go -C apps/host test ./...` 不受影响；
文档里不再出现 `tauri://localhost`、`armadra://`、`__armadra/transport` 的现状描述。
