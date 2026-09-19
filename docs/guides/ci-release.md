# CI 与发布

两份工作流：`.github/workflows/ci.yml` 在每个 PR 与 `main` 上跑三平台检查，
`.github/workflows/release.yml` 在推标签时打出全部产物并创建 draft Release。

## 1. ci.yml

触发：`pull_request`，以及推到 `main`。同一分支的新提交会取消上一次运行
（`concurrency` + `cancel-in-progress`）。权限只有 `contents: read`。

一个作业 `check`，矩阵三行：

| runner           | 标签           | Go 竞态检测 |
| ---------------- | -------------- | ----------- |
| `ubuntu-latest`  | linux-x86_64   | `-race`     |
| `macos-14`       | macos-aarch64  | `-race`     |
| `windows-latest` | windows-x86_64 | 不开        |

三行跑同一串步骤：

1. `pnpm install --frozen-lockfile`
2. `pnpm check`（libs:build、prettier、`cargo fmt --check`、typecheck、
   `protocol:check`、`repo:check`、`ci:workflows`、`release:check`）
3. `pnpm repo:test`、`pnpm release:test`
4. `pnpm -r --if-present test` / `typecheck`、`pnpm --filter @armadra/web build`
5. `pnpm protocol:test`（Go / Rust / TS 三端契约）
6. `cargo clippy --workspace --exclude armadra-desktop --all-targets -- -D warnings`
7. `cargo test --workspace --exclude armadra-desktop`
8. `go -C apps/host vet ./...` 与 `go -C apps/host test [-race] -count=1 ./...`
9. 只在 Linux 上：Host 交叉编译 windows/amd64、darwin/arm64、linux/arm64

几条不显然的决定：

- **平台差异只用 `cfg` 表达。** Windows 上跑不了的用例（tmux 会话、Unix socket、
  `/bin/sh`、symlink 逃逸）由 `#[cfg(unix)]` / `#[cfg(target_os = "macos")]`
  在源码里门控，CI 不写任何 `--skip` 或 `-run` 过滤。按名字过滤的用例在它开始
  能跑之后没人会去掉过滤，而门控在编译期就说明了它为什么不在。
  `tools/ci/validate-workflows.test.mjs` 会断言工作流里没有这类过滤。
- **Windows 不开 `-race`。** windows/amd64 的竞态检测要外部 gcc（cgo），镜像里
  没有可依赖的一个；竞态由另外两个平台覆盖。
- **`.gitattributes` 把全仓统一成 LF。** Windows runner 默认
  `core.autocrlf=true`，而 `prettier --check`、`cargo fmt --check` 和
  `protocol:check` 都是按字节比对，CRLF 工作副本会让三个检查一起红。
- **桌面壳只构建，不打包。** `pnpm --filter @armadra/desktop build` 把
  main / preload / renderer 三个 target 过一遍 electron-vite，要的是三个平台上
  构建图都通得过。打包要真的受管二进制与平台特定的证书 / 公证输入，是发布流水线
  的事。壳自己的单测（vitest + `node --test scripts/*.test.mjs`）在第 5 步的
  `pnpm -r --if-present test` 里已经跑过，不重复。

缓存：`actions/setup-node` 的 `cache: pnpm`、`actions/setup-go` 按
`apps/host/go.sum`、`Swatinem/rust-cache` 按矩阵标签分键。

## 2. release.yml

触发：推 `v*` 标签，或 `workflow_dispatch` 手动运行。手动运行可以给一个 `tag`
（补发那个标签），也可以留空（在当前分支上演练）。`dry_run` 默认勾选，此时全部
作业照跑但不创建 Release。`concurrency` 不取消进行中的发布。

