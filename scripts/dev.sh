#!/usr/bin/env bash
# 开发模式：准备类型/依赖/内嵌占位资源 → 启动内部 Go（127.0.0.1:8080）→ 前台启动 Vite（0.0.0.0:1111，局域网可访问）。
# 浏览器使用 Vite 热更新；Vite 将 /api、/healthz 代理到 Go。
# 环境变量：RSM_BACKEND_PORT（Go 内部端口，默认 8080，需与 vite.config.ts 代理一致）、RSM_VITE_PORT（Vite 对外端口，默认 1111）
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/toolchain.sh"

GO_PORT="${RSM_BACKEND_PORT:-8080}"
VITE_PORT="${RSM_VITE_PORT:-1111}"
VITE_HOST="${RSM_VITE_HOST:-0.0.0.0}"
DEV_HOME="$RSM_ROOT/.work/dev-home"
DEV_BIN="$RSM_ROOT/.work/dev/rsm"
DEV_LOG="$RSM_ROOT/.work/dev"
mkdir -p "$DEV_LOG" "$RSM_ROOT/.work"
assert_supported_platform
ensure_toolchain build

if [ ! -f "$RSM_ROOT/web/src/api/types.gen.ts" ] || [ ! -f "$RSM_ROOT/internal/server/types.gen.go" ]; then
  step "生成接口类型（首次开发）"
  "$SCRIPT_DIR/generate.sh" || die "接口类型生成失败"
fi

# Go 的 //go:embed dist 要求 web/dist 存在；开发时用占位文件即可，Vite 负责真实页面。
if [ ! -f "$RSM_ROOT/web/dist/index.html" ]; then
  info "准备开发用内嵌占位 web/dist/index.html（真实页面由 Vite 提供）"
  mkdir -p "$RSM_ROOT/web/dist"
  {
    printf '<!doctype html>\n<html><head><meta charset="utf-8"><title>RSM dev</title></head>\n'
    printf '<body>开发模式占位页：请访问 Vite 地址 http://127.0.0.1:%s/</body></html>\n' "$VITE_PORT"
  } >"$RSM_ROOT/web/dist/index.html"
fi

# 前端依赖
if [ ! -d "$RSM_ROOT/web/node_modules" ] || [ ! -f "$RSM_ROOT/web/node_modules/.modules.yaml" ]; then
  step "安装前端依赖"
  ( cd "$RSM_ROOT/web" && "$RSM_PNPM_BIN" install --frozen-lockfile ) || die "pnpm install 失败"
fi

if [ "$GO_PORT" != "8080" ]; then
  warn "内部 Go 端口为 ${GO_PORT}，但 web/vite.config.ts 代理固定为 127.0.0.1:8080；请同步修改 vite 代理，或使用默认 8080"
fi
if port_open 127.0.0.1 "$GO_PORT"; then
  die "端口 $GO_PORT 已被占用，无法启动开发后端。请先停止占用进程（或改用其他端口并同步 vite 代理）"
fi
if port_open 127.0.0.1 "$VITE_PORT"; then
  die "对外端口 $VITE_PORT 已被占用（可能是预览/联调实例）。请切换 RSM_VITE_PORT 或先停止占用进程；如需局域网访问请用 0.0.0.0 监听"
fi

step "编译开发用 Go 程序"
mkdir -p "$RSM_ROOT/.work/dev"
( cd "$RSM_ROOT" && CGO_ENABLED=1 "$RSM_GO_BIN" build -trimpath -buildvcs=false -o "$DEV_BIN" ./cmd/rsm ) || die "Go 编译失败"
[ -x "$DEV_BIN" ] || die "开发程序不存在: $DEV_BIN"

rotate_log "$DEV_LOG/rsm.log" 10485760
info "启动内部 Go 后端: http://127.0.0.1:${GO_PORT}（home: ${DEV_HOME}，日志: $DEV_LOG/rsm.log）"
"$DEV_BIN" serve --home "$DEV_HOME" --addr "127.0.0.1:$GO_PORT" >>"$DEV_LOG/rsm.log" 2>&1 &
GO_PID=$!
cleanup_dev() {
  if [ -n "${GO_PID:-}" ] && pid_alive "$GO_PID"; then
    kill -TERM "$GO_PID" 2>/dev/null || true
    wait "$GO_PID" 2>/dev/null || true
  fi
}
trap cleanup_dev EXIT INT TERM HUP
if ! wait_for_cmd 30 bash -c "curl -fsS -o /dev/null http://127.0.0.1:$GO_PORT/healthz 2>/dev/null || exit 1"; then
  warn "Go 后端未在 30 秒内就绪，日志尾部:"
  tail_lines "$DEV_LOG/rsm.log" 40 >&2 || true
  die "开发后端启动失败"
fi
ok "Go 后端已就绪（pid=${GO_PID}）"

printf '\n%s开发环境已启动%s\n' "$C_BOLD" "$C_RESET"
printf '  页面: http://127.0.0.1:%s/ （Vite 热更新）\n' "$VITE_PORT"
printf '  API:  http://127.0.0.1:%s/api （Vite 代理）\n' "$GO_PORT"
printf '  首启: 首次打开页面按提示设置超级管理员密码\n'
printf '  退出: Ctrl-C 会同时停止 Go 后端\n\n'
( cd "$RSM_ROOT/web" && "$RSM_PNPM_BIN" run dev -- --host "$VITE_HOST" --port "$VITE_PORT" --strictPort )
