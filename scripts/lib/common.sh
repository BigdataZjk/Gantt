#!/usr/bin/env bash
# RSM 部署/管理脚本公共函数。供 rsm.sh 及 scripts/*.sh source。
# 兼容 macOS 自带 bash 3.2 与 Linux bash 4/5；不使用关联数组、mapfile、下标大小写转换等新语法。

set -u
set -o pipefail

RSM_SH_VERSION="1.0.0"
RSM_DEFAULT_ADDR="0.0.0.0:1111"
RSM_HEALTH_PATH="/healthz"
RSM_PROGRESS_TOTAL=0
RSM_PROGRESS_CURRENT=0
RSM_SPINNER_PID=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$(printf '\033[0m')
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RED=$(printf '\033[31m')
  C_GREEN=$(printf '\033[32m')
  C_YELLOW=$(printf '\033[33m')
  C_CYAN=$(printf '\033[36m')
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

log_file() {
  if [ -n "${RSM_LOG_FILE:-}" ]; then
    { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$RSM_LOG_FILE"; } 2>/dev/null || true
  fi
}
info() { log_file "[info] $*"; printf '%s%s%s\n' "$C_CYAN" "$*" "$C_RESET"; }
ok()   { log_file "[ok] $*";   printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { log_file "[warn] $*"; printf '%s警告: %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die() {
  progress_stop
  log_file "[error] $*"
  printf '%s错误: %s%s\n' "$C_RED" "$*" "$C_RESET" >&2
  if [ -n "${RSM_LOG_FILE:-}" ] && [ -f "$RSM_LOG_FILE" ]; then
    printf '详细日志: %s\n' "$RSM_LOG_FILE" >&2
  fi
  exit "${RSM_DIE_CODE:-1}"
}
step() {
  local label="$*"
  if [ "$RSM_PROGRESS_TOTAL" -gt 0 ]; then
    RSM_PROGRESS_CURRENT=$((RSM_PROGRESS_CURRENT+1))
    label="[$RSM_PROGRESS_CURRENT/$RSM_PROGRESS_TOTAL] $label"
  fi
  log_file "[step] $label"
  printf '\n%s==> %s%s\n' "$C_BOLD" "$label" "$C_RESET"
}
debug() { if [ "${RSM_DEBUG:-0}" = 1 ]; then log_file "[debug] $*"; printf '%sdebug: %s%s\n' "$C_DIM" "$*" "$C_RESET" >&2; fi; }

progress_plan() { RSM_PROGRESS_TOTAL="$1"; RSM_PROGRESS_CURRENT=0; }

init_task_log() {
  if [ "$#" -gt 0 ] || [ -z "${RSM_LOG_FILE:-}" ]; then
    RSM_LOG_FILE="${1:-${RSM_ROOT:-$PWD}/.cache/logs/tasks.log}"
    mkdir -p "$(dirname "$RSM_LOG_FILE")" || die "无法创建日志目录"
    rotate_log "$RSM_LOG_FILE" 10485760
  fi
  if ! : >>"$RSM_LOG_FILE"; then die "无法写入日志: $RSM_LOG_FILE"; fi
  chmod 600 "$RSM_LOG_FILE" 2>/dev/null || true
  export RSM_LOG_FILE
}

progress_stop() {
  if [ -n "$RSM_SPINNER_PID" ]; then
    kill "$RSM_SPINNER_PID" 2>/dev/null || true
    wait "$RSM_SPINNER_PID" 2>/dev/null || true
    RSM_SPINNER_PID=""
    printf '\r\033[2K'
  fi
}

run_logged() {
  local label="$1" started="$SECONDS" status elapsed owner="$$"
  shift
  init_task_log
  log_file "[running] $label"
  if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ "${RSM_VERBOSE:-0}" != "1" ]; then
    (
      local frame=0 frames='|/-\\'
      trap 'exit 0' TERM HUP
      while kill -0 "$owner" 2>/dev/null; do
        printf '\r\033[2K  %s %s · %ss' "${frames:frame%4:1}" "$label" "$((SECONDS-started))"
        frame=$((frame+1))
        sleep 0.15
      done
    ) &
    RSM_SPINNER_PID=$!
  else
    printf '  … %s\n' "$label"
  fi
  if [ "${RSM_VERBOSE:-0}" = "1" ]; then
    if "$@" 2>&1 | tee -a "$RSM_LOG_FILE"; then status=0; else status=$?; fi
  elif "$@" >>"$RSM_LOG_FILE" 2>&1; then
    status=0
  else
    status=$?
  fi
  progress_stop
  elapsed=$((SECONDS-started))
  if [ "$status" -eq 0 ]; then
    log_file "[ok] $label (${elapsed}s)"
    printf '  %s✓ %s（%ss）%s\n' "$C_GREEN" "$label" "$elapsed" "$C_RESET"
  else
    log_file "[error] $label (exit=$status, ${elapsed}s)"
    printf '  %s✗ %s（退出码 %s，%ss）%s\n' "$C_RED" "$label" "$status" "$elapsed" "$C_RESET" >&2
    printf '最近的详细日志（最多 24 行）:\n' >&2
    tail -n 24 "$RSM_LOG_FILE" >&2
    printf '完整日志: %s\n' "$RSM_LOG_FILE" >&2
  fi
  return "$status"
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }
require_cmd() { have_cmd "$1" || die "缺少命令 ${1}（请先运行 scripts/bootstrap.sh 或安装该命令）"; }

host_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) printf '%s' "$(uname -s | tr 'A-Z' 'a-z')" ;;
  esac
}

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) printf '%s' "$(uname -m)" ;;
  esac
}