**版本住在仓库里，标签只是指向它的名字。** 这一点与许多流水线相反，也与
LiveAgent 相反——它用 `prepare-app-version-from-tag.mjs` 从标签解出版本、写进一份
生成的打包配置，仓库里根本不存版本。我们不这么做，因为版本在三个文件里
（`Cargo.toml` 是源，另外两处与它一致，见 `tools/release/version.mjs`），Host 与
外壳都会自报它，更新检查比的也是它。于是方向反过来：`verify` 要求
**标签等于仓库版本**，不等就拒绝发布，而不是让标签去覆盖代码里的版本。

工作流里的所有 checkout 都用 `ref: ${{ inputs.tag || github.sha }}`：手动补发一个
标签时，构建的必须是那个标签的树，而不是触发它的分支的 HEAD。

| 作业       | runner         | 做什么                                                  |
| ---------- | -------------- | ------------------------------------------------------- |
| `verify`   | ubuntu-latest  | 三处版本与标签一致、全量测试、工作流与发布脚本自检      |
| `build`    | 六行矩阵，见下 | 打桌面包与组件包、改名，上传 `release-<target>`         |
| `web`      | ubuntu-latest  | 打前端产物 `armadra-web_<version>.tar.gz`               |
| `notarize` | ubuntu-latest  | 只报告哪些平台缺签名 secret，不阻断                     |
| `assemble` | ubuntu-latest  | 校验清单、`latest.json`、说明，并创建 **draft** Release |

构建矩阵的六个目标与 `tools/release/artifacts.mjs` 的 `TARGETS`、
`apps/desktop/scripts/sidecar-targets.mjs` 的三元组表一一对应，
`pnpm ci:workflows` 会校验这一点：

| runner             | target          | triple                    |
| ------------------ | --------------- | ------------------------- |
| `macos-14`         | darwin-aarch64  | aarch64-apple-darwin      |
| `macos-15-intel`   | darwin-x86_64   | x86_64-apple-darwin       |
| `ubuntu-22.04`     | linux-x86_64    | x86_64-unknown-linux-gnu  |
| `ubuntu-22.04-arm` | linux-aarch64   | aarch64-unknown-linux-gnu |
| `windows-2022`     | windows-x86_64  | x86_64-pc-windows-msvc    |
| `windows-11-arm`   | windows-aarch64 | aarch64-pc-windows-msvc   |

`ubuntu-22.04-arm` 与 `windows-11-arm` 只对公开仓库免费。仓库转私有时这两行要
换成自托管 runner，或者删掉并同步收窄 `TARGETS`。

### 2.1 Linux 钉在 22.04

glibc 的符号版本是单向的：在 Ubuntu 24.04（glibc 2.39）上链接出来的二进制会记下
`GLIBC_2.38` / `GLIBC_2.39` 的引用，到 22.04 上动态链接器直接拒绝启动
（`version 'GLIBC_2.38' not found`），而构建过程一切正常，没有任何一处会提。
LiveAgent 就是这样发出去过一个版本（`Stack-Cairn/LiveAgent#714`），修法是把
Linux 行钉在 `ubuntu-22.04` 并在产物上断言基线。两条缺一不可：runner 决定这次
能不能过，断言拦住下一次——某个构建依赖开始要更新的 glibc 符号时，它是唯一会出声
的地方。

`tools/release/verify-linux-glibc-baseline.sh` 就是那个断言。它 `objdump -T` 每个
Linux 产物（`Armadra`、`armadra-runtime`、`armadra-hook`、`armadra-host`，
含 `-<triple>` 后缀的暂存副本），取出所有 `GLIBC_x.y` 引用，高于基线就列出具体
符号并失败。基线默认 2.35（Ubuntu 22.04 LTS 与 Debian 12），用
`ARMADRA_GLIBC_BASELINE` 覆盖。`armadra-host` 是 `CGO_ENABLED=0` 编的，没有任何
GLIBC 符号，脚本对这种情况打印「静态链接」而不是当成异常——它列在里面，是为了将来
某个 cgo 依赖出现时这条检查已经在位。

