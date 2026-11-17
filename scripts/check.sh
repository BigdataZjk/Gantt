#!/usr/bin/env bash
# 检查入口：
#   工具链 → 接口契约生成核对 → 前端依赖 → 构建真实 web/dist（Go embed 需要）→ gofmt（异常即失败）
#   → go vet → go test → 前端 Vitest → build.sh（发行包）→ 包校验 → 临时 RSM_HOME 真实 Go 冒烟。
# 用法：scripts/check.sh [--e2e]
#   --e2e  额外安装 Playwright 浏览器（仅此开关会安装）并对真实 Go 后端执行 E2E。
# E2E 端口：内部 API 固定 127.0.0.1:8080（Vite 代理目标）；对外页面 127.0.0.1:1111（Vite）。
#   RSM_E2E_EXTERNAL=1  复用已在 8080 运行的真实后端与 1111 的 Vite 预览（只校验，不重启、不清数据）
#   未设置              隔离模式：要求 8080 空闲，启动临时 RSM_HOME 的真实后端；Vite 由 Playwright 起在 1111
# 日志与冒烟产物：.work/check-<时间>/、.work/smoke-<时间>/
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/toolchain.sh"

E2E=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --e2e) E2E=1; shift ;;
    --help|-h) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "未知参数: ${1}（可用 --e2e）" ;;
  esac
done

CHECK_ID=$(timestamp_compact)
CHECK_DIR="$RSM_ROOT/.work/check-$CHECK_ID"
SMOKE_DIR="$RSM_ROOT/.work/smoke-$CHECK_ID"
LOG="$CHECK_DIR/check.log"
mkdir -p "$CHECK_DIR" "$SMOKE_DIR" || die "无法创建检查目录"
: >"$LOG"
RSM_LOG_FILE="$LOG"; export RSM_LOG_FILE
_web="$RSM_ROOT/web"
assert_supported_platform

STEPS_TOTAL=0
STEPS_FAILED=0
FAILED_NAMES=""
CURRENT_STEP=""
PACKAGE=""
SMOKE_HOME=""

banner() {
  STEPS_TOTAL=$((STEPS_TOTAL+1))
  CURRENT_STEP="$1"
  printf '\n%s[%s] %s%s\n' "$C_BOLD$C_CYAN" "$STEPS_TOTAL" "$1" "$C_RESET"
  printf '\n===== [%s] %s =====\n' "$STEPS_TOTAL" "$1" >>"$LOG"
}
step_ok()   { ok "$CURRENT_STEP 通过"; }
step_fail() {
  STEPS_FAILED=$((STEPS_FAILED+1))
  FAILED_NAMES="$FAILED_NAMES $CURRENT_STEP"
  warn "$CURRENT_STEP 失败"
  printf '步骤失败: %s\n' "$CURRENT_STEP" >>"$LOG"
}
run_step() {
  banner "$1"; shift
  if "$@" 2>&1 | tee -a "$LOG"; then step_ok; return 0; fi
  step_fail; return 1
}

cleanup_all() {
  if [ -n "${SMOKE_HOME:-}" ] && [ -x "$SMOKE_HOME/rsm.sh" ]; then
    ( cd "$SMOKE_HOME" && ./rsm.sh stop >>"$LOG" 2>&1 ) || true
  fi
  if [ -f "$RSM_ROOT/.work/e2e-state.env" ]; then
    "$SCRIPT_DIR/e2e.sh" stop >>"$LOG" 2>&1 || true
  fi
}
trap cleanup_all EXIT INT TERM HUP

printf 'RSM 检查（%s，%s %s）\n' "$CHECK_ID" "$(os_pretty)" "$(platform_key)"
printf '日志: %s\n' "$LOG"

# 1. 构建工具链与 C 编译器（固定 .tools；系统模式亦可）
run_step "构建工具链与 C 编译器" "$SCRIPT_DIR/bootstrap.sh" --ensure-build
ensure_toolchain build >/dev/null 2>&1 || die "工具链准备失败（可单独运行 scripts/bootstrap.sh 查看原因）"
run_step "部署脚本回归（隔离服务管理器）" bash "$SCRIPT_DIR/tests/deploy.sh"
run_step "接口类型复用回归（隔离生成器）" bash "$SCRIPT_DIR/tests/codegen.sh"

# 2. 接口契约生成核对
run_step "接口契约生成核对（generate --check）" "$SCRIPT_DIR/generate.sh" --check