platform_key() { printf '%s-%s' "$(host_os)" "$(host_arch)"; }

os_pretty() {
  case "$(host_os)" in
    darwin) printf 'macOS' ;;
    linux) printf 'Linux' ;;
    *) host_os ;;
  esac
}

abs_path() {
  _ap_in="$1"
  [ -n "$_ap_in" ] || { printf ''; return 1; }
  case "$_ap_in" in
    "~") _ap_in="$HOME" ;;
    "~/"*) _ap_in="$HOME/${_ap_in#\\~/}" ;;
  esac
  case "$_ap_in" in
    /*) ;;
    *) _ap_in="$(pwd -P)/$_ap_in" ;;
  esac
  if [ -d "$_ap_in" ]; then
    ( cd "$_ap_in" 2>/dev/null && pwd -P )
    return $?
  fi
  _ap_parent=$(dirname "$_ap_in")
  _ap_base=$(basename "$_ap_in")
  if [ -d "$_ap_parent" ]; then
    _ap_parent_abs=$( cd "$_ap_parent" 2>/dev/null && pwd -P ) || { printf '%s' "$_ap_in"; return 0; }
    printf '%s/%s' "$_ap_parent_abs" "$_ap_base"
    return 0
  fi
  printf '%s' "$_ap_in"
}

sha256_file() {
  _sf="$1"
  [ -f "$_sf" ] || return 1
  if have_cmd sha256sum; then
    sha256sum "$_sf" | awk '{print $1}'
  elif have_cmd shasum; then
    shasum -a 256 "$_sf" | awk '{print $1}'
  elif have_cmd openssl; then
    openssl dgst -sha256 "$_sf" | awk '{print $NF}'
  else
    return 1
  fi
}

sha256_text() {
  if have_cmd sha256sum; then printf '%s' "$1" | sha256sum | awk '{print $1}'
  elif have_cmd shasum; then printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'; fi
}

short_hash() { sha256_text "$1" | cut -c1-8; }

file_size() {
  [ -f "$1" ] || { printf '0'; return 0; }
  case "$(host_os)" in
    darwin) stat -f '%z' "$1" 2>/dev/null || printf '0' ;;
    *) stat -c '%s' "$1" 2>/dev/null || printf '0' ;;
  esac
}

file_mtime() {
  [ -e "$1" ] || { printf '0'; return 0; }
  case "$(host_os)" in
    darwin) stat -f '%m' "$1" 2>/dev/null || printf '0' ;;
    *) stat -c '%Y' "$1" 2>/dev/null || printf '0' ;;
  esac
}

human_size() {
  awk -v b="${1:-0}" 'BEGIN{
    split("B KiB MiB GiB TiB", u, " "); i=1;
    while (b >= 1024 && i < 5) { b=b/1024; i++ }
    if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i];
  }'
}

is_uint() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

to_int() { awk -v n="${1:-0}" 'BEGIN{printf "%d", n+0}'; }
num_gt() { [ "$(to_int "$1")" -gt "$(to_int "$2")" ]; }
num_ge() { [ "$(to_int "$1")" -ge "$(to_int "$2")" ]; }
num_max() { if num_gt "$1" "$2"; then to_int "$1"; else to_int "$2"; fi; }

trim() {
  _t="$1"
  _t="${_t#"${_t%%[![:space:]]*}"}"
  _t="${_t%"${_t##*[![:space:]]}"}"
  printf '%s' "$_t"
}

timestamp_utc() { date -u '+%Y%m%dT%H%M%SZ'; }
timestamp_compact() { date -u '+%Y%m%d-%H%M%S'; }
now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

binary_version() {
  _bv_bin="$1"
  [ -x "$_bv_bin" ] || return 1
  _bv_out=$("$_bv_bin" --version 2>/dev/null) || return 1
  printf '%s' "$_bv_out" | tr ' \t' '\n' | awk '/^v?[0-9]+\.[0-9]+(\.[0-9]+)?([-+][A-Za-z0-9._-]+)?$/{v=$0} END{if(v!=""){sub(/^v/,"",v);print v; exit 0} exit 1}'
}

version_eq() { [ "${1:-}" = "${2:-}" ]; }

take_flag_value() {
  _tfv_name="$1"; _tfv_arg="$2"; _tfv_next="${3:-}"
  case "$_tfv_arg" in
    "$_tfv_name"=*) printf '%s' "${_tfv_arg#*=}"; return 0 ;;
    "$_tfv_name") [ -n "$_tfv_next" ] || die "参数 $_tfv_name 缺少取值"; printf '%s' "$_tfv_next"; return 0 ;;
  esac
  return 1
}

is_tty() { [ -t 0 ]; }

confirm_yes() {
  _cy_prompt="$1"
  if [ "${RSM_ASSUME_YES:-0}" = "1" ]; then
    info "${_cy_prompt}（已通过 --yes 确认）"
    return 0
  fi
  if ! is_tty; then
    die "${_cy_prompt}；当前不是交互终端，确认后请加 --yes 重新执行"
  fi
  printf '%s 请输入 yes 确认: ' "$_cy_prompt"
  _cy_ans=""
  read -r _cy_ans || true
  case "$_cy_ans" in
    yes|YES|Yes) return 0 ;;
    *) die "已取消" ;;
  esac
}

atomic_write() {
  _aw_path="$1"; _aw_mode="${2:-600}"
  _aw_dir=$(dirname "$_aw_path")
  mkdir -p "$_aw_dir" || return 1
  _aw_tmp="$_aw_dir/.$(basename "$_aw_path").tmp.$$"
  if ! cat >"$_aw_tmp"; then rm -f "$_aw_tmp"; return 1; fi
  chmod "$_aw_mode" "$_aw_tmp" 2>/dev/null || true
  mv -f "$_aw_tmp" "$_aw_path" || { rm -f "$_aw_tmp"; return 1; }
}

write_file() { printf '%s' "$3" | atomic_write "$1" "${2:-600}"; }

tail_lines() {
  [ -f "$1" ] || return 1
  tail -n "${2:-80}" "$1"
}

rotate_log() {
  _rl_path="$1"; _rl_max="${2:-10485760}"
  [ -f "$_rl_path" ] || return 0
  if [ "$(file_size "$_rl_path")" -gt "$_rl_max" ] 2>/dev/null; then
    mv -f "$_rl_path" "$_rl_path.1" 2>/dev/null || true
    : >"$_rl_path" 2>/dev/null || true
    chmod 600 "$_rl_path" 2>/dev/null || true
  fi
}

ensure_private_dir() {
  _epd="$1"
  if [ -d "$_epd" ]; then
    chmod 700 "$_epd" 2>/dev/null || true
  else
    mkdir -p "$_epd" 2>/dev/null || return 1
    chmod 700 "$_epd" 2>/dev/null || true
  fi
}

ensure_dir() {
  [ -d "$1" ] || mkdir -p "$1" || return 1
}

# 读取脚本使用的 JSON 叶子值（仅支持对象/字符串/数字/布尔；数组请改用 SHA256SUMS）。
json_get() {
  _jg_file="$1"; _jg_path="$2"
  [ -f "$_jg_file" ] || return 1
  awk -v path="$_jg_path" '
    BEGIN { depth = 0; found = 0; root = 0 }
    {
      line = $0
      sub(/^[ \t]+/, "", line); sub(/[ \t\r]+$/, "", line)
      if (line == "") next
      if (line == "{") { if (root == 0) { root = 1; next } depth++; next }
      if (line == "}" || line == "},") { depth--; next }
      if (line ~ /^\[\]/) next
      sub(/,$/, "", line)
      if (match(line, /^"[^"]+"[ \t]*:[ \t]*\{[ \t]*$/)) {
        key = line; sub(/^"/, "", key); sub(/".*/, "", key)
        depth++; cur[depth] = key; next
      }
      if (match(line, /^"[^"]+"[ \t]*:[ \t]*/)) {
        key = line; sub(/^"/, "", key); sub(/".*/, "", key)
        val = line; sub(/^"[^"]+"[ \t]*:[ \t]*/, "", val)
        if (val ~ /^".*"$/) { sub(/^"/, "", val); sub(/"$/, "", val) }
        else { sub(/,$/, "", val) }
        full = ""
        for (i = 1; i <= depth; i++) { if (cur[i] != "") full = full cur[i] "." }
        full = full key
        if (full == path) { print val; found = 1; exit 0 }
      }
    }
    END { if (!found) exit 1 }
  ' "$_jg_file"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