arm64 用 `ubuntu-22.04-arm`：GitHub 的确提供这个标签，glibc 同样是 2.35，所以
同一条基线两个架构通用。这两个 runner 与 Ubuntu 22.04 LTS 的标准支持同在
2027-04 退役，届时换成 `ubuntu:22.04` 容器构建。

### 2.2 打包器的名字不是发布的名字

electron-builder 按各平台自己的习惯命名：`Armadra-0.1.0-arm64.dmg`、
`Armadra Setup 0.1.0.exe`、`armadra_0.1.0_amd64.deb`。这些名字里读不出 Host
认得的目标——`assetTarget` 在 `arm64`、`amd64` 里什么都找不到，其中一个还带空格——
于是 `assemble` 会判它们「declares no target the Host can read」。直接上传等于发了
一堆 Host 永远不会提供给任何客户端的桌面产物。

`tools/release/stage-desktop.mjs` 负责这次改名：按 `desktopAssets()` 声明的 `kind`
在 `apps/desktop/release/` 里按扩展名找到那一个文件，复制成 `artifacts.mjs` 规定的
名字。按扩展名而不是按全名匹配，是因为上面那些名字里的产品名大小写与架构拼写随时
可能被 electron-builder 改掉。缺了本该有的包就在这里失败，而不是等 `assemble`。

产物落在**一个平铺目录**里，旁边还有不是发布产物的文件：`latest*.yml`（electron-updater
自己的清单，本发布不发它）、`*.blockmap`（差分下载索引）、`builder-*.yml` 与
`*-unpacked/`。`isReleaseAsset()` 把它们挡在外面——`.blockmap` 按名字排序还排在它索引的
`.dmg` 前面，只看扩展名会挑错文件。

每平台的 target 列表写在 `apps/desktop/electron-builder.yml`，与 `desktopAssets()`
一一对应，由 `apps/desktop/scripts/artifact-targets.test.mjs` 钉住两端（矩阵与文件名
都钉）。

| 平台    | electron-builder target  | 发布的桌面产物                         |
| ------- | ------------------------ | -------------------------------------- |
| macOS   | `dmg`、`zip`             | `.zip`（updater）、`.dmg`              |
| Windows | `nsis`、`zip`            | `-setup.exe`（updater）、便携 zip      |
| Linux   | `AppImage`、`deb`、`rpm` | `.AppImage`（updater）、`.deb`、`.rpm` |

哪一个能原地更新不是选择，是 electron-updater 的规则：它替换的是 app bundle，
所以 macOS 更新走 zip 而不是 `.dmg`（后者是一个要挂载的磁盘映像），Windows 走安装器
而不是便携包。

### 2.3 Windows 便携版

便携 zip 就是 electron-builder 的 `zip` target：它打的是解包后的整个目录，`extraResources`
暂存的四个二进制本来就在里面。外壳在生产构建里是从 `process.resourcesPath` 找
`armadra-host` 与其余受管二进制的，所以整目录压缩正好是它需要的形状——上一代壳要靠
脚本手工拼一个平铺 zip，是因为那时二进制暂存成 `<binary>-<triple>.exe`，装好之后旁边
的那份却不带后缀。

便携版不是 updater 目标：解压到哪儿由用户决定，没有一个「已安装的位置」可供替换，
写进 `latest.json` 等于承诺一次做不到的更新。

### 2.4 AppImage

electron-builder 的 AppImage 由 app-builder 自己打，不经 linuxdeploy，因此不会把
宿主的 GTK/Wayland 栈拷进镜像——Electron 自带 Chromium，运行时才链接系统 GTK。
上一代壳需要一个剥离 `libwayland-client/cursor/egl` 的后处理步骤（那些库不是自包含的，
镜像里自带一份等于把同一套协议的两个版本混在一起），随那个打包器一起删掉了。

### 2.5 各平台的系统依赖与缓存

- **Linux**：只要 `file`（AppImage 用）与 `rpm` 包提供的 `rpmbuild`。
  electron-builder 自带 Chromium，不链接 WebKitGTK，原先那一长串 `-dev` 包不再需要。
  §2.1 的基线校验要 `objdump`，runner 镜像自带 binutils。
