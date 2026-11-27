#!/usr/bin/env bash
# 源码构建工具链：固定版本解析、下载缓存、SHA256 校验、安装到 .tools。
# 供 rsm.sh / scripts/{bootstrap,generate,build,dev,check}.sh source。
# 依赖 common.sh 已 source；RSM_ROOT 为仓库根目录。

_tc_self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
if [ -z "${RSM_ROOT:-}" ]; then
  RSM_ROOT=$(cd "$_tc_self_dir/../.." 2>/dev/null && pwd -P)
fi
TOOLS_DIR="${RSM_BUILD_ROOT:-$RSM_ROOT}/.tools"
CACHE_DIR="${RSM_BUILD_ROOT:-$RSM_ROOT}/.cache"
DOWNLOADS_DIR="$CACHE_DIR/downloads"
TC_LOG_DIR="$CACHE_DIR/logs"
TOOLCHAIN_ENV_FILE="$TOOLS_DIR/toolchain.env"

setup_build_cache_env() {
  export GOPATH="${GOPATH:-$CACHE_DIR/go}"
  export GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"
  export GOCACHE="${GOCACHE:-$CACHE_DIR/go-build}"
  export npm_config_cache="${npm_config_cache:-$CACHE_DIR/npm}"
  export PNPM_CONFIG_STORE_DIR="${PNPM_CONFIG_STORE_DIR:-$CACHE_DIR/pnpm/store}"
  export PNPM_CONFIG_CACHE_DIR="${PNPM_CONFIG_CACHE_DIR:-$CACHE_DIR/pnpm/cache}"
  export PNPM_CONFIG_STATE_DIR="${PNPM_CONFIG_STATE_DIR:-$CACHE_DIR/pnpm/state}"
  # 固定工具链由 RSM 管理，避免父目录或全局配置触发 pnpm 自动换版。
  export PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$CACHE_DIR/xdg/cache}"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$CACHE_DIR/xdg/config}"
  export XDG_DATA_HOME="${XDG_DATA_HOME:-$CACHE_DIR/xdg/data}"
  export XDG_STATE_HOME="${XDG_STATE_HOME:-$CACHE_DIR/xdg/state}"
  export GOENV="${GOENV:-$CACHE_DIR/go/env}"
  # Go 在 macOS 不使用 XDG 配置目录，需单独指定遥测文件位置。
  export TEST_TELEMETRY_DIR="${TEST_TELEMETRY_DIR:-$CACHE_DIR/go-telemetry}"
}

# 执行命令并返回首行输出（版本探测用）。
version_of_cmd() { "$@" 2>/dev/null | head -n 1; }

toolchain_file() { printf '%s' "$RSM_ROOT/scripts/toolchain.json"; }
tc_get() { json_get "$(toolchain_file)" "$1"; }
tc_go_version() { tc_get go.version; }
tc_node_version() { tc_get node.version; }
tc_pnpm_version() { tc_get pnpm.version; }
tc_oapi_codegen() { tc_get goTools.oapiCodegen; }
tc_openapi_ts() { tc_get nodeTools.openapiTypescript; }
tc_default_addr() { local a; a=$(tc_get runtime.defaultAddr); if [ -n "$a" ]; then printf '%s' "$a"; else printf '%s' "$RSM_DEFAULT_ADDR"; fi; }

tc_platform_go_url() { tc_get "go.platforms.$(platform_key).url"; }
tc_platform_go_sha() { tc_get "go.platforms.$(platform_key).sha256"; }
tc_platform_go_filename() { tc_get "go.platforms.$(platform_key).filename"; }
tc_platform_node_url() { tc_get "node.platforms.$(platform_key).url"; }
tc_platform_node_sha() { tc_get "node.platforms.$(platform_key).sha256"; }
tc_platform_node_filename() { tc_get "node.platforms.$(platform_key).filename"; }

tc_assert_platform_assets() {
  local pk go_url node_url
  pk=$(platform_key)
  go_url=$(tc_platform_go_url)
  node_url=$(tc_platform_node_url)
  [ -n "$go_url" ] || die "scripts/toolchain.json 未提供 Go 平台 $pk 的下载地址"
  [ -n "$node_url" ] || die "scripts/toolchain.json 未提供 Node 平台 $pk 的下载地址"
}

