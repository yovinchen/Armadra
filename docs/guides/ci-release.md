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

触发：推 `v*` 标签，或 `workflow_dispatch` 手动运行。手动运行的
`dry_run` 默认勾选，此时全部作业照跑但不创建 Release；取消勾选且在标签上运行
才会创建 draft。`concurrency` 不取消进行中的发布。

| 作业       | runner         | 做什么                                                  |
| ---------- | -------------- | ------------------------------------------------------- |
| `verify`   | ubuntu-latest  | 四处版本与标签一致、全量测试、工作流与发布脚本自检      |
| `build`    | 六行矩阵，见下 | 打桌面包与组件包，上传 `release-<target>`               |
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
| `ubuntu-24.04`     | linux-x86_64    | x86_64-unknown-linux-gnu  |
| `ubuntu-24.04-arm` | linux-aarch64   | aarch64-unknown-linux-gnu |
| `windows-2022`     | windows-x86_64  | x86_64-pc-windows-msvc    |
| `windows-11-arm`   | windows-aarch64 | aarch64-pc-windows-msvc   |

`ubuntu-24.04-arm` 与 `windows-11-arm` 只对公开仓库免费。仓库转私有时这两行要
换成自托管 runner，或者删掉并同步收窄 `TARGETS`。

各平台的系统依赖：

- **Linux**：`libwebkit2gtk-4.1-dev`、`libsoup-3.0-dev`、
  `libjavascriptcoregtk-4.1-dev`、`libgtk-3-dev`、
  `libayatana-appindicator3-dev`、`librsvg2-dev`、`libssl-dev`、`libxdo-dev`、
  `patchelf`、`build-essential`、`curl`、`wget`、`file`。AppImage 要 `file` 与
  `patchelf`，托盘要 appindicator。
- **Windows**：WiX（MSI）与 NSIS（setup.exe）由 `tauri-cli` 自己下载，不需要
  预装。组件包是 `.zip`，而 `zip` 不在每个 Windows runner 的默认 PATH 上，
  `tools/release/package-components.mjs` 会退回镜像自带的 7-Zip，不额外装东西。
- **macOS**：不需要额外依赖。签名与公证见下。

## 3. 密钥清单

全部是 GitHub 仓库 secret。**一个都没有时发布仍然跑得通**：产物是未签名的，
`assemble` 会把这件事写进 Release 说明顶部，`latest.json` 会把没有签名的
updater 包排除在外。

| Secret                                          | 谁用                             | 缺了会怎样                                 |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`                     | tauri updater 签名               | `signing.mjs` 判为 skip，关掉 updater 产物 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`            | 同上（密钥有口令时）             | 密钥有口令却没给 → tauri 在签名那步失败    |
| `APPLE_CERTIFICATE`                             | macOS 代码签名（base64 的 .p12） | 不签名，首次打开有 Gatekeeper 提示         |
| `APPLE_CERTIFICATE_PASSWORD`                    | 导入上面的证书                   | 同上                                       |
| `APPLE_SIGNING_IDENTITY`                        | 选用哪张证书                     | 同上                                       |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公证                             | 不公证，`notarize` 作业把 macOS 列进说明   |
| `ARMADRA_RELEASE_SIGNING_KEY`                   | `SHA256SUMS` 的 minisign 签名    | 校验列表不带签名                           |
| `WINDOWS_CERT_BASE64`                           | 只用于「有没有」的判断           | Windows 被列进未签名平台                   |

工作流只把**非空**的 secret 写进环境（`解出本次可用的签名与公证变量` 那一步）。
原因：`tauri` 看到空字符串的 `APPLE_CERTIFICATE` 会当成「有证书」去导入钥匙串，
然后失败；没有密钥时要的是跳过，不是一个更晚、更难读的错误。

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
pnpm release:dry-run   # 把一次完整发布（36 个产物）落到临时目录并校验
actionlint             # 可选：YAML 与表达式的静态检查
```

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