- **Windows**：NSIS 由 electron-builder 自己下载，不需要
  预装。组件包是 `.zip`，而 `zip` 不在每个 Windows runner 的默认 PATH 上，
  `tools/release/package-components.mjs` 会退回镜像自带的 7-Zip，不额外装东西。
  打 `.tar.gz` 时用的是 `System32\tar.exe`（bsdtar），不是 PATH 上排在前面的
  Git GNU tar——后者把 `C:\Users\…` 读成 `host:path`，回答 "Cannot connect to C"
  （2026-09-13 的第一次真实 dry-run）。
- **macOS**：不需要额外依赖。签名与公证见 §2.6。
- **protoc 一个 runner 都不装。** `crates/protocol/build.rs` 用
  `protoc-bin-vendored` 自带的那份，Go 侧的 `*.pb.go` 已入库，`protocol:check`
  是用同一份 vendored protoc 重新生成后比对字节。LiveAgent 三个平台各装一次
  protoc（Linux 上还因为 22.04 的 apt 版本太老而改装官方 release），是因为它的
  `prost-build` 用的是系统 protoc；我们没有这个问题，装一份只会引入版本漂移。

缓存：`actions/setup-node` 的 `cache: pnpm`、`actions/setup-go` 按
`apps/host/go.sum`、`Swatinem/rust-cache` 按 `matrix.target` 分键（`ci.yml` 按
`matrix.label`），两份工作流因此不会互相污染缓存。

所有多行 `run` 都写 `shell: bash` 与 `set -euo pipefail`：Windows 默认的 pwsh 只看
最后一条命令的退出码，`pnpm ci:workflows` 会拦住漏写 `shell` 的 Windows 步骤。

### 2.6 macOS 签名与公证

证书先自己导进一个临时钥匙串并当场 `find-identity`，再把同一份 base64 交给
electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD`。多这一步只为了**失败的时刻**：
证书或口令不对时，`security import` + `security find-identity` 在十秒内就红；只交给
打包器则要等整个前端构建和 bundling 跑完才在最后一步失败。这和
`apps/desktop/scripts/signing-electron.mjs` 把签名判断提到构建之前是同一个道理。

关键的几行与它们的理由：

- `security set-keychain-settings -lut 21600`：锁定超时要比最长的一次构建还长，
  钥匙串锁上就再也签不动了。
- `security set-key-partition-list -S apple-tool:,apple:,codesign:`：没有它，
  `codesign` 会弹一个没人能点的「允许访问」对话框并超时。
- `security default-keychain -s`：codesign 从默认钥匙串里找身份。
- 没给 `APPLE_SIGNING_IDENTITY` 时，从 `find-identity` 的输出里取第一条。
- 构建结束后 `if: always()` 删掉钥匙串。

公证用 `xcrun notarytool store-credentials armadra-notary --validate` 预检：
`--validate` 会真的去问一次 Apple，凭据不对在这里报错，而不是在打包末尾排队等公证
时。预检通过后把 `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
写进 `GITHUB_ENV`——这正是 `signing-electron.mjs` 读的三个名字——公证与装订由
electron-builder 在打包末尾完成。

任何一半缺失就整段跳过并 `::warning::`，`notarize` 作业把 macOS 列进未签名平台，
`assemble` 把这句话写在 Release 说明顶部。缺 secret 从不阻断发布。

LiveAgent 还用 `dmgbuild` 重建 DMG 并自己 `notarytool submit` + `stapler staple`，
那是为了拿到确定性的 Finder 布局（背景图、图标位置）——它把 bundler 的 DMG 丢掉，
所以必须自己公证。我们没有这个需求，也就没搬这一段。

### 2.7 发布说明与 draft

