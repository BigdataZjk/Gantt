#!/usr/bin/env bash
# 源码构建：安装依赖 → 校验/按需生成接口类型 → 构建前端 → 编译 Go（内嵌前端）→ 打开发行包。
# 用法：scripts/build.sh [--version V] [--out-dir DIR]
#   --version  指定发行版本（默认 RSM_VERSION 环境变量；否则 git 精确 tag；否则 web/package.json 的版本）
#   --out-dir  输出目录（默认仓库 build/）
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/toolchain.sh"
trap progress_stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

VERSION_ARG=""
OUT_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || die "--version 缺少取值"; VERSION_ARG="$2"; shift 2 ;;
    --version=*) VERSION_ARG="${1#*=}"; shift ;;
    --out-dir) [ "$#" -ge 2 ] || die "--out-dir 缺少取值"; OUT_DIR="$2"; shift 2 ;;
    --out-dir=*) OUT_DIR="${1#*=}"; shift ;;
    --help|-h) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

assert_supported_platform
[ -f "$RSM_ROOT/api/openapi.yaml" ] || die "缺少接口契约 api/openapi.yaml"
[ -f "$RSM_ROOT/cmd/rsm/main.go" ] || die "缺少 cmd/rsm/main.go"
[ -f "$RSM_ROOT/web/package.json" ] || die "缺少 web/package.json"
[ -f "$RSM_ROOT/web/assets.go" ] || die "缺少 web/assets.go（前端资源嵌入入口）"

if [ -z "$OUT_DIR" ]; then OUT_DIR="$RSM_ROOT/build"; fi
OUT_DIR=$(abs_path "$OUT_DIR") || die "无法解析输出目录: $OUT_DIR"
mkdir -p "$OUT_DIR" || die "无法创建输出目录: $OUT_DIR"

init_task_log
ensure_toolchain build

# 版本：--version > RSM_VERSION > git 精确 tag > 项目版本。
if [ -n "$VERSION_ARG" ]; then
  VERSION="$VERSION_ARG"
elif [ -n "${RSM_VERSION:-}" ]; then
  VERSION="$RSM_VERSION"
else
  VERSION=""
  if have_cmd git && [ -d "$RSM_ROOT/.git" ]; then
    _bt=$( cd "$RSM_ROOT" && git describe --tags --exact-match HEAD 2>/dev/null || true )
    case "$_bt" in
      v[0-9]*) VERSION="${_bt#v}" ;;
      [0-9]*) VERSION="$_bt" ;;
    esac
  fi
  if [ -z "$VERSION" ]; then
    VERSION=$(json_get "$RSM_ROOT/web/package.json" version) || die "无法读取项目版本"
  fi
fi
[ -n "$VERSION" ] || die "项目版本不能为空"
case "$VERSION" in
  *[!A-Za-z0-9._+-]*) die "版本号含非法字符: ${VERSION}（仅允许字母数字 . _ + -）" ;;
esac
info "构建版本: ${VERSION}（$(os_pretty) $(host_arch)）"

upgrade_stage dependencies
step "安装前端依赖（按 pnpm 锁文件）"
_web="$RSM_ROOT/web"
_need_install=0
if [ ! -d "$_web/node_modules" ]; then _need_install=1
elif [ ! -f "$_web/node_modules/.modules.yaml" ]; then _need_install=1
elif [ "$_web/pnpm-lock.yaml" -nt "$_web/node_modules/.modules.yaml" ] 2>/dev/null; then _need_install=1
fi
if [ "$_need_install" = "1" ]; then
  if [ -f "$_web/pnpm-lock.yaml" ]; then
    ( cd "$_web" && run_logged "安装前端依赖" "$RSM_PNPM_BIN" install --frozen-lockfile ) || die "pnpm install --frozen-lockfile 失败"
  else
    warn "未找到 pnpm-lock.yaml，执行 pnpm install（无法冻结依赖，不建议用于正式发行）"
    ( cd "$_web" && run_logged "安装前端依赖" "$RSM_PNPM_BIN" install ) || die "pnpm install 失败"
  fi
else
  ok "前端依赖已就绪，复用锁文件对应的已安装依赖"
fi

upgrade_stage interfaces
step "校验接口类型（变更时重新生成）"
"$SCRIPT_DIR/generate.sh" --ensure || die "接口类型校验或生成失败"

upgrade_stage frontend
step "构建前端（pnpm build → web/dist）"
( cd "$_web" && run_logged "构建前端页面" "$RSM_PNPM_BIN" run build ) || die "前端构建失败（pnpm run build）"
[ -f "$_web/dist/index.html" ] || die "前端构建产物缺少 web/dist/index.html"

upgrade_stage backend
step "编译 Go 程序（CGO + 内嵌前端，ldflags main.version=${VERSION}）"
BIN="$OUT_DIR/rsm"
( cd "$RSM_ROOT" && CGO_ENABLED=1 CC="${CC:-cc}" run_logged "编译服务端程序" "$RSM_GO_BIN" build -trimpath -buildvcs=false \
    -ldflags "-X main.version=$VERSION" -o "$BIN" ./cmd/rsm ) || die "Go 编译失败（CGO 需要可用 C 编译器）"