addr_port() {
  _ap_addr="${1:-$RSM_DEFAULT_ADDR}"
  printf '%s' "${_ap_addr##*:}"
}

addr_host() {
  _ah_addr="${1:-$RSM_DEFAULT_ADDR}"
  _ah_host="${_ah_addr%:*}"
  case "$_ah_host" in
    "["*) _ah_host="${_ah_host#\\[}"; _ah_host="${_ah_host%\\]}" ;;
  esac
  printf '%s' "$_ah_host"
}

probe_host() {
  _ph_host=$(addr_host "$1")
  case "$_ph_host" in
    ''|0.0.0.0|'*'|'::'|'[::]') printf '127.0.0.1' ;;
    *) printf '%s' "$_ph_host" ;;
  esac
}

http_url() {
  _hu_host=$(probe_host "$1")
  _hu_port=$(addr_port "$1")
  case "$_hu_host" in
    *:*) printf 'http://[%s]:%s%s' "$_hu_host" "$_hu_port" "$2" ;;
    *) printf 'http://%s:%s%s' "$_hu_host" "$_hu_port" "$2" ;;
  esac
}

port_open() {
  _po_host="$1"; _po_port="$2"
  is_uint "$_po_port" || return 1
  case "$_po_host" in
    *:*)
      have_cmd curl || return 1
      curl -sS -o /dev/null --max-time 1 "http://[$_po_host]:$_po_port/" >/dev/null 2>&1 && return 0
      return 1 ;;
  esac
  ( exec 3<>"/dev/tcp/$_po_host/$_po_port" ) >/dev/null 2>&1
}