变更清单交给 GitHub 自己生成：
`gh api repos/<repo>/releases/generate-notes -f tag_name=<tag> --jq .body`，它按两个
标签之间合并的 PR 写，比任何手工维护的清单都更接近真实发生的事。结果喂给
`assemble.mjs --notes-from`，由 `compatibility.mjs` 的 `releaseNote()` 在外面套上
未签名平台的提示与兼容性围栏。标签还不存在时（分支演练）这条 API 会失败，退回
一行标题，围栏照样有。

`gh release create` 带 `--verify-tag`：标签不存在时拒绝，而不是替我们建一个指向当前
提交的标签。预发布按标签里有没有 `-` 判定（`v0.2.0-rc.1`），与 semver 的读法一致。
`latest.json` 仍由 `tools/release/updater-manifest.mjs` 生成并随产物一起上传。

仍然只创建 **draft**：LiveAgent 会直接发布并 `--latest`，我们不。产物清单与说明要
人审阅，Host 会跳过 draft，所以未发布前任何客户端都看不到它。

## 3. 密钥清单

全部是 GitHub 仓库 secret。**一个都没有时发布仍然跑得通**：产物是未签名的，
`assemble` 会把这件事写进 Release 说明顶部，`latest.json` 会把没有签名的
updater 包排除在外。

| Secret                         | 谁用                                                                 | 缺了会怎样                                   |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------- |
| `APPLE_CERTIFICATE_P12_BASE64` | macOS 代码签名（base64 的 .p12）                                     | 不签名，首次打开有 Gatekeeper 提示           |
| `APPLE_CERTIFICATE_PASSWORD`   | 导入上面的证书                                                       | 同上                                         |
| `APPLE_SIGNING_IDENTITY`       | 指定用哪张证书；缺则取第一张                                         | 钥匙串里有多张时可能选错                     |
| `APPLE_ID` / `APPLE_TEAM_ID`   | 公证                                                                 | 不公证，`notarize` 作业把 macOS 列进说明     |
| `APPLE_APP_SPECIFIC_PASSWORD`  | 公证用的 app 专用密码                                                | 同上                                         |
| `WINDOWS_CERT_BASE64`          | Windows Authenticode                                                 | 不签名，SmartScreen 会提示                   |
| `WINDOWS_CERT_PASSWORD`        | 导入上面的证书                                                       | 同上                                         |
| `ARMADRA_RELEASE_SIGNING_KEY`  | 每个产物与 `SHA256SUMS` 的 minisign 签名，`latest.json` 引用的也是它 | 产物不带签名，`latest.json` 为空，说明里写明 |

证书与公证密码两个名字沿用 LiveAgent 的拼写；工作流同时接受早先的
`APPLE_CERTIFICATE` 与 `APPLE_PASSWORD`（`${{ secrets.A || secrets.B }}`），
已经配好的仓库不用改 secret。

工作流只把**非空**的 secret 写进环境：空字符串的证书变量会被当成「有密钥」，
然后在打包最后一步失败；没有密钥时要的是跳过，不是一个更晚、更难读的错误。
macOS 的证书与公证凭据走 §2.6 的两个预检步骤，Windows 的证书走同一对
`CSC_LINK` / `CSC_KEY_PASSWORD`，都是「缺了就跳过并告警」。

**签名在写清单之前。** 上一代打包器在构建过程中就给每个 updater 包签出一份分离
签名，所以 `assemble.mjs` 读得到一个已经在盘上的 `.sig`；electron-builder 只做平台
代码签名，不产出分离签名。于是 `assemble.mjs` 自己先签一遍，再用刚签出的东西写
`latest.json`，最后写 `SHA256SUMS` 并补签那两个当时还不存在的文件。整条链上只剩
`ARMADRA_RELEASE_SIGNING_KEY` 一把钥匙，组件包和桌面包共用。

`GITHUB_TOKEN`：`release.yml` 顶层声明 `permissions: contents: write`，
`assemble` 用它 `gh release create --draft`。`ci.yml` 是 `contents: read`。
工作流永远不会把 Release 从 draft 转正——那一步是人的动作。

