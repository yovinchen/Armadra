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
9. 桌面壳 `cargo check -p armadra-desktop --all-targets`
10. 只在 Linux 上：Host 交叉编译 windows/amd64、darwin/arm64、linux/arm64

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
- **桌面壳只 `cargo check`。** 打包是发布流水线的事。`tauri-build` 要求
  `externalBin` 指向的文件存在，所以 CI 先跑
  `pnpm --filter @armadra/desktop prepare:sidecar-placeholders`，落四个空文件；
  真正要出包时用 `prepare:sidecar`（会完整 `--release` 编译 Runtime、hook 与
  Go Host）。

缓存：`actions/setup-node` 的 `cache: pnpm`、`actions/setup-go` 按
`apps/host/go.sum`、`Swatinem/rust-cache` 按矩阵标签分键。

## 2. release.yml

触发：推 `v*` 标签，或 `workflow_dispatch` 手动运行。手动运行可以给一个 `tag`
（补发那个标签），也可以留空（在当前分支上演练）。`dry_run` 默认勾选，此时全部
作业照跑但不创建 Release。`concurrency` 不取消进行中的发布。

**版本住在仓库里，标签只是指向它的名字。** 这一点与许多流水线相反，也与
LiveAgent 相反——它用 `prepare-app-version-from-tag.mjs` 从标签解出版本、写进一份
生成的 Tauri 配置，仓库里根本不存版本。我们不这么做，因为版本在四个文件里
（`Cargo.toml` 是源，另外三处与它一致，见 `tools/release/version.mjs`），Host 与
外壳都会自报它，更新检查比的也是它。于是方向反过来：`verify` 要求
**标签等于仓库版本**，不等就拒绝发布，而不是让标签去覆盖代码里的版本。

工作流里的所有 checkout 都用 `ref: ${{ inputs.tag || github.sha }}`：手动补发一个
标签时，构建的必须是那个标签的树，而不是触发它的分支的 HEAD。

| 作业       | runner         | 做什么                                                  |
| ---------- | -------------- | ------------------------------------------------------- |
| `verify`   | ubuntu-latest  | 四处版本与标签一致、全量测试、工作流与发布脚本自检      |
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

Tauri 的 bundler 按各平台自己的习惯命名：`Armadra_0.1.0_x64_en-US.msi`、
`armadra_0.1.0_amd64.deb`、`Armadra_0.1.0_aarch64.dmg`。这些名字里读不出 Host
认得的目标——`assetTarget` 在 `x64`、`amd64` 和光秃秃的 `aarch64` 里什么都找不到，
于是 `assemble` 会判它们「declares no target the Host can read」。直接上传等于发了
一堆 Host 永远不会提供给任何客户端的桌面产物。

`tools/release/stage-desktop.mjs` 负责这次改名：按 `desktopAssets()` 声明的 `kind`
去 `bundle/<子目录>` 里按后缀找到那一个文件，复制成 `artifacts.mjs` 规定的名字，
并把 Tauri 写在旁边的 `.sig` 一起带走（`latest.json` 要读它）。按后缀而不是按全名
匹配，是因为上面那些名字里的语言代码、小写产品名和架构拼写随时可能被 Tauri 改掉。
缺了本该有的包就在这里失败，而不是等 `assemble`。

没有 `TAURI_SIGNING_PRIVATE_KEY` 时 `signing.mjs` 会关掉 `createUpdaterArtifacts`，
macOS 的 `.app.tar.gz` 根本不会产出——这是正常的未签名构建，所以 `--require-updater`
只在有密钥时传，缺了签名包才算失败。

每平台的 `bundle.targets` 写在 `tauri.linux.conf.json`、`tauri.macos.conf.json`、
`tauri.windows.conf.json` 里（Tauri 2 自动合并这三个文件名，不必在命令行传
`--config`；LiveAgent 用的是 `tauri.<平台>.release.conf.json` 这种不会被自动合并的
名字，所以它必须显式传）。写死目标列表而不是沿用 `"all"`：`"all"` 的含义由 Tauri
版本决定，而这份列表必须和 `desktopAssets()` 一一对应。

| 平台    | bundle.targets           | 发布的桌面产物                            |
| ------- | ------------------------ | ----------------------------------------- |
| macOS   | `app`、`dmg`             | `.app.tar.gz`（updater）、`.dmg`          |
| Windows | `msi`、`nsis`            | `-setup.exe`（updater）、`.msi`、便携 zip |
| Linux   | `appimage`、`deb`、`rpm` | `.AppImage`（updater）、`.deb`、`.rpm`    |

macOS 的 `app` 不是可选的：`.app.tar.gz` 是从 `.app` 产出的，只打 `dmg` 就没有
updater 能应用的包。