# 探测必须成功返回 HTTP 2xx；成功缓存 10 分钟，失败最多缓存 1 分钟。
probe_cached() {
  _pc_key="$1"; _pc_url="$2"; _pc_ttl="${3:-600}"
  _pc_file="$CACHE_DIR/probe-$_pc_key"
  if [ -f "$_pc_file" ]; then
    _pc_ts=$(cut -d' ' -f1 "$_pc_file" 2>/dev/null)
    _pc_val=$(cut -d' ' -f2 "$_pc_file" 2>/dev/null)
    _pc_now=$(date +%s)
    if [ "$_pc_val" = 0 ] && [ "$_pc_ttl" -gt 60 ]; then _pc_ttl=60; fi
    if is_uint "$_pc_ts" && [ "$((_pc_now - _pc_ts))" -ge 0 ] && [ "$((_pc_now - _pc_ts))" -lt "$_pc_ttl" ] 2>/dev/null; then
      [ "$_pc_val" = "1" ]
      return $?
    fi
  fi
  mkdir -p "$CACHE_DIR" 2>/dev/null || true
  if have_cmd curl && curl -fsSL -o /dev/null --max-time 4 --connect-timeout 2 "$_pc_url" 2>/dev/null; then
    printf '%s 1\n' "$(date +%s)" >"$_pc_file" 2>/dev/null || true
    return 0
  fi
  printf '%s 0\n' "$(date +%s)" >"$_pc_file" 2>/dev/null || true
  return 1
}

# 默认先探测国内源；保留官方源回退及 Go 校验库验证，尊重显式环境配置。
setup_go_env() {
  export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"
  export CGO_ENABLED="${CGO_ENABLED:-1}"
  if [ -z "${GOPROXY:-}" ]; then
    if probe_cached goproxy-cn-v2 "https://goproxy.cn/github.com/mattn/go-sqlite3/@v/v1.14.53.info"; then
      export GOPROXY="https://goproxy.cn|https://goproxy.io|https://proxy.golang.org|direct"
    elif probe_cached goproxy-official-v2 "https://proxy.golang.org/github.com/mattn/go-sqlite3/@v/v1.14.53.info"; then
      export GOPROXY="https://proxy.golang.org|https://goproxy.cn|https://goproxy.io|direct"
    elif probe_cached goproxy-io-v2 "https://goproxy.io/github.com/mattn/go-sqlite3/@v/v1.14.53.info"; then
      export GOPROXY="https://goproxy.io|https://goproxy.cn|https://proxy.golang.org|direct"
    else
      export GOPROXY="https://goproxy.io|https://goproxy.cn|https://proxy.golang.org|direct"
      debug "首选 Go 源暂不可用，使用备用源并保留官方回退"
    fi
  fi
  if [ -z "${GOSUMDB:-}" ]; then
    # Go 优先经 GOPROXY 转发校验库请求，无需先直连境外校验库。
    export GOSUMDB="sum.golang.org"
  fi
}

# 读取已有 .tools/toolchain.env 并快速校验；不满足返回 1。
load_toolchain_env() {
  local g n p
  [ -f "$TOOLCHAIN_ENV_FILE" ] || return 1
  RSM_GO_BIN=""; RSM_NODE_BIN=""; RSM_NPM_BIN=""; RSM_PNPM_BIN=""; RSM_TOOLCHAIN_ROOT=""
  # shellcheck disable=SC1090
  . "$TOOLCHAIN_ENV_FILE" || return 1
  [ "$RSM_TOOLCHAIN_ROOT" = "$RSM_ROOT" ] || return 1
  [ -n "${RSM_GO_BIN:-}" ] && [ -x "$RSM_GO_BIN" ] || return 1
  [ -n "${RSM_NODE_BIN:-}" ] && [ -x "$RSM_NODE_BIN" ] || return 1
  [ -n "${RSM_PNPM_BIN:-}" ] && [ -x "$RSM_PNPM_BIN" ] || return 1
  g=$("$RSM_GO_BIN" version 2>/dev/null | sed -n 's/go version go\([0-9.]*\).*/\1/p')
  n=$("$RSM_NODE_BIN" --version 2>/dev/null | sed 's/^v//')
  p=$(PATH="$(dirname "$RSM_NODE_BIN"):$PATH" "$RSM_PNPM_BIN" --version 2>/dev/null)
  [ "$g" = "$(tc_go_version)" ] || return 1
  [ "$n" = "$(tc_node_version)" ] || return 1
  [ "$p" = "$(tc_pnpm_version)" ] || return 1
  toolchain_apply_path
  return 0
}

save_toolchain_env() {
  mkdir -p "$TOOLS_DIR" || return 1
  {
    printf '# RSM 工具链路径（由 scripts/bootstrap.sh 生成，可删除后重新生成）\n'
    printf 'RSM_TOOLCHAIN_ROOT=%q\n' "$RSM_ROOT"
    printf 'RSM_GO_BIN=%q\n' "$RSM_GO_BIN"
    printf 'RSM_NODE_BIN=%q\n' "$RSM_NODE_BIN"
    printf 'RSM_NPM_BIN=%q\n' "$RSM_NPM_BIN"
    printf 'RSM_PNPM_BIN=%q\n' "$RSM_PNPM_BIN"
    printf 'RSM_GO_VERSION=%s\n' "$(tc_go_version)"
    printf 'RSM_NODE_VERSION=%s\n' "$(tc_node_version)"
    printf 'RSM_PNPM_VERSION=%s\n' "$(tc_pnpm_version)"
    printf 'RSM_TOOLCHAIN_PLATFORM=%s\n' "$(platform_key)"
  } | atomic_write "$TOOLCHAIN_ENV_FILE" 600
}

