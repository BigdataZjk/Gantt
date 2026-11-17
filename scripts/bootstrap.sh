#!/usr/bin/env bash
# 源码构建依赖准备：固定版本工具链（Go/Node/pnpm）下载校验安装到 .tools，CGO 编译器探测。
# 用法：
#   scripts/bootstrap.sh              确保构建依赖（工具链 + C 编译器）
#   scripts/bootstrap.sh --ensure-tools  只确保 Go/Node/pnpm（生成接口类型所需，不含 C 编译器）
#   scripts/bootstrap.sh --check      只检查并输出状态（不下载/不安装；未就绪退出 1）
# 环境变量：
#   RSM_TOOLCHAIN_MODE=system  直接复用 PATH 上的 go/node/pnpm（版本需满足最低要求，不下载 .tools）
#   RSM_CC=/path/to/clang      指定 C 编译器（仍会做真实编译探测）
#   RSM_CLT_WAIT_SECONDS=300   macOS 等待 Command Line Tools 安装的秒数
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/toolchain.sh"
trap progress_stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

MODE="build"
case "${1:-}" in
  --check) MODE="check" ;;
  --ensure-tools|--tools) MODE="tools" ;;
  --ensure-build|"") MODE="build" ;;
  --help|-h) sed -n '2,10p' "$0"; exit 0 ;;
  *) die "未知参数: ${1}（可用 --check / --ensure-tools / --ensure-build）" ;;
esac

assert_supported_platform
setup_build_cache_env

if [ "$MODE" = "check" ]; then
  printf 'RSM 构建依赖检查（%s）\n' "$(platform_key)"
  printf '固定版本: Go %s / Node %s LTS / pnpm %s\n' "$(tc_go_version)" "$(tc_node_version)" "$(tc_pnpm_version)"
  printf '工具目录: %s\n\n' "$TOOLS_DIR"
  rc=0
  if load_toolchain_env >/dev/null 2>&1; then
    toolchain_status
  elif [ "${RSM_TOOLCHAIN_MODE:-pinned}" = "system" ]; then
    printf '模式: 复用系统工具链\n'
    if ( resolve_system_toolchain ); then rc=0; else printf '系统工具链不满足要求\n'; rc=1; fi
  else
    printf '固定工具链: 尚未安装到 .tools（运行不带参数的 bootstrap.sh 自动下载）\n'
    printf '系统 Go : %s\n' "$(command -v go 2>/dev/null || echo '未找到')"
    printf '系统 Node: %s\n' "$(command -v node 2>/dev/null || echo '未找到')"
    printf '系统 pnpm: %s\n' "$(command -v pnpm 2>/dev/null || echo '未找到')"
    rc=1
  fi
  if _cc=$(detect_c_compiler); then
    printf 'C 编译器: %s（可用）\n' "$_cc"
  else
    printf 'C 编译器: 不可用（CGO 构建需要；macOS 需 Command Line Tools）\n'
    rc=1
  fi
  exit "$rc"
fi

step "准备源码构建工具链（固定版本，安装到 .tools；不替换系统工具）"
init_task_log
if [ "$MODE" = "tools" ]; then
  ensure_toolchain tools
else
  ensure_toolchain build
fi

printf '\n'
toolchain_status
if [ -n "${CC:-}" ]; then printf 'C 编译器: %s\n' "$CC"; fi
ok "构建依赖已就绪"