http_code() {
  _hc_url=$(http_url "$1" "$2")
  _hc_to="${3:-3}"
  if have_cmd curl; then
    _hc_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$_hc_to" "$_hc_url" 2>/dev/null) || _hc_code="000"
    printf '%s' "$_hc_code"
    return 0
  fi
  _hc_host=$(probe_host "$1"); _hc_port=$(addr_port "$1"); _hc_path="$2"
  case "$_hc_host" in *:*) printf '000'; return 0 ;; esac
  _hc_code=$(
    ( exec 3<>"/dev/tcp/$_hc_host/$_hc_port" || exit 1
      printf 'GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n' "$_hc_path" "$_hc_host" >&3
      IFS= read -r -t "$_hc_to" line <&3 || exit 1
      printf '%s\n' "$line" ) 2>/dev/null | awk '{print $2}' | head -n1
  )
  [ -n "$_hc_code" ] && printf '%s' "$_hc_code" || printf '000'
}

http_body() {
  _hb_url=$(http_url "$1" "$2")
  _hb_to="${3:-3}"
  if have_cmd curl; then
    curl -sS --max-time "$_hb_to" -H 'Accept: application/json' "$_hb_url" 2>/dev/null || true
    return 0
  fi
  _hb_host=$(probe_host "$1"); _hb_port=$(addr_port "$1"); _hb_path="$2"
  case "$_hb_host" in *:*) return 0 ;; esac
  (
    exec 3<>"/dev/tcp/$_hb_host/$_hb_port" || exit 1
    printf 'GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n' "$_hb_path" "$_hb_host" >&3
    _hb_n=0
    while IFS= read -r -t "$_hb_to" _hb_line <&3; do
      printf '%s\n' "$_hb_line"
      _hb_n=$((_hb_n+1)); [ "$_hb_n" -ge 400 ] && break
    done
  ) 2>/dev/null
}