toolchain_apply_path() {
  local dirs=""
  [ -n "${RSM_GO_BIN:-}" ] && dirs="$(dirname "$RSM_GO_BIN")"
  [ -n "${RSM_NODE_BIN:-}" ] && dirs="$dirs:$(dirname "$RSM_NODE_BIN")"
  [ -n "${RSM_PNPM_BIN:-}" ] && dirs="$dirs:$(dirname "$RSM_PNPM_BIN")"
  if [ -n "$dirs" ]; then
    PATH="$dirs:$PATH"
    export PATH
  fi
}

# 下载并校验归档到缓存；成功时设置 FETCHED_ARCHIVE 全局变量。
fetch_archive() {
  _fa_url="$1"; _fa_sha="$2"; _fa_label="${3:-下载文件}"
  _fa_name=$(basename "$_fa_url")
  _fa_final="$DOWNLOADS_DIR/$_fa_name"
  mkdir -p "$DOWNLOADS_DIR" || die "无法创建下载缓存目录: $DOWNLOADS_DIR"
  if [ -f "$_fa_final" ]; then
    if [ "$(sha256_file "$_fa_final")" = "$_fa_sha" ]; then
      FETCHED_ARCHIVE="$_fa_final"
      info "复用缓存: $_fa_name"
      return 0
    fi
    warn "缓存校验失败，删除后重新下载: $_fa_name"
    rm -f "$_fa_final"
  fi
  have_cmd curl || die "缺少 curl，无法下载 ${_fa_label}；请先安装 curl 或运行 scripts/bootstrap.sh"
  _fa_part="$_fa_final.part"
  _fa_try=1
  while [ "$_fa_try" -le 3 ]; do
    info "${_fa_label}：下载 ${_fa_name}（第 $_fa_try/3 次）"
    if [ -f "$_fa_part" ] && [ "$_fa_try" -gt 1 ]; then
      run_logged "下载 ${_fa_label}（断点续传）" curl -fL -sS -C - --connect-timeout 20 --retry 2 --retry-delay 2 -o "$_fa_part" "$_fa_url" || true
    else
      run_logged "下载 ${_fa_label}" curl -fL -sS --connect-timeout 20 --retry 2 --retry-delay 2 -o "$_fa_part" "$_fa_url" || true
    fi
    if [ -f "$_fa_part" ] && [ -s "$_fa_part" ] && [ "$(sha256_file "$_fa_part")" = "$_fa_sha" ]; then
      mv -f "$_fa_part" "$_fa_final"
      FETCHED_ARCHIVE="$_fa_final"
      ok "${_fa_label}：下载并校验完成"
      return 0
    fi
    if [ -f "$_fa_part" ] && [ -s "$_fa_part" ]; then
      warn "${_fa_label}：校验不一致或下载不完整，保留断点以便续传"
    else
      warn "${_fa_label}：下载失败（网络中断或地址不可用）"
    fi
    _fa_try=$((_fa_try+1))
    sleep 2
  done
  die "${_fa_label}：连续 3 次下载/校验失败。可检查网络，或手动放置文件到 $DOWNLOADS_DIR/${_fa_name}（SHA256=${_fa_sha}）后重试"
}

# 解压 tar.gz 到指定目录（目录会被清空重建）。
extract_archive() {
  _ea_arc="$1"; _ea_dest="$2"; _ea_label="${3:-归档}"
  have_cmd tar || die "缺少 tar，无法解压 $_ea_label"
  rm -rf "$_ea_dest"
  mkdir -p "$_ea_dest" || die "无法创建解压目录: $_ea_dest"
  if ! tar -xzf "$_ea_arc" -C "$_ea_dest"; then
    rm -rf "$_ea_dest"
    die "解压 $_ea_label 失败: $_ea_arc"
  fi
}