### 2.3 Windows 便携版

便携 zip 不是 Tauri 的产物，由 `stage-desktop.mjs` 从 `target/release/` 直接打包。
LiveAgent 的便携版就是一个 exe，我们不能照抄：外壳在生产构建里是**从自己旁边**找
`armadra-host`（`apps/desktop/src-tauri/src/host/launch.rs`）与其余 sidecar 的，
只装一个 `Armadra.exe` 的 zip 会启动然后找不到任何东西。所以 zip 里是平铺的
`Armadra.exe` + `armadra-runtime.exe` + `armadra-hook.exe` +
`armadra-session-host.exe` + `armadra-host.exe`，名字都去掉了三元组后缀——
Tauri 暂存 sidecar 时写的是 `<binary>-<triple>.exe`，装好之后旁边的那份是不带的。
少任何一个就直接失败，不会打出一个装得上、跑不起来的 zip。

便携版不是 updater 目标：解压到哪儿由用户决定，没有一个「已安装的位置」可供替换，
写进 `latest.json` 等于承诺一次做不到的更新。

### 2.4 AppImage 里自带的 Wayland 库

linuxdeploy 会把 `libwayland-client/cursor/egl` 随 GTK 栈一起塞进 AppImage。
Wayland 客户端库不是自包含的：它要和**宿主**正在跑的合成器说话，还会加载宿主自己的
EGL 与 libdecor 模块。镜像里自带一份，等于把同一套协议的两个版本混在一起，结果是
在 AppImage 本来要服务的那些机器上开出一个白窗口，或者死在 `wl_display_connect`。
`tools/release/postprocess-linux-appimage.sh`（照搬 LiveAgent 的思路）把它们删掉
再重新打包，让镜像用宿主自己的那份。

几点与 LiveAgent 不同：

- **是否还需要，只有真 runner 能回答。** Tauri 2.11 是否仍然打包这些库没法在本机
  验证，所以脚本在「一个都没找到」时打印一行说明并 **exit 0**，而不是像 LiveAgent
  那样失败。看到那行说明就意味着这一步可以删了。
- **appimagetool 优先复用 Tauri 已下载的那份**（`~/.cache/tauri/`），
  其次才是钉了 sha256 的 x86_64 官方发布。LiveAgent 只发 x86_64，我们有 arm64 行，
  而 `appimagetool-x86_64.AppImage` 在 arm64 上根本跑不起来；复用 Tauri 自己按架构
  取的那份是唯一在两边都成立的做法。
- 重新打包会让 Tauri 的 `.sig` 对不上字节，脚本因此删掉它，工作流紧接着用
  `tauri signer sign` 补签（只在本来就签过时补）。

### 2.5 各平台的系统依赖与缓存

- **Linux**：`libwebkit2gtk-4.1-dev`、`libsoup-3.0-dev`、
  `libjavascriptcoregtk-4.1-dev`、`libgtk-3-dev`、
  `libayatana-appindicator3-dev`、`librsvg2-dev`、`libssl-dev`、`libxdo-dev`、
  `patchelf`、`rpm`、`build-essential`、`curl`、`wget`、`file`。AppImage 要 `file`
  与 `patchelf`，托盘要 appindicator，`.rpm` 要 `rpm` 包提供的 `rpmbuild`
  （LiveAgent 也装它）。`objdump` 由 `build-essential` 带来的 binutils 提供，
  §2.1 的基线校验需要它。
- **Windows**：WiX（MSI）与 NSIS（setup.exe）由 `tauri-cli` 自己下载，不需要
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

证书自己导进一个临时钥匙串，而不是把 `APPLE_CERTIFICATE` 交给 tauri 去导
（LiveAgent 的做法）。差别只有一个，但是决定性的：**失败的时刻**。证书或口令不对
时，`security import` + `security find-identity` 在十秒内就红；交给打包器则要等
整个 Rust 构建、前端构建和 bundling 跑完才在最后一步失败。这和
`apps/desktop/scripts/signing.mjs` 把更新签名判断提到编译之前是同一个道理。

两种机制不能并用：`APPLE_CERTIFICATE` 一旦非空，tauri 会另建一个钥匙串并设为默认，
把这里导入的那张顶掉。所以工作流不再向环境注入 `APPLE_CERTIFICATE`。

关键的几行与它们的理由：

- `security set-keychain-settings -lut 21600`：锁定超时要比最长的一次构建还长，
  钥匙串锁上就再也签不动了。
- `security set-key-partition-list -S apple-tool:,apple:,codesign:`：没有它，
  `codesign` 会弹一个没人能点的「允许访问」对话框并超时。
- `security default-keychain -s`：tauri 从默认钥匙串里找身份。
- 没给 `APPLE_SIGNING_IDENTITY` 时，从 `find-identity` 的输出里取第一条。
- 构建结束后 `if: always()` 删掉钥匙串。