更新地址不写进仓库。`electron-builder.yml` 的 `publish.url` 是占位，CI 通过
`ARMADRA_UPDATER_ENDPOINTS` 注入，`signing-electron.mjs` 把它与签名判断合成同一个
`--config`。

打包这一步走 `pnpm --filter @armadra/desktop dist`，也就是
`apps/desktop/scripts/dist.mjs`，而不是直接 `electron-builder`：签名判断必须发生在
构建之前，否则缺密钥的失败要等到最后一步才出现。该脚本用 Node 直接启动
electron-vite 的入口——Windows 上包管理器是 `.cmd`，`execFileSync` 不带 shell
启动不了它。受管二进制在它之前由单独一步 `cargo build --release` 与
`prepare:host --release --native` 产出，两条都不带 `--target`：runner 就是本机。

## 4. 本地怎么先验

```sh
pnpm ci:workflows      # 两份工作流的结构、runner 标签与矩阵三元组
pnpm release:test      # tools/release 与 tools/ci 的单元测试
pnpm release:check     # 三处版本一致、兼容范围包含本版本
pnpm release:dry-run   # 把一次完整发布（36 个产物）落到临时目录并校验
go run github.com/rhysd/actionlint/cmd/actionlint@latest \
  .github/workflows/ci.yml .github/workflows/release.yml
```

下面这些只有真 runner 能回答，本机无从验证，列在这里免得下次有人以为它们已经过：

- `ubuntu-22.04` / `ubuntu-22.04-arm` 上 electron-builder 能否打出 AppImage / deb / rpm
  三种包（换打包器后未在真 runner 上跑过）；
- Apple 证书导入、`notarytool --validate` 与 electron-builder 的公证（要真 secret）；
- Windows Authenticode 走同一对 `CSC_*` 变量是否成立（要真 secret）；
- Windows 便携 zip 解压后壳能不能在 `resources/` 里找到四个受管二进制。

首次打标签 `v0.1.0`（2026-09-14）跑了四遍才到 draft：arm64 行缺 appimagetool（见 §2.4）；
`assemble` 把「一个 `.sig` 都没有」当成六个洞而不是未签名发布，与 §3 的承诺相反，
现在只有部分签名或缺包才算洞；`verify` 的 Linux 行两次撞上 hook 序号锁测试的偶发。
最终六个桌面目标全部成功，draft Release 带 37 个文件（六平台桌面包 + 组件包 +
Web 包 + 空的 `latest.json` + `SHA256SUMS`）。上面两条带 secret 的项仍未验证。

### Windows 上的 `cargo test -p armadra-runtime`

首次三平台真跑（2026-09-13）Linux 与 macOS 全绿，Windows lib 测试 38 条失败。
根因归成五类，都已改在代码或夹具里，**修好没有的确认只能由 Windows runner 给**：

| 类别                | 根因                                                                                         | 现在怎么做                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| SQLite 连接 URL     | SQLx 的 `to_url_lossy` 把文件名过一遍 URL 解析器，`C:\Users\…` 出来变成主机 `C` 加路径 `/\…` | `paths::sqlite_file_url` 自己拼，`paths::database_file` 是它的逆 |
| `\\?\` 扩展长度前缀 | `std::fs::canonicalize` 在 Windows 一律返回 verbatim 形式，git 当成 UNC 主机名拒绝           | 全仓改走 `paths::canonicalize`，只在 Win32 表达得出时去掉前缀    |
| 驱动器盘符不是目录  | `imports` 逐段 stat 路径时 `C:` 这一段返回 "Incorrect function"                              | 跳过 `Prefix` 与 `RootDir`，只查它们下面的段                     |
| `--listen unix:`    | 用 `Path::is_absolute` 判断，同一个参数在 Linux 能解析、Windows 不能                         | 改判首字符是不是 `/`；绑定失败仍然是绑定时的事                   |
| 只有 Unix 有的东西  | `/bin/sh`、`ps -Ao`、POSIX 权限位、文件名里的 `"` 和 `?`                                     | 按用例加 `#[cfg(unix)]` 并写清原因，绝不按名字在 CI 里过滤       |