[ -x "$BIN" ] || die "Go 编译未产生可执行文件: $BIN"
BIN_VERSION=$(binary_version "$BIN" 2>/dev/null || true)
[ "$BIN_VERSION" = "$VERSION" ] || die "编译后程序版本不一致：期望 ${VERSION}，实际 ${BIN_VERSION:-未知}"

upgrade_stage package
step "解析数据库迁移版本（release schemaVersion）"
SCHEMA_VERSION=0
if [ -d "$RSM_ROOT/internal/store/migrations" ]; then
  for _mf in "$RSM_ROOT"/internal/store/migrations/*.sql; do
    [ -f "$_mf" ] || continue
    _mbase=$(basename "$_mf")
    _mnum=$(printf '%s' "$_mbase" | sed -n 's/^0*\([0-9][0-9]*\)_.*/\1/p')
    if [ -z "$_mnum" ]; then _mnum=$(printf '%s' "$_mbase" | sed -n 's/^0*\([0-9][0-9]*\)\..*/\1/p'); fi
    if is_uint "$_mnum"; then
      if [ "$_mnum" -gt "$SCHEMA_VERSION" ] 2>/dev/null; then SCHEMA_VERSION="$_mnum"; fi
    fi
  done
fi
info "schemaVersion: $SCHEMA_VERSION"

step "打包发行产物"
NAME="rsm-$VERSION-$(host_os)-$(host_arch)"
STAGE="$OUT_DIR/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/scripts/lib" || die "无法创建发行包目录"
cp -p "$BIN" "$STAGE/rsm" || die "复制程序失败"
chmod 755 "$STAGE/rsm"
cp -p "$RSM_ROOT/rsm.sh" "$STAGE/rsm.sh" || die "复制入口失败"
chmod 755 "$STAGE/rsm.sh"
for _lf in "$RSM_ROOT"/scripts/lib/*.sh; do
  [ -f "$_lf" ] || continue
  cp -p "$_lf" "$STAGE/scripts/lib/" || die "复制脚本失败: $_lf"
  chmod 755 "$STAGE/scripts/lib/$(basename "$_lf")"
done
GO_VERSION=$("$RSM_GO_BIN" version 2>/dev/null | sed 's/go version //')
{
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "name": "rsm",\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "os": "%s",\n' "$(host_os)"
  printf '  "arch": "%s",\n' "$(host_arch)"
  printf '  "schemaVersion": %s,\n' "$SCHEMA_VERSION"
  printf '  "builtAt": "%s",\n' "$(now_iso)"
  printf '  "goVersion": "%s",\n' "$GO_VERSION"
  printf '  "binary": "rsm"\n'
  printf '}\n'
} >"$STAGE/release.json" || die "写入 release.json 失败"
( cd "$STAGE" && shasum_or_sha256sum() { :; }; \
  if have_cmd sha256sum; then sha256sum rsm rsm.sh release.json scripts/lib/*.sh > SHA256SUMS; else shasum -a 256 rsm rsm.sh release.json scripts/lib/*.sh > SHA256SUMS; fi ) || die "生成包内 SHA256SUMS 失败"
TARBALL="$OUT_DIR/$NAME.tar.gz"
rm -f "$TARBALL" "$TARBALL.sha256"
tar -czf "$TARBALL" -C "$OUT_DIR" "$NAME" || die "打包失败: $TARBALL"
TAR_SHA=$(sha256_file "$TARBALL")
printf '%s\n' "$TAR_SHA" >"$TARBALL.sha256"
printf '%s\n' "$TARBALL" >"$OUT_DIR/package.path"
# 构建元数据（含发行包 SHA256，便于升级入口校验）
{
  printf '{\n'
  printf '  "name": "rsm",\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "os": "%s",\n' "$(host_os)"
  printf '  "arch": "%s",\n' "$(host_arch)"
  printf '  "schemaVersion": %s,\n' "$SCHEMA_VERSION"
  printf '  "builtAt": "%s",\n' "$(now_iso)"
  printf '  "package": "%s",\n' "$(basename "$TARBALL")"
  printf '  "sha256": "%s",\n' "$TAR_SHA"
  printf '  "size": %s\n' "$(file_size "$TARBALL")"
  printf '}\n'
} >"$OUT_DIR/$NAME.json"
if have_cmd sha256sum; then sha256sum "$TARBALL" >"$OUT_DIR/SHA256SUMS"; else shasum -a 256 "$TARBALL" >"$OUT_DIR/SHA256SUMS"; fi

printf '\n'
ok "构建完成"
printf '  版本:     %s\n' "$VERSION"
printf '  程序:     %s（%s）\n' "$BIN" "$(human_size "$(file_size "$BIN")")"
printf '  发行包:   %s（%s）\n' "$TARBALL" "$(human_size "$(file_size "$TARBALL")")"
printf '  包 SHA256: %s\n' "$TAR_SHA"
printf '  元数据:   %s\n' "$TARBALL.sha256"
printf '  release:  %s\n' "$STAGE/release.json"