公证用 `xcrun notarytool store-credentials armadra-notary --validate` 预检：
`--validate` 会真的去问一次 Apple，凭据不对在这里报错，而不是在打包末尾排队等公证
时。预检通过后把 `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_PASSWORD` 写进 `GITHUB_ENV`，
公证与装订由 tauri 的 bundler 在打包末尾完成。

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

| Secret                               | 谁用                             | 缺了会怎样                                 |
| ------------------------------------ | -------------------------------- | ------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | tauri updater 签名               | `signing.mjs` 判为 skip，关掉 updater 产物 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 同上（密钥有口令时）             | 密钥有口令却没给 → tauri 在签名那步失败    |
| `APPLE_CERTIFICATE_P12_BASE64`       | macOS 代码签名（base64 的 .p12） | 不签名，首次打开有 Gatekeeper 提示         |
| `APPLE_CERTIFICATE_PASSWORD`         | 导入上面的证书                   | 同上                                       |
| `APPLE_SIGNING_IDENTITY`             | 指定用哪张证书；缺则取第一张     | 钥匙串里有多张时可能选错                   |
| `APPLE_ID` / `APPLE_TEAM_ID`         | 公证                             | 不公证，`notarize` 作业把 macOS 列进说明   |
| `APPLE_APP_SPECIFIC_PASSWORD`        | 公证用的 app 专用密码            | 同上                                       |
| `ARMADRA_RELEASE_SIGNING_KEY`        | `SHA256SUMS` 的 minisign 签名    | 校验列表不带签名                           |
| `WINDOWS_CERT_BASE64`                | 只用于「有没有」的判断           | Windows 被列进未签名平台                   |

证书与公证密码两个名字沿用 LiveAgent 的拼写；工作流同时接受早先的
`APPLE_CERTIFICATE` 与 `APPLE_PASSWORD`（`${{ secrets.A || secrets.B }}`），
已经配好的仓库不用改 secret。

工作流只把**非空**的 secret 写进环境（`解出本次可用的更新签名变量` 那一步）。
原因：`tauri` 看到空字符串的签名变量会当成「有密钥」，然后在打包最后一步失败；
没有密钥时要的是跳过，不是一个更晚、更难读的错误。macOS 的证书与公证凭据走
§2.6 的两个预检步骤，同样是「缺了就跳过并告警」。

`GITHUB_TOKEN`：`release.yml` 顶层声明 `permissions: contents: write`，
`assemble` 用它 `gh release create --draft`。`ci.yml` 是 `contents: read`。
工作流永远不会把 Release 从 draft 转正——那一步是人的动作。

更新地址不写进仓库。`tauri.conf.json` 的 `plugins.updater.endpoints` 保持为空，
CI 通过 `ARMADRA_UPDATER_ENDPOINTS` 注入，`signing.mjs` 把它与签名判断合成同一个
`--config`（`tauri build` 只认最后一个 `--config`）。

打包这一步走 `pnpm --filter @armadra/desktop build`，也就是
`apps/desktop/scripts/build.mjs`，而不是直接 `tauri build`：签名判断必须发生在
编译之前，否则缺密钥的失败要等二十分钟才出现。该脚本用 Node 直接启动
`@tauri-apps/cli/tauri.js`——Windows 上包管理器是 `.cmd`，`execFileSync` 不带
shell 启动不了它。

## 4. 本地怎么先验

```sh
pnpm ci:workflows      # 两份工作流的结构、runner 标签与矩阵三元组
pnpm release:test      # tools/release 与 tools/ci 的单元测试
pnpm release:check     # 四处版本一致、兼容范围包含本版本
pnpm release:dry-run   # 把一次完整发布（38 个产物）落到临时目录并校验
go run github.com/rhysd/actionlint/cmd/actionlint@latest \
  .github/workflows/ci.yml .github/workflows/release.yml
```

下面这些只有真 runner 能回答，本机无从验证，列在这里免得下次有人以为它们已经过：

- `ubuntu-22.04` / `ubuntu-22.04-arm` 上 WebKitGTK 与 Tauri 2.11 的组合是否打得出
  三种包（22.04 的 `libwebkit2gtk-4.1-dev` 比 24.04 老一档）；
- Tauri 2.11 是否仍然往 AppImage 里塞 libwayland（§2.4 的脚本会说）；
- arm64 上 Tauri 的 AppImage 打包与 `~/.cache/tauri` 里 appimagetool 的文件名；
- Apple 证书导入、`notarytool --validate` 与 bundler 的公证（要真 secret）；
- Windows 便携 zip 里那五个 exe 解压后能不能真的互相找到。

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