ensure_go() {
  local want sys_go sys_ver
  want=$(tc_go_version)
  if [ -x "$TOOLS_DIR/go/bin/go" ]; then
    _eg_ver=$("$TOOLS_DIR/go/bin/go" version 2>/dev/null | sed -n 's/go version go\([0-9.]*\).*/\1/p')
    if [ "$_eg_ver" = "$want" ]; then
      RSM_GO_BIN="$TOOLS_DIR/go/bin/go"
      debug "复用 .tools Go $want"
      return 0
    fi
    warn ".tools 中 Go 版本为 ${_eg_ver:-未知}，与固定版本 $want 不一致，重新安装到 .tools"
  fi
  sys_go=$(command -v go 2>/dev/null || true)
  if [ -n "$sys_go" ]; then
    sys_ver=$("$sys_go" version 2>/dev/null | sed -n 's/go version go\([0-9.]*\).*/\1/p')
    if [ "$sys_ver" = "$want" ]; then
      RSM_GO_BIN="$sys_go"
      info "复用系统 Go $want: $sys_go"
      return 0
    fi
    info "系统 Go 版本 ${sys_ver:-未知} 与固定版本 $want 不同，安装到 .tools（不替换系统工具）"
  fi
  tc_assert_platform_assets
  fetch_archive "$(tc_platform_go_url)" "$(tc_platform_go_sha)" "Go $want"
  _eg_tmp="$TOOLS_DIR/.tmp-go.$$"
  extract_archive "$FETCHED_ARCHIVE" "$_eg_tmp" "Go $want"
  [ -d "$_eg_tmp/go" ] || { rm -rf "$_eg_tmp"; die "Go 归档结构与预期不符（缺少 go/ 目录）"; }
  mkdir -p "$TOOLS_DIR"
  rm -rf "$TOOLS_DIR/go"
  mv "$_eg_tmp/go" "$TOOLS_DIR/go" || { rm -rf "$_eg_tmp"; die "安装 Go 到 .tools 失败"; }
  rm -rf "$_eg_tmp"
  RSM_GO_BIN="$TOOLS_DIR/go/bin/go"
  _eg_ver=$("$RSM_GO_BIN" version 2>/dev/null | sed -n 's/go version go\([0-9.]*\).*/\1/p')
  [ "$_eg_ver" = "$want" ] || die "Go 安装校验失败：期望 ${want}，实际 ${_eg_ver:-未知}"
  ok "Go $want 已安装到 .tools/go"
}

ensure_node() {
  local want sys_node sys_ver
  want=$(tc_node_version)
  if [ -x "$TOOLS_DIR/node/bin/node" ]; then
    _en_ver=$("$TOOLS_DIR/node/bin/node" --version 2>/dev/null | sed 's/^v//')
    if [ "$_en_ver" = "$want" ]; then
      RSM_NODE_BIN="$TOOLS_DIR/node/bin/node"
      RSM_NPM_BIN="$TOOLS_DIR/node/bin/npm"
      debug "复用 .tools Node $want"
      return 0
    fi
    warn ".tools 中 Node 版本为 ${_en_ver:-未知}，与固定版本 $want 不一致，重新安装到 .tools"
  fi
  sys_node=$(command -v node 2>/dev/null || true)
  if [ -n "$sys_node" ]; then
    sys_ver=$("$sys_node" --version 2>/dev/null | sed 's/^v//')
    if [ "$sys_ver" = "$want" ]; then
      RSM_NODE_BIN="$sys_node"
      RSM_NPM_BIN=$(command -v npm 2>/dev/null || true)
      [ -n "$RSM_NPM_BIN" ] || die "找到系统 Node 但缺少 npm；请安装 npm 或允许下载固定 Node 到 .tools"
      info "复用系统 Node $want: $sys_node"
      return 0
    fi
    info "系统 Node 版本 ${sys_ver:-未知} 与固定 LTS $want 不同，安装到 .tools（不替换系统工具）"
  fi
  tc_assert_platform_assets
  fetch_archive "$(tc_platform_node_url)" "$(tc_platform_node_sha)" "Node $want"
  _en_tmp="$TOOLS_DIR/.tmp-node.$$"
  extract_archive "$FETCHED_ARCHIVE" "$_en_tmp" "Node $want"
  _en_dir=$(find "$_en_tmp" -maxdepth 1 -type d ! -path "$_en_tmp" | head -n1)
  if [ -z "$_en_dir" ] || [ ! -x "$_en_dir/bin/node" ]; then
    rm -rf "$_en_tmp"
    die "Node 归档结构与预期不符"
  fi
  mkdir -p "$TOOLS_DIR"
  rm -rf "$TOOLS_DIR/node"
  mv "$_en_dir" "$TOOLS_DIR/node" || { rm -rf "$_en_tmp"; die "安装 Node 到 .tools 失败"; }
  rm -rf "$_en_tmp"
  RSM_NODE_BIN="$TOOLS_DIR/node/bin/node"
  RSM_NPM_BIN="$TOOLS_DIR/node/bin/npm"
  _en_ver=$("$RSM_NODE_BIN" --version 2>/dev/null | sed 's/^v//')
  [ "$_en_ver" = "$want" ] || die "Node 安装校验失败：期望 ${want}，实际 ${_en_ver:-未知}"
  ok "Node $want 已安装到 .tools/node"
}