另外两处夹具与平台有关，而不是产品缺陷：Git for Windows 的**系统**配置开着
`core.autocrlf`，而测试自己的 `git` 带 `GIT_CONFIG_NOSYSTEM`，两边看到的换行规则
因此不同——夹具改为在仓库里钉死 `core.autocrlf=false`；Codex 的 trust key 里是
反斜杠，TOML 会把它转义，断言改成解析后再比。

### 第二轮真跑（2026-09-14）：三平台全绿

Windows runner 确认了上面五类修法，然后 `--no-fail-fast`（此前 cargo 在第一个失败的
二进制处就停，六十多个集成套件根本没跑到）又列出了另外几批，连同 Linux / macOS
上的三处偶发，全部改在代码或夹具里，`5bce0440d` 三平台全部通过
（Linux 14 分钟、macOS 10 分钟、Windows 33 分钟）：

| 在哪                            | 是什么                                                                                                                              | 怎么改                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Rust 集成夹具（Windows）        | `/private/armadra` 不是绝对路径；文件名里的换行；worktree 路径用反斜杠；私有状态目录要的是受保护的两条 ACL 而不是 0700              | 夹具按平台给：盘符前缀、空格代替换行、比较前换成正斜杠、`icacls` 写 Host 同款描述符 |
| Go 夹具（Windows）              | `/tmp`、POSIX 权限位、目录名里的 `?`、Windows 临时目录喂给 systemd/launchd 渲染器                                                   | 同上按平台给；渲染器测试对 POSIX 平台用正斜杠样例                                   |
| Go 真缺陷：事件流关闭           | `Hub.Close` 只标记不等待，pump 还在读 outbox 时 store 已关；`database/sql` 又把被取消的事务放到自己的 goroutine 上回滚              | `done` 通道 + `WaitGroup`，Close 等到所有 pump 离开；分页读用 `WithoutCancel`       |
| Go 真缺陷：服务定义按宿主规范化 | Windows 上 `filepath.Clean` 把 launchd/systemd 定义里的 `/` 改成 `\`，渲染器再转义，`Owns` 认不出自己写的文件                       | 按定义所属平台 `path.Clean` / `filepath.Clean`                                      |
| Rust 真缺陷：终端 stale         | resize 过了代次检查才碰到被回收的 pty，非 Conflict 错误直接关 socket，客户端把计划内回收当成掉线                                    | 任何写失败都先问代次动没动，动了先发 `stale`                                        |
| Rust 偶发（Linux / macOS）      | 会话 `ready` 早于文档解析完；跨站 iframe 首次点击被 Chrome 丢掉；旧 screencast 的 WebP 帧还在路上；hook 序号锁 150 ms 不够 8 个并发 | `open()` 等文档文本；循环点击直到帧记录；等到 JPEG 帧为止；等待放宽到 500 ms        |

Windows 上原本担心的三件事都由 runner 回答了：Codex `config.toml` 的路径拼写、
Git for Windows 的系统级 `autocrlf`（夹具钉死后不再影响）、`git submodule add` 的
正斜杠 URL，都没有再出问题。

跨平台编译可以在一台机器上先过一遍，前提是有目标平台的 C 工具链
（Windows SDK 或 glibc sysroot）；没有的话这两条只能由 CI 回答：

```sh
cargo check --workspace --all-targets --target x86_64-pc-windows-msvc
cargo check --workspace --exclude armadra-desktop --all-targets \
  --target x86_64-unknown-linux-gnu
```

Go 侧不需要额外工具链：

```sh
GOOS=windows GOARCH=amd64 go -C apps/host vet ./...
GOOS=linux   GOARCH=amd64 go -C apps/host vet ./...
```
