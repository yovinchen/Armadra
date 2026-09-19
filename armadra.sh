#!/usr/bin/env bash
# Armadra 本地开发脚本：检查 → 安装 → 编译 → 运行，一条命令走完。
#
#   ./armadra.sh doctor          检查工具链（node / pnpm / tmux）
#   ./armadra.sh install         安装依赖（pnpm install）
#   ./armadra.sh check           代码检查：pnpm check
#   ./armadra.sh test            全部测试：pnpm test
#   ./armadra.sh build           编译：前端与两种壳的产物
#   ./armadra.sh build --bundle  额外打出 .app / .dmg
#   ./armadra.sh run             本地运行桌面端（electron-vite dev，前端热更新）
#   ./armadra.sh run web         只跑 core + 浏览器里的前端
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
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "${node_major}" -ge 22 ] || fail "Node 版本过低（$(node -v)），需要 >= 22"
  ok "node $(node -v)"
  ok "pnpm $(pnpm -v)"
  if command -v tmux >/dev/null 2>&1; then
    ok "$(tmux -V)（终端持久化后端）"
  else
    printf '\033[1;33m!\033[0m 未安装 tmux：终端节点将退回直连模式，重启 core 会丢会话（brew install tmux）\n'
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
  ok "依赖就绪"
}

# ---------------------------------------------------------------- check
check() {
  step "仓库检查（libs:build + 格式 + typecheck + 规则 + 发布自检）"
  pnpm check
  ok "代码检查通过"
}

# ---------------------------------------------------------------- test
run_tests() {
  step "构建 shared（其余包的测试依赖它的产物）"
  pnpm --filter @armadra/shared build
  step "测试：全部工作区包"
  pnpm -r --if-present test
  ok "全部测试通过"
}

# ---------------------------------------------------------------- build
build() {
  local bundle=false
  [ "${1:-}" = "--bundle" ] && bundle=true
  step "构建前端与 core"
  pnpm --filter @armadra/shared build
  pnpm --filter @armadra/web build
  pnpm --filter @armadra/desktop build
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

# core 的数据目录，与 apps/desktop/src/core/paths.ts 的 resolveDataDir 一致。
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

# 浏览器开发由本脚本持有 core；桌面开发改由桌面壳持有私有控制管道，
# 使关闭前台与明确退出后台具有不同语义。
#
# 不指定端口时按 `--listen tcp:127.0.0.1:0` 启动，实际端口由内核决定并写进
# endpoints.json；本函数把它读回来放进 RUNTIME_URL（roadmap §4.4）。
RUNTIME_URL=""
start_runtime() {
  step "构建 core"
  pnpm --filter @armadra/desktop build
  local listen expected=""
  if [ -n "${RUNTIME_PORT}" ]; then
    listen="tcp:127.0.0.1:${RUNTIME_PORT}"
    expected="http://127.0.0.1:${RUNTIME_PORT}"
    port_in_use "${RUNTIME_PORT}" && fail "端口 ${RUNTIME_PORT} 已被占用（Armadra.app 或上次的 core 还在跑？pkill -f 'out/core/main.js'）"
    step "启动 core（${expected}）"
  else
    listen="tcp:127.0.0.1:0"
    step "启动 core（回环端口由内核分配）"
  fi
  # 旧地址不能当成本次启动的结果：先清掉再等它自己写进来。
  rm -f "$(armadra_data_dir)/endpoints.json" 2>/dev/null || true
  node apps/desktop/out/core/main.js --listen "${listen}" &
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
  [ -n "${RUNTIME_URL}" ] || fail "core 未就绪（endpoints.json 没有可用地址）"
  if [ -n "${expected}" ] && [ "${RUNTIME_URL}" != "${expected}" ]; then
    fail "core 报告的地址 ${RUNTIME_URL} 与要求的 ${expected} 不符"
  fi
  ok "core 就绪（${RUNTIME_URL}）"
}

run_desktop() {
  # 桌面壳自己持有 core；开发时钉一个回环端口，因为 Vite 页面在
  # http://127.0.0.1:1420，而壳在这条路上不给页面注入基址。
  port_in_use "${DESKTOP_RUNTIME_PORT}" && fail "端口 ${DESKTOP_RUNTIME_PORT} 已被占用（Armadra.app 或上次的 core 还在跑？pkill -f 'out/core/main.js'）"
  # electron-vite 的 devUrl 固定是 127.0.0.1:1420：被别的项目占住时 vite 会换端口，
  # 桌面壳却会一直等 1420，看起来像卡死。
  port_in_use 1420 && fail "端口 1420 已被占用，桌面开发模式的前端必须跑在 1420（先关掉占用它的进程）"
  pnpm --filter @armadra/shared build
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
  step "启动前端（http://127.0.0.1:${WEB_PORT}，⌃C 同时结束 core）"
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