ensure_pnpm() {
  local want sys_pnpm
  local PATH="$(dirname "$RSM_NODE_BIN"):$PATH"
  want=$(tc_pnpm_version)
  _ep_local="$TOOLS_DIR/pnpm/node_modules/.bin/pnpm"
  if [ -x "$_ep_local" ]; then
    _ep_ver=$("$_ep_local" --version 2>/dev/null || true)
    if [ "$_ep_ver" = "$want" ]; then
      RSM_PNPM_BIN="$_ep_local"
      debug "复用 .tools pnpm $want"
      return 0
    fi
  fi
  sys_pnpm=$(command -v pnpm 2>/dev/null || true)
  if [ -n "$sys_pnpm" ]; then
    _ep_ver=$("$sys_pnpm" --version 2>/dev/null || true)
    if [ "$_ep_ver" = "$want" ]; then
      RSM_PNPM_BIN="$sys_pnpm"
      info "复用系统 pnpm $want: $sys_pnpm"
      return 0
    fi
    info "系统 pnpm 版本 ${_ep_ver:-未知} 与固定版本 $want 不同，安装到 .tools（不替换系统工具）"
  fi
  if [ -z "${RSM_NPM_BIN:-}" ] || [ ! -x "$RSM_NPM_BIN" ]; then
    die "安装 pnpm 需要 npm，请先确保 Node 安装成功"
  fi
  info "通过 npm 安装固定 pnpm $want 到 .tools/pnpm"
  mkdir -p "$TOOLS_DIR" "$TC_LOG_DIR"
  if ! PATH="$(dirname "$RSM_NODE_BIN"):$PATH" run_logged "安装 pnpm $want" "$RSM_NPM_BIN" install --prefix "$TOOLS_DIR/pnpm" --no-save --no-package-lock --ignore-scripts "pnpm@$want"; then
    die "npm 安装 pnpm@$want 失败"
  fi
  [ -x "$_ep_local" ] || die "pnpm 安装后未找到可执行文件: $_ep_local"
  _ep_ver=$("$_ep_local" --version 2>/dev/null || true)
  [ "$_ep_ver" = "$want" ] || die "pnpm 安装校验失败：期望 ${want}，实际 ${_ep_ver:-未知}"
  RSM_PNPM_BIN="$_ep_local"
  ok "pnpm $want 已安装到 .tools/pnpm"
}

# Linux 包管理器（apt/dnf/yum）安装；需要系统授权时由 sudo 提示用户。
pkg_manager() {
  if have_cmd apt-get; then printf 'apt'
  elif have_cmd dnf; then printf 'dnf'
  elif have_cmd yum; then printf 'yum'
  else printf ''; fi
}

apt_install_missing() {
  local plan blocked
  if ! plan=$($_pi_sudo env LC_ALL=C apt-get --simulate --no-remove --no-upgrade --no-install-recommends install "$@" 2>&1); then
    log_file "[apt-plan] $plan"
    run_logged "刷新系统软件包索引" $_pi_sudo apt-get update || return 1
    if ! plan=$($_pi_sudo env LC_ALL=C apt-get --simulate --no-remove --no-upgrade --no-install-recommends install "$@" 2>&1); then
      warn "无法生成系统依赖安装计划，未执行安装: $plan"
      return 1
    fi
  fi
  log_file "[apt-plan] $plan"
  blocked=$(printf '%s\n' "$plan" | awk '
    $1 == "Inst" {
      if ($3 ~ /^\[/) print
      else fresh[$2] = 1
    }
    $1 == "Remv" || $1 == "Purg" { print }
    $1 == "Conf" && !($2 in fresh) { print }
  ')
  if [ -n "$blocked" ]; then
    warn "系统依赖需要变更已安装的软件包，已中止，未执行安装: $blocked"
    return 1
  fi
  run_logged "安装缺失系统依赖: $*" $_pi_sudo env LC_ALL=C NEEDRESTART_MODE=l apt-get --no-remove --no-upgrade --no-install-recommends install -y "$@"
}

pkg_install() {
  if [ "${RSM_NO_SYSTEM_PACKAGES:-0}" = 1 ]; then
    warn "网页升级需要服务器已安装系统依赖: $*"
    return 1
  fi
  _pi_pkgs="$*"
  _pi_pm=$(pkg_manager)
  [ -n "$_pi_pm" ] || return 1
  _pi_sudo=""
  if [ "$(id -u)" != "0" ] && have_cmd sudo; then _pi_sudo="sudo"; fi
  info "通过系统包管理器安装: ${_pi_pkgs}（可能需要输入系统密码授权）"
  log_file "[pkg] $_pi_pm install $_pi_pkgs"
  if [ -n "$_pi_sudo" ]; then
    sudo -v || return 1
  fi
  case "$_pi_pm" in
    apt) apt_install_missing "$@" ;;
    dnf) run_logged "安装系统依赖: $_pi_pkgs" $_pi_sudo dnf install -y $_pi_pkgs ;;
    yum) run_logged "安装系统依赖: $_pi_pkgs" $_pi_sudo yum install -y $_pi_pkgs ;;
  esac
}

ensure_download_tools() {
  _edt_missing=""
  if [ "$(host_os)" = "linux" ] && [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ ! -s /etc/pki/tls/certs/ca-bundle.crt ]; then
    _edt_missing="$_edt_missing ca-certificates"
  fi
  have_cmd curl || _edt_missing="$_edt_missing curl"
  have_cmd tar || _edt_missing="$_edt_missing tar"
  have_cmd gzip || _edt_missing="$_edt_missing gzip"
  if ! have_cmd sha256sum && ! have_cmd shasum && ! have_cmd openssl; then _edt_missing="$_edt_missing coreutils"; fi
  [ -z "$_edt_missing" ] && return 0
  warn "缺少基础工具:$_edt_missing"
  case "$(host_os)" in
    darwin)
      die "macOS 自带 curl/tar/gzip/shasum，缺失说明系统工具不完整；请修复系统后重试（缺失:${_edt_missing}）" ;;
    linux)
      pkg_install $_edt_missing || die "无法自动安装基础工具（缺失:${_edt_missing}）。请手动安装 curl tar gzip coreutils 后重试" ;;
    *) die "不支持的系统，无法自动安装:$_edt_missing" ;;
  esac
  have_cmd curl || die "安装后仍缺少 curl"
}

