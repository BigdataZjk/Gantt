#!/usr/bin/env bash
# 将已提交的源码打包为 ZIP，默认输出到当前用户桌面。
set -eu
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
RSM_ROOT=$(cd "$SCRIPT_DIR/.." && pwd -P)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/codegen.sh"

OUT_DIR="${RSM_SOURCE_OUT_DIR:-$HOME/Desktop}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir) [ "$#" -ge 2 ] || die "--out-dir 缺少取值"; OUT_DIR="$2"; shift 2 ;;
    --help|-h) printf '用法: ./scripts/package-source.sh [--out-dir DIR]\n默认输出: ~/Desktop/rsm-source-<版本>.zip\n'; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

have_cmd git || die "源码打包需要 Git"
[ -z "$(git -C "$RSM_ROOT" status --porcelain --untracked-files=normal)" ] || die "请先提交源码修改，再生成与提交一致的源码包"
codegen_current || die "接口类型校验清单过期，请先运行 scripts/generate.sh 并提交结果"
VERSION=$(json_get "$RSM_ROOT/web/package.json" version) || die "无法读取项目版本"
case "$VERSION" in
  ''|*[!A-Za-z0-9._+-]*) die "项目版本无效: $VERSION" ;;
esac
mkdir -p "$OUT_DIR" || die "无法创建输出目录: $OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd -P)
TARGET="$OUT_DIR/rsm-source-$VERSION.zip"
TEMP_ARCHIVE=$(mktemp "$OUT_DIR/.rsm-source-$VERSION.XXXXXX")
trap 'rm -f "$TEMP_ARCHIVE"' EXIT
git -C "$RSM_ROOT" archive --format=zip --prefix=rsm/ --output="$TEMP_ARCHIVE" HEAD || die "源码打包失败"
SIGNING_KEY="${RSM_RELEASE_SIGNING_KEY:-${XDG_CONFIG_HOME:-$HOME/.config}/rsm/release-signing-key.pem}"
if [ -n "${RSM_RELEASE_SIGNING_KEY:-}" ] || [ -f "$SIGNING_KEY" ]; then
  SIGN_GO="$RSM_ROOT/.tools/go/bin/go"
  if [ ! -x "$SIGN_GO" ]; then SIGN_GO=$(command -v go) || die "签名需要 Go"; fi
  ( cd "$RSM_ROOT" && "$SIGN_GO" run ./cmd/rsm-sign-source "$TEMP_ARCHIVE" "$SIGNING_KEY" ) || die "源码包签名失败"
else
  info "未配置发布签名密钥，源码包可用于命令行部署"
fi
mv -f "$TEMP_ARCHIVE" "$TARGET" || die "无法保存源码包"
ok "RSM v$VERSION 源码包已保存: $TARGET"
printf 'SHA256: %s\n' "$(sha256_file "$TARGET")"