# 3. 前端依赖（必须在 Go vet/test/build 之前，因为 Go embed 需要真实 web/dist）
_need_install=0
if [ ! -d "$_web/node_modules" ] || [ ! -f "$_web/node_modules/.modules.yaml" ]; then _need_install=1
elif [ "$_web/pnpm-lock.yaml" -nt "$_web/node_modules/.modules.yaml" ] 2>/dev/null; then _need_install=1; fi
if [ "$_need_install" = "1" ]; then
  run_step "安装前端依赖（pnpm install --frozen-lockfile）" bash -c "cd '$_web' && '$RSM_PNPM_BIN' install --frozen-lockfile"
else
  banner "安装前端依赖"; info "node_modules 已就绪且锁文件未更新，跳过安装"; step_ok
fi

# 4. 构建真实前端 dist（Go 的 //go:embed dist 在 vet/test/build 前必须存在；不删除、不占位）
build_frontend_dist() {
  [ -f "$_web/package.json" ] || die "缺少 web/package.json"
  ( cd "$_web" && "$RSM_PNPM_BIN" run build ) || die "前端构建失败（pnpm run build）"
  [ -f "$_web/dist/index.html" ] || die "前端构建产物缺少 web/dist/index.html"
  ok "真实 web/dist 已生成（供 Go embed 与 Vet/Test/Build 使用）"
}
run_step "构建真实前端 web/dist（Go embed 前置）" build_frontend_dist

# 5. gofmt：未格式化即失败
gofmt_check() {
  _gf_out=$( cd "$RSM_ROOT" && gofmt -l cmd internal 2>&1 )
  _gf_rc=$?
  if [ "$_gf_rc" -ne 0 ]; then
    printf '%s\n' "$_gf_out" >&2
    die "gofmt 执行失败"
  fi
  if [ -n "$_gf_out" ]; then
    printf '%s\n' "$_gf_out" >&2
    die "以下 Go 文件未 gofmt（请运行 gofmt -w 修复）"
  fi
  ok "gofmt 格式一致"
}
run_step "gofmt 格式检查（异常即失败）" gofmt_check

# 6. go vet
run_step "go vet（go vet ./...）" bash -c "cd '$RSM_ROOT' && '$RSM_GO_BIN' vet ./..."

# 7. Go 测试
run_step "Go 测试（go test ./...）" bash -c "cd '$RSM_ROOT' && '$RSM_GO_BIN' test ./..."

# 8. 前端 Vitest
run_step "前端 Vitest" bash -c "cd '$_web' && '$RSM_PNPM_BIN' run test"

# 9. 构建发行包（包含再次 pnpm build 与 Go 编译、打包）
run_step "构建发行包（scripts/build.sh）" "$SCRIPT_DIR/build.sh"
PACKAGE=$(cat "$RSM_ROOT/build/package.path" 2>/dev/null | head -n1)

# 10. 构建产物校验
banner "构建产物校验与 SHA256"
if [ -z "${PACKAGE:-}" ] || [ ! -f "$PACKAGE" ]; then
  warn "未找到 build/package.path 或发行包不存在"; step_fail
else
  printf '发行包: %s（%s）\n' "$PACKAGE" "$(human_size "$(file_size "$PACKAGE")")" | tee -a "$LOG"
  if [ -f "$PACKAGE.sha256" ] && [ "$(sha256_file "$PACKAGE")" = "$(head -n1 "$PACKAGE.sha256")" ]; then
    step_ok
  else
    warn "发行包 SHA256 校验失败或无 .sha256 文件"; step_fail
  fi
fi