# CGO 所需 C 编译器：macOS 检查 Xcode Command Line Tools；Linux 安装 build-essential/gcc。
# 探测可用的 C 编译器：必须能真实编译一段 C 程序。
# macOS 上 /usr/bin/cc、xcrun 可能因未接受 Xcode 许可而失败；已安装 CLT 时直接复用
# /Library/Developer/CommandLineTools/usr/bin/clang，并配合 CLT SDK（-isysroot）才能找到标准头文件。
# 本函数不会触发 Xcode 许可确认，也不需要 sudo。

# 选择 macOS SDK 目录：优先 CLT SDK，其次 xcode-select 指定开发目录下的 SDK。
macos_sdk_dir() {
  for _msd in \
    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk" \
    "/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk"; do
    [ -d "$_msd" ] && { printf '%s' "$_msd"; return 0; }
  done
  _msd_dev=$(xcode-select -p 2>/dev/null || true)
  if [ -n "$_msd_dev" ] && [ -d "$_msd_dev/SDKs" ]; then
    _msd_latest=$(ls -d "$_msd_dev"/SDKs/MacOSX*.sdk 2>/dev/null | sort | tail -n1)
    if [ -n "$_msd_latest" ]; then printf '%s' "$_msd_latest"; return 0; fi
  fi
  return 1
}

cc_compile_works() {
  _ccw="$1"; _ccw_sdk="${2:-}"
  [ -n "$_ccw" ] && [ -x "$_ccw" ] || return 1
  _ccw_dir="$CACHE_DIR/cc-probe"
  mkdir -p "$_ccw_dir" 2>/dev/null || true
  _ccw_src="$_ccw_dir/probe-$$.c"
  _ccw_out="$_ccw_dir/probe-$$.out"
  printf '%s\n' '#include <stdlib.h>' '#include <stdio.h>' 'int main(void){return 0;}' >"$_ccw_src" 2>/dev/null || return 1
  _ccw_ok=0
  if [ -n "$_ccw_sdk" ] && [ -d "$_ccw_sdk" ]; then
    if "$_ccw" -isysroot "$_ccw_sdk" "$_ccw_src" -o "$_ccw_out" >/dev/null 2>&1; then _ccw_ok=1; fi
  else
    if "$_ccw" "$_ccw_src" -o "$_ccw_out" >/dev/null 2>&1; then _ccw_ok=1; fi
  fi
  rm -f "$_ccw_src" "$_ccw_out" 2>/dev/null || true
  [ "$_ccw_ok" = "1" ]
}

# 成功时设置全局 RSM_CC_BIN 与 RSM_SDKROOT（仅 macOS），并输出编译器路径。
detect_c_compiler() {
  RSM_CC_BIN=""; RSM_SDKROOT=""
  if [ -n "${RSM_CC:-}" ]; then
    if [ "$(host_os)" = "darwin" ]; then RSM_SDKROOT=$(macos_sdk_dir || true); fi
    if cc_compile_works "$RSM_CC" "$RSM_SDKROOT"; then RSM_CC_BIN="$RSM_CC"; printf '%s' "$RSM_CC_BIN"; return 0; fi
    warn "RSM_CC=$RSM_CC 无法完成编译探测（将持续尝试其他候选）"
  fi
  _dcc_candidates=""
  case "$(host_os)" in
    darwin)
      RSM_SDKROOT=$(macos_sdk_dir || true)
      _dcc_candidates="/Library/Developer/CommandLineTools/usr/bin/clang"
      _dcc_devdir=$(xcode-select -p 2>/dev/null || true)
      if [ -n "$_dcc_devdir" ] && [ -x "$_dcc_devdir/usr/bin/clang" ]; then
        _dcc_candidates="$_dcc_candidates:$_dcc_devdir/usr/bin/clang"
      fi
      _dcc_candidates="$_dcc_candidates:/usr/bin/clang:/usr/bin/cc:$(command -v clang 2>/dev/null || true):$(command -v gcc 2>/dev/null || true)"
      ;;
    linux)
      _dcc_candidates="/usr/bin/cc:/usr/bin/gcc:$(command -v cc 2>/dev/null || true):$(command -v gcc 2>/dev/null || true):$(command -v clang 2>/dev/null || true)"
      ;;
  esac
  _dcc_old_ifs="$IFS"; IFS=':'
  for _dcc in $_dcc_candidates; do
    IFS="$_dcc_old_ifs"
    [ -n "$_dcc" ] || { IFS=':'; continue; }
    if cc_compile_works "$_dcc" "$RSM_SDKROOT"; then
      RSM_CC_BIN="$_dcc"
      printf '%s' "$_dcc"
      return 0
    fi
    IFS=':'
  done
  IFS="$_dcc_old_ifs"
  return 1
}

