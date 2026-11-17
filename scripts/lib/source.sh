#!/usr/bin/env bash
# 源码 ZIP 的选择、隔离解压与清理；不覆盖运行目录中的源码或数据。

SOURCE_TMP=""
SOURCE_ROOT=""
SOURCE_VERSION=""
UPGRADE_INPUT=""

source_cleanup() {
  if [ -n "$SOURCE_TMP" ] && [ -d "$SOURCE_TMP" ]; then rm -rf "$SOURCE_TMP"; fi
  SOURCE_TMP=""
}

stable_version() { printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

source_workspace() {
  if [ -n "$SOURCE_TMP" ]; then return 0; fi
  if ! have_cmd unzip; then
    info "安装缺失的 ZIP 解压工具"
    pkg_install unzip || die "无法安装 unzip，当前服务未变更"
  fi
  mkdir -p "$RSM_HOME/.cache" || die "无法创建源码解压缓存目录"
  SOURCE_TMP=$(mktemp -d "$RSM_HOME/.cache/source-upgrade.XXXXXX") || die "无法创建源码解压目录"
}

version_newer() {
  awk -v candidate="$1" -v current="$2" 'BEGIN {
    split(candidate, a, "."); split(current, b, ".")
    for (i=1; i<=3; i++) {
      if (a[i]+0 > b[i]+0) exit 0
      if (a[i]+0 < b[i]+0) exit 1
    }
    exit 1
  }'
}

select_source_zip() {
  local file version hash best="" best_hash="" ambiguous=0
  UPGRADE_INPUT=""
  for file in "$RSM_HOME"/upgrade/*.zip; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    source_workspace
    if ! unzip -p "$file" rsm/web/package.json >"$SOURCE_TMP/version.json" 2>/dev/null; then
      warn "忽略无法读取 RSM 版本的 ZIP: $(basename "$file")"
      continue
    fi
    version=$(json_get "$SOURCE_TMP/version.json" version 2>/dev/null || true)
    if ! stable_version "$version"; then
      warn "忽略版本号无效的 ZIP: $(basename "$file")"
      continue
    fi
    if [ -z "$best" ] || version_newer "$version" "$best"; then
      best="$version"
      best_hash=$(sha256_file "$file") || die "无法校验源码包: $file"
      ambiguous=0
      UPGRADE_INPUT="$file"
    elif [ "$version" = "$best" ]; then
      hash=$(sha256_file "$file") || die "无法校验源码包: $file"
      if [ "$hash" != "$best_hash" ]; then ambiguous=1; fi
    fi
  done
  [ -n "$UPGRADE_INPUT" ] || return 1
  [ "$ambiguous" = 0 ] || die "upgrade/ 中有多个内容不同的 v$best 源码包，请只保留需要安装的一个"
  info "按包内版本选择源码包: $(basename "$UPGRADE_INPUT")（v${best}）"
}

prepare_source_zip() {
  local archive="$1" list details wanted actual file
  [ -f "$archive" ] || die "源码包不存在: $archive"
  source_workspace
  cp "$archive" "$SOURCE_TMP/source.zip" || die "无法读取源码包"
  actual=$(sha256_file "$SOURCE_TMP/source.zip") || die "无法校验源码包"
  if [ -f "$archive.sha256" ]; then
    wanted=$(awk 'NR==1 {print $1}' "$archive.sha256")
    [ "$wanted" = "$actual" ] || die "源码包 SHA256 校验失败，当前服务未变更"
  fi
  info "源码包 SHA256: $actual"
  list="$SOURCE_TMP/entries"
  details="$SOURCE_TMP/details"
  LC_ALL=C unzip -Z -1 "$SOURCE_TMP/source.zip" >"$list" || die "无法读取源码 ZIP"
  LC_ALL=C awk '
    { if ($0 !~ /^rsm\/[A-Za-z0-9._\/-]*$/ || $0 ~ /(^|\/)\.\.?($|\/)/ || seen[$0]++) bad=1 }
    END { exit bad || NR==0 }
  ' "$list" || die "源码 ZIP 包含重复或不安全的路径，当前服务未变更"
  LC_ALL=C unzip -Z -l "$SOURCE_TMP/source.zip" >"$details" || die "无法检查 ZIP 文件类型"
  LC_ALL=C awk '$1 ~ /^[^d-][rwxstST?-]+$/ {bad=1} END {exit bad}' "$details" ||
    die "源码 ZIP 包含链接或特殊文件，当前服务未变更"
  run_logged "校验 ZIP 内容并解压源码" source_unzip "$SOURCE_TMP" || die "源码 ZIP 损坏或无法解压，当前服务未变更"
  SOURCE_ROOT="$SOURCE_TMP/rsm"
  for file in go.mod cmd/rsm/main.go api/openapi.yaml api/generated.sha256 web/package.json web/pnpm-lock.yaml scripts/build.sh scripts/bootstrap.sh scripts/toolchain.json rsm.sh; do
    [ -f "$SOURCE_ROOT/$file" ] || die "源码包缺少 ${file}，当前服务未变更"
  done
  SOURCE_VERSION=$(json_get "$SOURCE_ROOT/web/package.json" version) || die "无法读取源码版本"
  stable_version "$SOURCE_VERSION" || die "源码包版本无效: $SOURCE_VERSION"
  chmod 755 "$SOURCE_ROOT/rsm.sh"
  find "$SOURCE_ROOT/scripts" -type f -name '*.sh' -exec chmod 755 {} \; || die "无法设置源码脚本权限"
  ok "源码包校验通过: v$SOURCE_VERSION"
}

source_unzip() {
  unzip -tqq "$1/source.zip" </dev/null && unzip -q "$1/source.zip" -d "$1"
}
