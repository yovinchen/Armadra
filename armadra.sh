#!/usr/bin/env bash
# Armadra 本地开发脚本：检查 → 安装 → 编译 → 运行，一条命令走完。
#
#   ./armadra.sh doctor          检查工具链（node / pnpm / rust / tmux）
#   ./armadra.sh install         安装依赖（pnpm install + cargo fetch）
#   ./armadra.sh check           代码检查：typecheck + clippy + fmt
#   ./armadra.sh test            全部测试：shared / web / cargo workspace
#   ./armadra.sh build           编译：Rust 二进制（release）+ 前端产物
#   ./armadra.sh build --bundle  额外打出 .app / .dmg
#   ./armadra.sh run             本地运行桌面端（tauri dev，前端热更新）
#   ./armadra.sh run web         只跑 Runtime + 浏览器里的前端
#   ./armadra.sh all             install → check → build → run
#
# 任何一步失败脚本立即停止并返回非零。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RUNTIME_PORT="${ARMADRA_RUNTIME_PORT:-43120}"
WEB_PORT="${ARMADRA_WEB_PORT:-1420}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少 $1：$2"
}

# ---------------------------------------------------------------- doctor
doctor() {
  step "检查工具链"
  need node "https://nodejs.org（>= 22）"
  need pnpm "corepack enable 或 npm i -g pnpm"
  need cargo "https://rustup.rs"
  need rustc "https://rustup.rs"
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] || fail "Node 版本过低（$(node -v)），需要 >= 22"
  ok "node $(node -v)"
  ok "pnpm $(pnpm -v)"
  ok "$(rustc --version)"
  if command -v tmux >/dev/null 2>&1; then
    ok "$(tmux -V)（终端持久化后端）"
  else
    printf '\033[1;33m!\033[0m 未安装 tmux：终端节点将退回直连模式，重启 Runtime 会丢会话（brew install tmux）\n'
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    xcode-select -p >/dev/null 2>&1 || fail "缺少 Xcode Command Line Tools：xcode-select --install"
    ok "Xcode Command Line Tools"
  fi
}

# ---------------------------------------------------------------- install
install_deps() {
  step "安装依赖"
  pnpm install
  cargo fetch
  ok "依赖就绪"
}

# ---------------------------------------------------------------- check
check() {
  step "构建 shared（typecheck 依赖它的产物）"
  pnpm --filter @armadra/shared build
  step "TypeScript 类型检查"
  pnpm -r --if-present typecheck
  step "Rust 格式检查"
  cargo fmt --all --check
  step "Rust clippy（警告即失败）"
  cargo clippy --workspace --all-targets -- -D warnings
  ok "代码检查通过"
}

# ---------------------------------------------------------------- test
run_tests() {
  step "测试：shared"
  pnpm --filter @armadra/shared test
  step "测试：web"
  pnpm --filter @armadra/web test
  step "测试：Rust workspace"
  cargo test --workspace
  ok "全部测试通过"
}

# ---------------------------------------------------------------- build
build() {
  local bundle=false
  [ "${1:-}" = "--bundle" ] && bundle=true
  step "编译 Rust 二进制（release）并准备 Tauri sidecar"
  pnpm --filter @armadra/desktop prepare:sidecar
  step "构建前端"
  pnpm --filter @armadra/shared build
  pnpm --filter @armadra/web build
  if $bundle; then
    step "打包桌面端（.app / .dmg）"
    pnpm --filter @armadra/desktop exec tauri build
    ok "产物在 target/release/bundle/"
  else
    ok "编译完成（加 --bundle 可打包安装包）"
  fi
}

# ---------------------------------------------------------------- run
port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# 开发模式下桌面壳**不会**自己拉起 Runtime（`RuntimeProcess::start` 只在
# `custom-protocol`，也就是打包后的正式构建里生效），所以这里先把 debug
# Runtime 起在后台，再开 tauri dev；⌃C 时一起结束。
start_runtime() {
  step "编译 Runtime（debug）"
  cargo build -p armadra-runtime -p armadra-hook
  step "启动 Runtime（127.0.0.1:$RUNTIME_PORT）"
  ARMADRA_RUNTIME_PORT="$RUNTIME_PORT" ./target/debug/armadra-runtime &
  RUNTIME_PID=$!
  trap 'kill "$RUNTIME_PID" 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$RUNTIME_PORT/api/health" >/dev/null 2>&1 && break
    sleep 0.3
  done
  curl -sf "http://127.0.0.1:$RUNTIME_PORT/api/health" >/dev/null 2>&1 || fail "Runtime 未在 $RUNTIME_PORT 就绪"
  ok "Runtime 就绪"
}

run_desktop() {
  port_in_use "$RUNTIME_PORT" && fail "端口 $RUNTIME_PORT 已被占用（Armadra.app 是否正在运行？）"
  step "准备 sidecar（tauri 的 externalBin 校验要求文件存在）"
  pnpm --filter @armadra/desktop prepare:sidecar
  pnpm --filter @armadra/shared build
  start_runtime
  step "启动桌面端（tauri dev，前端热更新，⌃C 同时结束 Runtime）"
  pnpm --filter @armadra/desktop dev
}

run_web() {
  port_in_use "$RUNTIME_PORT" && fail "端口 $RUNTIME_PORT 已被占用（Armadra.app 是否正在运行？）"
  pnpm --filter @armadra/shared build
  start_runtime
  step "启动前端（http://127.0.0.1:$WEB_PORT，⌃C 同时结束 Runtime）"
  VITE_RUNTIME_URL="http://127.0.0.1:$RUNTIME_PORT" \
    pnpm --filter @armadra/web exec vite --port "$WEB_PORT" --host 127.0.0.1
}

run() {
  case "${1:-desktop}" in
    desktop) run_desktop ;;
    web) run_web ;;
    *) fail "run 只接受 desktop 或 web" ;;
  esac
}

# ---------------------------------------------------------------- main
usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-help}" in
  doctor) doctor ;;
  install) doctor; install_deps ;;
  check) check ;;
  test) run_tests ;;
  build) build "${2:-}" ;;
  run) run "${2:-desktop}" ;;
  all) doctor; install_deps; check; build; run desktop ;;
  help|-h|--help) usage ;;
  *) usage; fail "未知命令：$1" ;;
esac