# 导出 CGO 需要的编译环境：CC/CXX/SDKROOT/CGO_CFLAGS/CGO_LDFLAGS（macOS + CLT SDK）。
export_cgo_env() {
  export CC="$RSM_CC_BIN"
  _cge_dir=$(dirname "$RSM_CC_BIN")
  if [ -x "$_cge_dir/clang++" ]; then export CXX="$_cge_dir/clang++"
  elif [ -x "$_cge_dir/g++" ]; then export CXX="$_cge_dir/g++"; fi
  if [ "$(host_os)" = "darwin" ] && [ -n "${RSM_SDKROOT:-}" ] && [ -d "$RSM_SDKROOT" ]; then
    export SDKROOT="$RSM_SDKROOT"
    export CGO_CFLAGS="-isysroot $RSM_SDKROOT"
    export CGO_LDFLAGS="-isysroot $RSM_SDKROOT"
  fi
  export CGO_ENABLED=1
}

ensure_c_compiler() {
  if detect_c_compiler >/dev/null; then
    export_cgo_env
    debug "C 编译器: $CC ${SDKROOT:+(SDKROOT=$SDKROOT)}"
    return 0
  fi
  if [ "${RSM_NO_SYSTEM_PACKAGES:-0}" = 1 ]; then
    die "网页升级需要服务器已安装可用的 C 编译器"
  fi
  case "$(host_os)" in
    darwin)
      warn "未检测到可用的 C 编译器（CGO 编译所需；macOS 需 Command Line Tools）"
      if ! xcode-select -p >/dev/null 2>&1; then
        info "将调用: xcode-select --install"
        info "系统会弹出安装确认窗口，请完成安装；脚本最多等待 ${RSM_CLT_WAIT_SECONDS:-300} 秒。"
        xcode-select --install >/dev/null 2>&1 || true
      else
        info "已安装开发工具但 clang/标准头文件不可用（可能是 Xcode 许可未确认）。"
        info "本脚本不会要求 sudo 接受许可；请安装/修复 Command Line Tools，或用 RSM_CC 指定可用 clang。"
      fi
      _ecc_wait="${RSM_CLT_WAIT_SECONDS:-300}"
      _ecc_elapsed=0
      while [ "$_ecc_elapsed" -lt "$_ecc_wait" ]; do
        if detect_c_compiler >/dev/null; then
          export_cgo_env
          ok "C 编译器已就绪: ${CC}（SDK: ${SDKROOT:-系统默认}）"
          return 0
        fi
        sleep 10
        _ecc_elapsed=$((_ecc_elapsed+10))
      done
      die "仍没有可用的 C 编译器。请安装 Xcode Command Line Tools 后重试，或 RSM_CC=/path/to/clang 指定（脚本只做真实编译探测）" ;;
    linux)
      case "$(pkg_manager)" in
        apt) pkg_install build-essential ;;
        dnf) pkg_install gcc gcc-c++ make ;;
        yum) pkg_install gcc gcc-c++ make ;;
        *) die "缺少 C 编译器且无法识别包管理器；请安装 gcc/g++/make 后重试" ;;
      esac
      detect_c_compiler >/dev/null || die "安装后仍没有可用的 C 编译器（CGO 需要）"
      export_cgo_env ;;
    *) die "不支持的平台，无法准备 C 编译器" ;;
  esac
}

# mode: tools=只需 Go/Node/pnpm；build=tools + C 编译器
ensure_toolchain() {
  setup_build_cache_env
  _et_mode="${1:-build}"
  ensure_download_tools
  setup_go_env
  if [ "${RSM_TOOLCHAIN_MODE:-pinned}" = "system" ]; then
    resolve_system_toolchain
    if [ "$_et_mode" = "build" ]; then ensure_c_compiler; fi
    return 0
  fi
  if load_toolchain_env; then
    :
  else
    ensure_go
    ensure_node
    ensure_pnpm
    save_toolchain_env
    toolchain_apply_path
  fi
  if [ -z "${RSM_GO_BIN:-}" ] || [ ! -x "$RSM_GO_BIN" ]; then die "内部错误：Go 未就绪"; fi
  if [ -z "${RSM_NODE_BIN:-}" ] || [ ! -x "$RSM_NODE_BIN" ]; then die "内部错误：Node 未就绪"; fi
  if [ -z "${RSM_PNPM_BIN:-}" ] || [ ! -x "$RSM_PNPM_BIN" ]; then die "内部错误：pnpm 未就绪"; fi
  if [ "$_et_mode" = "build" ]; then ensure_c_compiler; fi
  return 0
}

