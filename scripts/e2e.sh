#!/usr/bin/env bash
# E2E 真实后端启动助手（供 check.sh --e2e 使用）。
# 目标：Playwright 必须连真实 Go 后端（SQLite 持久化 + 真实权限），不得以 mock 作为产品验收。
#
# 用法：
#   scripts/e2e.sh start   准备并启动真实后端，输出可 eval 的环境变量（RSM_E2E_BACKEND）
#   scripts/e2e.sh stop    停止由本助手启动的后端并清理临时 home
#   scripts/e2e.sh status  输出状态
#
# 模式：
#   RSM_E2E_EXTERNAL=1  复用已在 127.0.0.1:8080 运行的真实后端，并且复用已在 0.0.0.0:1111 的 Vite 预览（不重启、不清数据）
#   默认               在独立临时 RSM_HOME 启动刚构建的真实 Go 程序（要求内部 8080 空闲；Vite 由 Playwright 启动在 1111）
# 说明：web/vite.config.ts 代理固定到内部 127.0.0.1:8080；对外页面地址默认 http://127.0.0.1:1111（可用 RSM_E2E_VITE_URL 覆盖）。
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"

ACTION="${1:-start}"
E2E_HOME="$RSM_ROOT/.work/e2e-home"
E2E_STATE="$RSM_ROOT/.work/e2e-state.env"
E2E_LOG="$RSM_ROOT/.work/e2e"
BACKEND_ADDR="127.0.0.1:8080"
BACKEND_URL="http://127.0.0.1:8080"
VITE_URL="${RSM_E2E_VITE_URL:-http://127.0.0.1:1111}"
VITE_ADDR="127.0.0.1:1111"

e2e_health() { http_code "$BACKEND_ADDR" "/healthz" 2; }

e2e_external() { [ "${RSM_E2E_EXTERNAL:-0}" = "1" ]; }

e2e_start_external() {
  _es_code=$(e2e_health)
  [ "$_es_code" = "200" ] || die "RSM_E2E_EXTERNAL=1，但 http://$BACKEND_ADDR/healthz 不可用（状态码 ${_es_code}）。请确认真实后端已启动"
  _es_body=$(http_body "$BACKEND_ADDR" "/healthz" 2)
  ok "复用外部真实后端: ${BACKEND_URL}（${_es_body}）"
  _es_vite=$(http_code "$VITE_ADDR" "/" 2)
  case "$_es_vite" in 200|204|304) : ;; *) warn "外部 Vite 预览 http://$VITE_ADDR/ 未就绪（状态码 ${_es_vite}）；请确认前端联调已启动" ;; esac
  printf 'export RSM_E2E_EXTERNAL=1\nexport RSM_E2E_BACKEND="%s"\nexport RSM_E2E_BASE_URL="%s"\nexport RSM_E2E_HOME=""\n' "$BACKEND_URL" "$VITE_URL" >"$E2E_STATE"
}

e2e_start_isolated() {
  _es_code=$(e2e_health)
  if [ "$_es_code" = "200" ]; then
    die "8080 已被占用（已有服务在运行）。如需复用该真实后端请设置 RSM_E2E_EXTERNAL=1；否则先停止占用 8080 的进程，以便在独立临时 RSM_HOME 中启动真实后端"
  fi
  local pkg
  pkg=$(cat "$RSM_ROOT/build/package.path" 2>/dev/null | head -n1)
  [ -n "$pkg" ] && [ -f "$pkg" ] || die "未找到构建产物 build/package.path，请先运行 scripts/build.sh"
  rm -rf "$E2E_HOME"
  mkdir -p "$E2E_LOG"
  info "解包发行包到临时目录并启动真实后端（home: ${E2E_HOME}）"
  _es_tmp="$RSM_ROOT/.work/e2e-pkg"
  rm -rf "$_es_tmp"; mkdir -p "$_es_tmp"
  tar -xzf "$pkg" -C "$_es_tmp" || die "解包失败: $pkg"
  _es_root=$(find "$_es_tmp" -maxdepth 2 -name release.json -type f | head -n1)
  [ -n "$_es_root" ] || die "发行包内未找到 release.json"
  _es_root=$(dirname "$_es_root")
  ( cd "$_es_root" && RSM_HOME="$E2E_HOME" RSM_ADDR="$BACKEND_ADDR" ./rsm.sh >>"$E2E_LOG/deploy.log" 2>&1 ) || {
    tail_lines "$E2E_LOG/deploy.log" 40 >&2 || true
    die "启动真实后端失败"
  }
  _es_ok=0
  _es_i=0
  while [ "$_es_i" -lt 60 ]; do
    if [ "$(e2e_health)" = "200" ]; then _es_ok=1; break; fi
    sleep 0.5
    _es_i=$((_es_i+1))
  done
  [ "$_es_ok" = "1" ] || { tail_lines "$E2E_HOME/logs/rsm.log" 40 >&2 || true; die "真实后端未在预期时间内通过 /healthz"; }
  _es_body=$(http_body "$BACKEND_ADDR" "/healthz" 2)
  ok "真实后端已启动: ${BACKEND_URL}（${_es_body}）"
  printf 'export RSM_E2E_EXTERNAL=0\nexport RSM_E2E_BACKEND="%s"\nexport RSM_E2E_BASE_URL="%s"\nexport RSM_E2E_HOME="%s"\n' "$BACKEND_URL" "$VITE_URL" "$E2E_HOME" >"$E2E_STATE"
}

e2e_stop() {
  if [ -f "$E2E_STATE" ]; then
    # shellcheck disable=SC1090
    . "$E2E_STATE"
    if [ "${RSM_E2E_EXTERNAL:-0}" != "1" ] && [ -n "${RSM_E2E_HOME:-}" ] && [ -d "$RSM_E2E_HOME" ]; then
      if [ -x "$RSM_E2E_HOME/rsm.sh" ]; then
        ( cd "$RSM_E2E_HOME" && ./rsm.sh stop >>"$E2E_LOG/deploy.log" 2>&1 ) || warn "停止 E2E 后端失败，请检查 $RSM_E2E_HOME"
      fi
      rm -rf "$RSM_E2E_HOME"
      ok "已停止并清理 E2E 临时实例: $RSM_E2E_HOME"
    fi
  fi
  rm -f "$E2E_STATE"
  rm -rf "$RSM_ROOT/.work/e2e-pkg"
}

case "$ACTION" in
  start)
    if e2e_external; then e2e_start_external; else e2e_start_isolated; fi
    ;;
  stop) e2e_stop ;;
  status)
    _s_code=$(e2e_health)
    printf 'backend=%s healthz=%s vite=%s\n' "$BACKEND_URL" "$_s_code" "$VITE_URL"
    [ -f "$E2E_STATE" ] && cat "$E2E_STATE"
    ;;
  *) die "用法: scripts/e2e.sh start|stop|status" ;;
esac