# 11. 临时 RSM_HOME 冒烟：真实 Go 后端、备份校验、恢复、启停（随机空闲端口，不占 1111/8080）
smoke_test() {
  [ -n "${PACKAGE:-}" ] && [ -f "$PACKAGE" ] || die "缺少发行包，无法冒烟"
  _port=$(free_port) || die "找不到空闲端口"
  _home="$SMOKE_DIR/home"
  _pkg_root="$SMOKE_DIR/pkg"
  mkdir -p "$_pkg_root"
  tar -xzf "$PACKAGE" -C "$_pkg_root" || die "解包发行包失败"
  _root=$(find "$_pkg_root" -maxdepth 2 -name release.json -type f | head -n1)
  [ -n "$_root" ] || die "发行包缺少 release.json"
  _root=$(dirname "$_root")
  SMOKE_HOME="$_home"; export SMOKE_HOME
  rm -rf "$_home"
  ( cd "$_root" && RSM_HOME="$_home" RSM_ADDR="127.0.0.1:$_port" ./rsm.sh >>"$LOG" 2>&1 ) || die "首次部署失败（详见 ${LOG}）"
  _code=$(http_code "127.0.0.1:$_port" "/healthz" 2)
  [ "$_code" = "200" ] || die "健康检查失败（状态码 ${_code}）"
  _body=$(http_body "127.0.0.1:$_port" "/healthz" 2)
  _ver=$(json_field_from_body "$_body" version)
  [ -n "$_ver" ] || die "healthz 未返回 version: $_body"
  printf 'healthz: %s\n' "$_body" | tee -a "$LOG"
  _state_code=$(http_code "127.0.0.1:$_port" "/api/state" 2)
  [ "$_state_code" = "200" ] || die "/api/state 状态异常: $_state_code"
  ( cd "$_home" && ./rsm.sh status >>"$LOG" 2>&1 ) || die "status 失败"
  ( cd "$_home" && ./rsm.sh backup >>"$LOG" 2>&1 ) || die "备份失败"
  _bk=$(ls -t "$_home"/backups/*.tar.gz 2>/dev/null | head -n1) || true
  [ -n "$_bk" ] || die "未找到备份文件"
  ( cd "$_home" && ./rsm.sh verify-backup "$_bk" >>"$LOG" 2>&1 ) || die "备份校验失败"
  ( cd "$_home" && ./rsm.sh stop >>"$LOG" 2>&1 ) || die "停止失败"
  ( cd "$_home" && ./rsm.sh restore "$_bk" --yes >>"$LOG" 2>&1 ) || die "恢复失败"
  _code2=$(http_code "127.0.0.1:$_port" "/healthz" 2)
  [ "$_code2" = "200" ] || die "恢复后健康检查失败（状态码 ${_code2}）"
  ( cd "$_home" && ./rsm.sh stop >>"$LOG" 2>&1 ) || die "最终停止失败"
  ok "冒烟通过：部署/健康检查/状态/备份/校验/停止/恢复/再启动/停止（临时 home: ${_home}）"
  printf '冒烟 home: %s（已停止，可用于排查）\n' "$_home" | tee -a "$LOG"
}
run_step "临时 RSM_HOME 冒烟测试（真实 Go 后端）" smoke_test

# 12. 可选 E2E：真实后端 + Playwright（仅 --e2e 安装浏览器）
if [ "$E2E" = "1" ]; then
  banner "安装 Playwright 浏览器（仅 --e2e）"
  if ( cd "$_web" && "$RSM_PNPM_BIN" exec playwright install chromium ) 2>&1 | tee -a "$LOG"; then
    step_ok
  else
    warn "Playwright 浏览器安装失败（网络受限可预先安装）"; step_fail
  fi

  banner "E2E（真实 Go 后端，不使用 mock）"
  if "$SCRIPT_DIR/e2e.sh" start 2>&1 | tee -a "$LOG"; then
    if grep -q 'RSM_E2E_MOCK' "$_web/playwright.config.ts" 2>/dev/null; then
      info "检测到 RSM_E2E_MOCK 开关；本次不设置该变量，E2E 将连接真实后端"
    fi
    # shellcheck disable=SC1090
    . "$RSM_ROOT/.work/e2e-state.env" 2>/dev/null || true
    _e2e_ext="${RSM_E2E_EXTERNAL:-0}"
    _e2e_base="${RSM_E2E_BASE_URL:-}"
    if ( cd "$_web" && RSM_E2E_EXTERNAL="$_e2e_ext" RSM_E2E_BASE_URL="$_e2e_base" "$RSM_PNPM_BIN" run test:e2e ) 2>&1 | tee -a "$LOG"; then
      step_ok
    else
      step_fail
    fi
    "$SCRIPT_DIR/e2e.sh" stop >>"$LOG" 2>&1 || true
  else
    step_fail
  fi
fi

printf '\n%s检查汇总%s（日志: %s）\n' "$C_BOLD" "$C_RESET" "$LOG"
printf '  步骤: %s 个，失败: %s 个\n' "$STEPS_TOTAL" "$STEPS_FAILED"
if [ "$STEPS_FAILED" -gt 0 ]; then
  printf '  失败步骤:%s\n' "$FAILED_NAMES"
  exit 1
fi
ok "全部检查通过"