json_field_from_body() {
  printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' | head -n1
}

free_port() {
  _fp_try=0
  while [ "$_fp_try" -lt 40 ]; do
    _fp_port=$(awk -v seed="$$" -v n="$_fp_try" 'BEGIN{srand(seed+n*7919); print 20000+int(rand()*20000)}')
    if ! port_open 127.0.0.1 "$_fp_port"; then printf '%s' "$_fp_port"; return 0; fi
    _fp_try=$((_fp_try+1))
  done
  return 1
}

process_cmdline() {
  _pc_pid="$1"
  is_uint "$_pc_pid" || return 1
  case "$(host_os)" in
    linux)
      [ -r "/proc/$_pc_pid/cmdline" ] || return 1
      tr '\0' ' ' <"/proc/$_pc_pid/cmdline" 2>/dev/null | sed 's/[ ]*$//'
      ;;
    *)
      ps -p "$_pc_pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' ;;
  esac
}

pid_alive() { is_uint "${1:-}" && kill -0 "$1" 2>/dev/null; }

run_quiet() {
  _rq_log="$1"; shift
  if "$@" >"$_rq_log" 2>&1; then return 0; fi
  _rq_rc=$?
  warn "命令失败: $*"
  [ -f "$_rq_log" ] && tail -n 40 "$_rq_log" >&2
  return "$_rq_rc"
}

assert_supported_platform() {
  _asp_os=$(host_os); _asp_arch=$(host_arch)
  case "$_asp_os" in
    darwin|linux) ;;
    *) die "不支持的系统: ${_asp_os}（仅支持 macOS / Linux）" ;;
  esac
  case "$_asp_arch" in
    amd64|arm64) ;;
    *) die "不支持的 CPU 架构: ${_asp_arch}（仅支持 amd64 / arm64）" ;;
  esac
}

user_home() {
  if [ -n "${HOME:-}" ]; then printf '%s' "$HOME"
  else printf '%s' "$(cd ~ 2>/dev/null && pwd -P)"; fi
}

default_home_path() {
  printf '%s' "${RSM_ROOT:-$PWD}"
}