# 高级模式：RSM_TOOLCHAIN_MODE=system 时直接复用 PATH 上的 go/node/pnpm，不下载 .tools。
# 版本不满足要求会明确失败（不静默降级）；C 编译器仍会真实探测。
resolve_system_toolchain() {
  _rst_go=$(command -v go 2>/dev/null || true)
  _rst_node=$(command -v node 2>/dev/null || true)
  _rst_pnpm=$(command -v pnpm 2>/dev/null || true)
  [ -n "$_rst_go" ] || die "RSM_TOOLCHAIN_MODE=system 但 PATH 中没有 go"
  [ -n "$_rst_node" ] || die "RSM_TOOLCHAIN_MODE=system 但 PATH 中没有 node"
  [ -n "$_rst_pnpm" ] || die "RSM_TOOLCHAIN_MODE=system 但 PATH 中没有 pnpm"
  _rst_gover=$(version_of_cmd "$_rst_go" version | sed -n 's/go version go\([0-9.]*\).*/\1/p')
  _rst_nodever=$("$_rst_node" --version 2>/dev/null | sed 's/^v//')
  _rst_pnpmver=$("$_rst_pnpm" --version 2>/dev/null)
  _rst_min_go=$(tc_get go.minVersion)
  is_uint "$(printf '%s' "$_rst_gover" | cut -d. -f1)" || die "无法识别系统 Go 版本"
  _rst_go_ok=1
  _rst_min_major=$(printf '%s' "$_rst_min_go" | cut -d. -f1)
  _rst_go_major=$(printf '%s' "$_rst_gover" | cut -d. -f1)
  _rst_go_minor=$(printf '%s' "$_rst_gover" | cut -d. -f2)
  _rst_min_minor=$(printf '%s' "$_rst_min_go" | cut -d. -f2)
  if [ "$_rst_go_major" -lt "$_rst_min_major" ] 2>/dev/null; then _rst_go_ok=0
  elif [ "$_rst_go_major" = "$_rst_min_major" ] && [ "$_rst_go_minor" -lt "$_rst_min_minor" ] 2>/dev/null; then _rst_go_ok=0; fi
  [ "$_rst_go_ok" = "1" ] || die "系统 Go $_rst_gover 低于最低要求 $_rst_min_go"
  _rst_node_major=$(printf '%s' "$_rst_nodever" | cut -d. -f1)
  _rst_node_min=$(tc_get node.minMajor)
  [ "$_rst_node_major" -ge "$_rst_node_min" ] 2>/dev/null || die "系统 Node $_rst_nodever 低于最低要求 major $_rst_node_min"
  RSM_GO_BIN="$_rst_go"; RSM_NODE_BIN="$_rst_node"; RSM_NPM_BIN=$(command -v npm 2>/dev/null || true); RSM_PNPM_BIN="$_rst_pnpm"
  [ -n "$RSM_NPM_BIN" ] || die "RSM_TOOLCHAIN_MODE=system 但 PATH 中没有 npm"
  toolchain_apply_path
  warn "使用系统工具链（未安装 .tools 固定版本）：Go $_rst_gover / Node $_rst_nodever / pnpm $_rst_pnpmver"
  return 0
}

toolchain_status() {
  _ts_go="${RSM_GO_BIN:-}"
  _ts_node="${RSM_NODE_BIN:-}"
  _ts_pnpm="${RSM_PNPM_BIN:-}"
  _ts_gv="未解析"; _ts_nv="未解析"; _ts_pv="未解析"
  if [ -n "$_ts_go" ] && [ -x "$_ts_go" ]; then _ts_gv=$("$_ts_go" version 2>/dev/null | sed -n 's/go version go\([0-9.]*\).*/\1/p'); fi
  if [ -n "$_ts_node" ] && [ -x "$_ts_node" ]; then _ts_nv=$("$_ts_node" --version 2>/dev/null | sed 's/^v//'); fi
  if [ -n "$_ts_pnpm" ] && [ -x "$_ts_pnpm" ]; then _ts_pv=$("$_ts_pnpm" --version 2>/dev/null); fi
  printf 'Go:   %s（固定 %s，%s）\n' "$_ts_gv" "$(tc_go_version)" "$_ts_go"
  printf 'Node: %s（固定 %s，%s）\n' "$_ts_nv" "$(tc_node_version)" "$_ts_node"
  printf 'pnpm: %s（固定 %s，%s）\n' "$_ts_pv" "$(tc_pnpm_version)" "$_ts_pnpm"
  printf '平台: %s  工具目录: %s\n' "$(platform_key)" "$TOOLS_DIR"
  if [ -x "$TOOLS_DIR/go/bin/go" ]; then printf 'Go 安装: .tools/go\n'; else printf 'Go 安装: 未安装到 .tools（可使用系统匹配版本）\n'; fi
  if [ -x "$TOOLS_DIR/node/bin/node" ]; then printf 'Node 安装: .tools/node\n'; fi
  if [ -x "$TOOLS_DIR/pnpm/node_modules/.bin/pnpm" ]; then printf 'pnpm 安装: .tools/pnpm\n'; fi
}
