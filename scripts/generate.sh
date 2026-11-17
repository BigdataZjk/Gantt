#!/usr/bin/env bash
# 统一接口类型生成：
#   internal/server/types.gen.go  ← 固定 oapi-codegen（types only，go run 固定版本）
#   web/src/api/types.gen.ts      ← 固定 openapi-typescript（优先使用 web 锁文件中的固定版本）
# 用法：scripts/generate.sh [--check|--ensure]
#   --check  生成到临时位置并与仓库文件比较，不写仓库（供 check.sh 校验接口契约）
#   --ensure 契约、生成器与输出校验一致时直接复用，否则重新生成。
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/toolchain.sh"
. "$SCRIPT_DIR/lib/codegen.sh"
trap progress_stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

CHECK=0
ENSURE=0
case "${1:-}" in
  --check) CHECK=1 ;;
  --ensure) ENSURE=1 ;;
  --help|-h) sed -n '2,8p' "$0"; exit 0 ;;
  "") ;;
  *) die "未知参数: ${1}（可用 --check / --ensure）" ;;
esac

API="$RSM_ROOT/api/openapi.yaml"
GO_OUT="$RSM_ROOT/internal/server/types.gen.go"
TS_OUT="$RSM_ROOT/web/src/api/types.gen.ts"
[ -f "$API" ] || die "接口契约不存在: $API"
[ -d "$RSM_ROOT/internal/server" ] || die "缺少 Go server 包目录: $RSM_ROOT/internal/server"

init_task_log
if [ "$ENSURE" = 1 ] && codegen_current; then
  ok "接口契约、生成器与类型文件校验一致，复用已生成类型"
  exit 0
fi
ensure_toolchain tools
GEN_TMP="$CACHE_DIR/generate.$$"
rm -rf "$GEN_TMP"
mkdir -p "$GEN_TMP"

OAPI_VER=$(tc_oapi_codegen)
[ -n "$OAPI_VER" ] || die "scripts/toolchain.json 缺少 goTools.oapiCodegen 版本"
info "生成 Go 接口类型（oapi-codegen ${OAPI_VER}，仅 types）"
if ! ( cd "$RSM_ROOT" && run_logged "生成 Go 接口类型" "$RSM_GO_BIN" run "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$OAPI_VER" -generate types -package server -o "$GEN_TMP/types.gen.go" "$API" ); then
  die "oapi-codegen 生成失败（检查网络/Go 代理、脚本依赖版本是否存在）"
fi
[ -s "$GEN_TMP/types.gen.go" ] || die "oapi-codegen 输出为空: $GEN_TMP/types.gen.go"
grep -q '^package server' "$GEN_TMP/types.gen.go" || die "生成的 Go 类型缺少 package server（生成参数异常）"

# 前端类型：优先使用 web/node_modules 中已锁定的版本；版本不一致时用 pnpm dlx 固定版本。
OTS_VER=$(tc_openapi_ts)
[ -n "$OTS_VER" ] || die "scripts/toolchain.json 缺少 nodeTools.openapiTypescript 版本"
info "生成 TypeScript 接口类型（openapi-typescript ${OTS_VER}）"
OTS_BIN=""
OTS_PKG="$RSM_ROOT/web/node_modules/openapi-typescript/package.json"
if [ -f "$OTS_PKG" ]; then
  OTS_INSTALLED=$(json_get "$OTS_PKG" version 2>/dev/null || true)
  if [ "$OTS_INSTALLED" = "$OTS_VER" ] && [ -x "$RSM_ROOT/web/node_modules/.bin/openapi-typescript" ]; then
    OTS_BIN="$RSM_ROOT/web/node_modules/.bin/openapi-typescript"
  fi
fi
if [ -n "$OTS_BIN" ]; then
  if ! ( cd "$RSM_ROOT" && run_logged "生成 TypeScript 接口类型" "$OTS_BIN" "$API" -o "$GEN_TMP/types.gen.ts" ); then
    die "openapi-typescript 生成失败（本地固定版本 ${OTS_VER}）"
  fi
else
  warn "web/node_modules 中没有固定版本 openapi-typescript($OTS_VER)，使用 pnpm dlx 临时获取固定版本"
  if ! ( cd "$RSM_ROOT" && run_logged "下载生成器并生成 TypeScript 类型" "$RSM_PNPM_BIN" dlx "openapi-typescript@$OTS_VER" "$API" -o "$GEN_TMP/types.gen.ts" ); then
    die "pnpm dlx openapi-typescript@$OTS_VER 生成失败"
  fi
fi
[ -s "$GEN_TMP/types.gen.ts" ] || die "openapi-typescript 输出为空: $GEN_TMP/types.gen.ts"

if [ "$CHECK" = "1" ]; then
  rc=0
  if [ ! -f "$GO_OUT" ] || ! cmp -s "$GEN_TMP/types.gen.go" "$GO_OUT"; then
    warn "internal/server/types.gen.go 与契约生成结果不一致（请运行 scripts/generate.sh 更新）"
    rc=1
  else
    ok "internal/server/types.gen.go 与契约一致"
  fi
  if [ ! -f "$TS_OUT" ] || ! cmp -s "$GEN_TMP/types.gen.ts" "$TS_OUT"; then
    warn "web/src/api/types.gen.ts 与契约生成结果不一致（请运行 scripts/generate.sh 更新）"
    rc=1
  else
    ok "web/src/api/types.gen.ts 与契约一致"
  fi
  if ! codegen_current; then
    warn "api/generated.sha256 已过期（请运行 scripts/generate.sh 更新）"
    rc=1
  fi
  rm -rf "$GEN_TMP"
  exit "$rc"
fi

mkdir -p "$(dirname "$GO_OUT")" "$(dirname "$TS_OUT")"
cp -f "$GEN_TMP/types.gen.go" "$GO_OUT" || die "写入 $GO_OUT 失败"
cp -f "$GEN_TMP/types.gen.ts" "$TS_OUT" || die "写入 $TS_OUT 失败"
codegen_record || die "写入接口类型校验清单失败"
rm -rf "$GEN_TMP"
ok "接口类型已生成："
printf '  Go: %s（sha256 %s）\n' "$GO_OUT" "$(sha256_file "$GO_OUT" | cut -c1-12)"
printf '  TS: %s（sha256 %s）\n' "$TS_OUT" "$(sha256_file "$TS_OUT" | cut -c1-12)"
