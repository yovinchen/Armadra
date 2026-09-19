#!/usr/bin/env bash
# Armadra 本地开发脚本：检查 → 安装 → 编译 → 运行，一条命令走完。
#
#   ./armadra.sh doctor          检查工具链（node / pnpm / rust / tmux）
#   ./armadra.sh install         安装依赖（pnpm install + cargo fetch）
#   ./armadra.sh check           代码检查：typecheck + clippy + fmt
#   ./armadra.sh test            全部测试：shared / web / cargo workspace
#   ./armadra.sh build           编译：Rust 二进制（release）+ 前端产物
#   ./armadra.sh build --bundle  额外打出 .app / .dmg
#   ./armadra.sh run             本地运行桌面端（electron-vite dev，前端热更新）
#   ./armadra.sh run web         只跑 Runtime + 浏览器里的前端
#   ./armadra.sh all             install → check → build → run
#
# 任何一步失败脚本立即停止并返回非零。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# 不设 ARMADRA_RUNTIME_PORT 时浏览器模式让内核分配端口，地址从 endpoints.json 读
# （roadmap §4.4）。桌面开发仍需要一个固定端口：Vite 页面在 1420，只能走 TCP。
RUNTIME_PORT="${ARMADRA_RUNTIME_PORT:-}"
DESKTOP_RUNTIME_PORT="${ARMADRA_RUNTIME_PORT:-43120}"
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
  [ "${node_major}" -ge 22 ] || fail "Node 版本过低（$(node -v)），需要 >= 22"
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
  step "编译 Rust 二进制（release）并准备受管二进制"
  cargo build --release -p armadra-runtime -p armadra-hook
  pnpm --filter @armadra/desktop prepare:host --release --native
  step "构建前端"
  pnpm --filter @armadra/shared build
  pnpm --filter @armadra/web build
  if $bundle; then
    step "打包桌面端（.app / .dmg）"
    pnpm --filter @armadra/desktop dist
    ok "产物在 apps/desktop/release/"
  else
    ok "编译完成（加 --bundle 可打包安装包）"
  fi
}

# ---------------------------------------------------------------- run
port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Runtime 数据目录，与 apps/runtime/src/paths.rs 的 data_dir 一致。
armadra_data_dir() {
  if [ -n "${ARMADRA_DATA_DIR:-}" ]; then
    printf '%s' "${ARMADRA_DATA_DIR}"
  elif [ "$(uname -s)" = "Darwin" ]; then
    printf '%s' "${HOME}/Library/Application Support/Armadra"
  else
    printf '%s' "${XDG_DATA_HOME:-${HOME}/.local/share}/armadra"
  fi
}

# endpoints.json 里 runtime 段的 http 地址；文件缺失、损坏或没有该段都输出空串。
runtime_endpoint() {
  node -e '
    const fs = require("node:fs");
    try {
      const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const http = document?.runtime?.http;
      if (typeof http === "string") process.stdout.write(http);
    } catch {}
  ' "$(armadra_data_dir)/endpoints.json" 2>/dev/null || true
}

# 浏览器开发由本脚本持有 Runtime；桌面开发改由桌面壳持有私有控制管道，
# 使关闭前台与明确退出后台具有不同语义。
#
# 不指定端口时按 `--listen tcp:127.0.0.1:0` 启动，实际端口由内核决定并写进
# endpoints.json；本函数把它读回来放进 RUNTIME_URL（roadmap §4.4）。
RUNTIME_URL=""
start_runtime() {
  step "编译 Runtime（debug）"
  cargo build -p armadra-runtime -p armadra-hook
  local listen expected=""
  if [ -n "${RUNTIME_PORT}" ]; then
    listen="tcp:127.0.0.1:${RUNTIME_PORT}"
    expected="http://127.0.0.1:${RUNTIME_PORT}"
    port_in_use "${RUNTIME_PORT}" && fail "端口 ${RUNTIME_PORT} 已被占用（Armadra.app 或上次的 Runtime 还在跑？pkill -f armadra-runtime）"
    step "启动 Runtime（${expected}）"
  else
    listen="tcp:127.0.0.1:0"
    step "启动 Runtime（回环端口由内核分配）"
  fi
  # 旧地址不能当成本次启动的结果：先清掉再等它自己写进来。
  rm -f "$(armadra_data_dir)/endpoints.json" 2>/dev/null || true
  ./target/debug/armadra-runtime --listen "${listen}" &
  RUNTIME_PID=$!
  trap 'kill "${RUNTIME_PID}" 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 40); do
    RUNTIME_URL="$(runtime_endpoint)"
    if [ -n "${RUNTIME_URL}" ] && curl -sf "${RUNTIME_URL}/api/health" >/dev/null 2>&1; then
      break
    fi
    RUNTIME_URL=""
    sleep 0.3
  done
  [ -n "${RUNTIME_URL}" ] || fail "Runtime 未就绪（endpoints.json 没有可用地址）"
  if [ -n "${expected}" ] && [ "${RUNTIME_URL}" != "${expected}" ]; then
    fail "Runtime 报告的地址 ${RUNTIME_URL} 与要求的 ${expected} 不符"
  fi
  ok "Runtime 就绪（${RUNTIME_URL}）"
}

run_desktop() {
  # 桌面壳自己持有 Runtime；开发时钉一个回环端口，因为 Vite 页面在
  # http://127.0.0.1:1420，而壳在这条路上不给页面注入基址。
  port_in_use "${DESKTOP_RUNTIME_PORT}" && fail "端口 ${DESKTOP_RUNTIME_PORT} 已被占用（Armadra.app 或上次的 Runtime 还在跑？pkill -f armadra-runtime）"
  # electron-vite 的 devUrl 固定是 127.0.0.1:1420：被别的项目占住时 vite 会换端口，
  # 桌面壳却会一直等 1420，看起来像卡死。
  port_in_use 1420 && fail "端口 1420 已被占用，桌面开发模式的前端必须跑在 1420（先关掉占用它的进程）"
  step "准备 Go Host（壳按 target/debug 找它）"
  pnpm --filter @armadra/desktop prepare:host --native
  pnpm --filter @armadra/shared build
  step "编译桌面持有的 Runtime（debug）"
  cargo build -p armadra-runtime -p armadra-hook
  step "启动桌面端（关闭窗口保留后台；菜单退出停止后台）"
  ARMADRA_DESKTOP_OWNS_RUNTIME=1 \
    ARMADRA_RUNTIME_LISTEN="tcp:127.0.0.1:${DESKTOP_RUNTIME_PORT}" \
    ARMADRA_RUNTIME_PORT="${DESKTOP_RUNTIME_PORT}" \
    VITE_RUNTIME_URL="http://127.0.0.1:${DESKTOP_RUNTIME_PORT}" pnpm --filter @armadra/desktop dev
}

run_web() {
  port_in_use "${WEB_PORT}" && fail "端口 ${WEB_PORT} 已被占用（用 ARMADRA_WEB_PORT=xxxx 换一个）"
  pnpm --filter @armadra/shared build
  start_runtime
  step "启动前端（http://127.0.0.1:${WEB_PORT}，⌃C 同时结束 Runtime）"
  VITE_RUNTIME_URL="${RUNTIME_URL}" \
    pnpm --filter @armadra/web exec vite --port "${WEB_PORT}" --host 127.0.0.1
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
