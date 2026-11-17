#!/usr/bin/env bash
# 实例层：home/config/state、发布版本元数据、PID 归属校验、端口、健康检查、启停、状态与日志。
# 依赖 common.sh、toolchain.sh、lock.sh、service.sh 已 source；rsm.sh 负责设置 RSM_ROOT 与 RSM_HOME/RSM_ADDR。

RSM_LOG_FILE=""
ST_LOADED=""
ST_SCHEMA_VERSION="0"
ST_ACTIVE_RELEASE=""
ST_ACTIVE_VERSION=""
ST_INSTALLED_AT=""
ST_LAST_STARTED_AT=""
ST_LAST_STOPPED_AT=""
ST_LAST_DEPLOYED_AT=""
ST_LAST_BACKUP=""
ST_LAST_RESTORE=""

home_config_path() { printf '%s/config.json' "$RSM_HOME"; }
home_state_path() { printf '%s/run/instance.json' "$RSM_HOME"; }
home_pid_path() { printf '%s/run/rsm.pid' "$RSM_HOME"; }
home_log_path() { printf '%s/logs/rsm.log' "$RSM_HOME"; }
home_service_log_path() { printf '%s/logs/service.log' "$RSM_HOME"; }
home_backups_dir() { printf '%s/backups' "$RSM_HOME"; }
home_releases_dir() { printf '%s/releases' "$RSM_HOME"; }
home_current_link() { printf '%s/current' "$RSM_HOME"; }
home_current_binary() { printf '%s/current/rsm' "$RSM_HOME"; }
home_wrapper_path() { printf '%s/scripts/lib/service-run.sh' "$RSM_HOME"; }

# 判断某目录是否是“已安装实例根目录”。
looks_like_installed_home() {
  [ -n "${1:-}" ] || return 1
  [ -f "$1/rsm.sh" ] && { [ -d "$1/releases" ] || [ -f "$1/config.json" ] || [ -d "$1/run" ]; }
}

# 解析 RSM_HOME：显式 --home/RSM_HOME > 入口脚本所在目录。
resolve_home() {
  if [ -n "${RSM_HOME_ARG:-}" ]; then
    RSM_HOME=$(abs_path "$RSM_HOME_ARG") || die "无法解析安装目录: $RSM_HOME_ARG"
    RSM_HOME_EXPLICIT=1
  elif looks_like_installed_home "$RSM_ROOT"; then
    RSM_HOME=$(abs_path "$RSM_ROOT")
    RSM_HOME_EXPLICIT=0
  else
    RSM_HOME=$(abs_path "$(default_home_path)")
    RSM_HOME_EXPLICIT=0
  fi
  case "$RSM_HOME" in
    ""|"/") die "安装目录不能为空或根目录: '$RSM_HOME'" ;;
  esac
  [ "$RSM_HOME" = "$(user_home)" ] && die "安装目录不能是用户主目录本身: $RSM_HOME"
  export RSM_HOME
}

# 建立运行目录（首次创建 700；已存在则只收紧脚本管理的子目录）。
ensure_layout() {
  if [ ! -d "$RSM_HOME" ]; then
    mkdir -p "$RSM_HOME" || die "无法创建安装目录: $RSM_HOME"
    chmod 700 "$RSM_HOME" 2>/dev/null || true
  fi
  for _el_d in data secrets logs backups releases run scripts scripts/lib upgrade; do
    mkdir -p "$RSM_HOME/$_el_d" || die "无法创建目录: $RSM_HOME/$_el_d"
  done
  for _el_d in data secrets logs backups run scripts scripts/lib upgrade; do
    chmod 700 "$RSM_HOME/$_el_d" 2>/dev/null || true
  done
  # 日志文件权限：存在则收紧，避免其他用户读取运行日志。
  if [ -f "$(home_log_path)" ]; then chmod 600 "$(home_log_path)" 2>/dev/null || true; fi
  if [ -f "$(home_service_log_path)" ]; then chmod 600 "$(home_service_log_path)" 2>/dev/null || true; fi
  config_ensure
  state_load
  if [ ! -f "$(home_state_path)" ]; then state_save; fi
}

config_ensure() {
  _ce_cfg="$(home_config_path)"
  [ -f "$_ce_cfg" ] && return 0
  _ce_addr="${RSM_ADDR_REQUESTED:-$RSM_DEFAULT_ADDR}"
  {
    printf '{\n'
    printf '  "home": "%s",\n' "$RSM_HOME"
    printf '  "addr": "%s",\n' "$_ce_addr"
    printf '  "createdAt": "%s",\n' "$(now_iso)"
    printf '  "updatedAt": "%s"\n' "$(now_iso)"
    printf '}\n'
  } | atomic_write "$_ce_cfg" 600
}

config_get_addr() {
  [ -f "$(home_config_path)" ] || return 1
  json_get "$(home_config_path)" addr
}

config_created_at() {
  [ -f "$(home_config_path)" ] || return 1
  json_get "$(home_config_path)" createdAt
}

# 监听地址解析：--addr/RSM_ADDR > config.json > 默认 0.0.0.0:1111
resolve_addr() {
  RSM_ADDR_SOURCE="default"
  if [ -n "${RSM_ADDR_ARG:-}" ]; then
    RSM_ADDR="$RSM_ADDR_ARG"
    RSM_ADDR_SOURCE="explicit"
  elif _ra_cfg=$(config_get_addr 2>/dev/null) && [ -n "$_ra_cfg" ]; then
    RSM_ADDR="$_ra_cfg"
    RSM_ADDR_SOURCE="config"
  else
    RSM_ADDR="$RSM_DEFAULT_ADDR"
  fi
  validate_addr "$RSM_ADDR" || die "监听地址格式无效: ${RSM_ADDR}（应为 host:port，例如 0.0.0.0:1111）"
  export RSM_ADDR
}

validate_addr() {
  _va_addr="$1"
  _va_port=$(addr_port "$_va_addr")
  is_uint "$_va_port" || return 1
  [ "$(to_int "$_va_port")" -ge 1 ] && [ "$(to_int "$_va_port")" -le 65535 ] || return 1
  case "$_va_addr" in
    *:*:*) : ;;  # IPv6 或 host:port 形式，端口已单独校验
  esac
  return 0
}

# 追加事件日志（部署/启停等），不记录任何密钥。
event_log() {
  _ev_msg="$1"
  mkdir -p "$RSM_HOME/logs" 2>/dev/null || true
  printf '%s %s\n' "$(now_iso)" "$_ev_msg" >>"$RSM_HOME/logs/deploy.log" 2>/dev/null || true
  chmod 600 "$RSM_HOME/logs/deploy.log" 2>/dev/null || true
}

# ---- instance.json 状态 ----
state_load() {
  if [ "${ST_LOADED:-}" = "1" ]; then return 0; fi
  ST_SCHEMA_VERSION="0"; ST_ACTIVE_RELEASE=""; ST_ACTIVE_VERSION=""
  ST_INSTALLED_AT=""; ST_LAST_STARTED_AT=""; ST_LAST_STOPPED_AT=""
  ST_LAST_DEPLOYED_AT=""; ST_LAST_BACKUP=""; ST_LAST_RESTORE=""
  [ -f "$(home_state_path)" ] || return 0
  ST_SCHEMA_VERSION=$(json_get "$(home_state_path)" schemaVersion 2>/dev/null || true)
  is_uint "$ST_SCHEMA_VERSION" || ST_SCHEMA_VERSION="0"
  ST_ACTIVE_RELEASE=$(json_get "$(home_state_path)" activeRelease 2>/dev/null || true)
  ST_ACTIVE_VERSION=$(json_get "$(home_state_path)" activeVersion 2>/dev/null || true)
  ST_INSTALLED_AT=$(json_get "$(home_state_path)" installedAt 2>/dev/null || true)
  ST_LAST_STARTED_AT=$(json_get "$(home_state_path)" lastStartedAt 2>/dev/null || true)
  ST_LAST_STOPPED_AT=$(json_get "$(home_state_path)" lastStoppedAt 2>/dev/null || true)
  ST_LAST_DEPLOYED_AT=$(json_get "$(home_state_path)" lastDeployedAt 2>/dev/null || true)
  ST_LAST_BACKUP=$(json_get "$(home_state_path)" lastBackup 2>/dev/null || true)
  ST_LAST_RESTORE=$(json_get "$(home_state_path)" lastRestore 2>/dev/null || true)
  ST_LOADED="1"
  return 0
}

state_save() {
  {
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "schemaVersion": %s,\n' "$(to_int "$ST_SCHEMA_VERSION")"
    printf '  "activeRelease": "%s",\n' "$ST_ACTIVE_RELEASE"
    printf '  "activeVersion": "%s",\n' "$ST_ACTIVE_VERSION"
    printf '  "installedAt": "%s",\n' "$ST_INSTALLED_AT"
    printf '  "lastStartedAt": "%s",\n' "$ST_LAST_STARTED_AT"
    printf '  "lastStoppedAt": "%s",\n' "$ST_LAST_STOPPED_AT"
    printf '  "lastDeployedAt": "%s",\n' "$ST_LAST_DEPLOYED_AT"
    printf '  "lastBackup": "%s",\n' "$ST_LAST_BACKUP"
    printf '  "lastRestore": "%s"\n' "$ST_LAST_RESTORE"
    printf '}\n'
  } | atomic_write "$(home_state_path)" 600
}

# ---- 版本/发布目录 ----
release_meta_get() { # release_dir key
  json_get "$1/release.json" "$2" 2>/dev/null || true
}
release_version_of() { release_meta_get "$1" version; }
release_schema_of() { release_meta_get "$1" schemaVersion; }
release_os_of() { release_meta_get "$1" os; }
release_arch_of() { release_meta_get "$1" arch; }
release_installed_at_of() { cat "$1/installed-at" 2>/dev/null || file_mtime "$1/release.json"; }

current_release_dir() {
  _crd_link="$(home_current_link)"
  [ -L "$_crd_link" ] || return 1
  _crd_target=$(readlink "$_crd_link" 2>/dev/null || true)
  [ -n "$_crd_target" ] || return 1
  case "$_crd_target" in
    /*) printf '%s' "$_crd_target" ;;
    *) printf '%s/%s' "$RSM_HOME" "$_crd_target" ;;
  esac
}

current_binary() { printf '%s' "$(home_current_binary)"; }

instance_installed() {
  [ -x "$(home_current_binary)" ] && [ -f "$(current_release_dir)/release.json" ]
}

installed_version() {
  _iv_dir=$(current_release_dir 2>/dev/null) || return 1
  release_version_of "$_iv_dir"
}

# ---- PID / 进程归属 ----
pid_read() {
  [ -f "$(home_pid_path)" ] || return 1
  _pr_pid=$(head -n 1 "$(home_pid_path)" 2>/dev/null | tr -d '[:space:]')
  is_uint "$_pr_pid" || return 1
  printf '%s' "$_pr_pid"
}

pid_clear() { rm -f "$(home_pid_path)" 2>/dev/null || true; }

# 关键安全校验：只有命令行同时包含 serve 与 --home <本实例 home> 才认为是本实例进程，
# 避免 PID 复用或手工误杀其他进程。
pid_is_ours() {
  _pio_pid="$1"
  is_uint "$_pio_pid" || return 1
  pid_alive "$_pio_pid" || return 1
  _pio_cmd=$(process_cmdline "$_pio_pid" 2>/dev/null) || return 1
  case "$_pio_cmd" in
    *" serve "*) : ;;
    *"rsm serve") : ;;
    *) return 1 ;;
  esac
  case "$_pio_cmd" in
    *"--home $_pio_home "*|*"--home $_pio_home") return 0 ;;
    *"--home=$_pio_home "*|*"--home=$_pio_home") return 0 ;;
  esac
  return 1
}

instance_pid() {
  _ip_pid=$(pid_read 2>/dev/null) || return 1
  _pio_home="$RSM_HOME"
  pid_is_ours "$_ip_pid" || return 1
  printf '%s' "$_ip_pid"
}

instance_running() {
  instance_pid >/dev/null 2>&1
}

# 清理无效/陈旧的 pid 文件；若仍被非本实例进程占用则不动并报警。
cleanup_stale_pid() {
  _csp_pid=$(pid_read 2>/dev/null) || { pid_clear; return 0; }
  _pio_home="$RSM_HOME"
  if pid_is_ours "$_csp_pid"; then return 0; fi
  if pid_alive "$_csp_pid"; then
    warn "run/rsm.pid 指向的进程 $_csp_pid 不是本实例（$(process_cmdline "$_csp_pid" 2>/dev/null | cut -c1-160)），不会触碰它；清理陈旧 pid 文件"
  else
    debug "清理已退出进程的 pid 文件: $_csp_pid"
  fi
  pid_clear
}

# ---- 端口 ----
port_owner_hint() {
  _poh_port="$1"
  if have_cmd lsof; then
    _poh_pid=$(lsof -nP -iTCP:"$_poh_port" -sTCP:LISTEN -t 2>/dev/null | head -n1)
    if is_uint "$_poh_pid"; then
      printf 'pid=%s, %s' "$_poh_pid" "$(process_cmdline "$_poh_pid" 2>/dev/null | cut -c1-160)"
      return 0
    fi
  elif have_cmd ss; then
    ss -ltnp 2>/dev/null | awk -v p=":$_poh_port" '$4 ~ p {print $0; exit}' | cut -c1-200
    return 0
  elif have_cmd netstat; then
    netstat -ltn 2>/dev/null | awk -v p=":$_poh_port" '$4 ~ p {print $0; exit}' | tr -s ' '
    return 0
  fi
  printf '未知进程'
}

ensure_port_available() {
  if instance_running; then return 0; fi
  _epa_host=$(probe_host "$RSM_ADDR")
  _epa_port=$(addr_port "$RSM_ADDR")
  _epa_busy=0
  if port_open "$_epa_host" "$_epa_port"; then _epa_busy=1; fi
  if [ "$_epa_host" != "127.0.0.1" ] && port_open 127.0.0.1 "$_epa_port"; then _epa_busy=1; fi
  if [ "$_epa_busy" = "1" ]; then
    die "端口已被占用：$_epa_host:${_epa_port}（$(port_owner_hint "$_epa_port")）。为避免启动第二个实例，已中止。请先停止占用端口的程序，或用 RSM_ADDR/--addr 指定其他端口"
  fi
}

# ---- 配置/状态写入 ----
config_write_addr() {
  _cwa_addr="$1"
  _cwa_created=$(config_created_at 2>/dev/null || true)
  if [ -z "$_cwa_created" ]; then _cwa_created=$(now_iso); fi
  {
    printf '{\n'
    printf '  "home": "%s",\n' "$RSM_HOME"
    printf '  "addr": "%s",\n' "$_cwa_addr"
    printf '  "createdAt": "%s",\n' "$_cwa_created"
    printf '  "updatedAt": "%s"\n' "$(now_iso)"
    printf '}\n'
  } | atomic_write "$(home_config_path)" 600
}

persist_addr_if_explicit() {
  if [ "${RSM_ADDR_SOURCE:-}" != "explicit" ]; then return 0; fi
  _pae_cur=$(config_get_addr 2>/dev/null || true)
  if [ "$_pae_cur" != "$RSM_ADDR" ]; then
    config_write_addr "$RSM_ADDR"
    info "已更新 config.json 监听地址: $RSM_ADDR"
  fi
}

mark_schema_attempt() {
  _msa="$1"
  is_uint "$_msa" || _msa=0
  ST_SCHEMA_VERSION=$(num_max "$ST_SCHEMA_VERSION" "$_msa")
  state_save
}

mark_schema_confirmed() {
  _msc="$1"
  is_uint "$_msc" || return 0
  ST_SCHEMA_VERSION=$(to_int "$_msc")
  state_save
}

data_present() {
  [ -f "$RSM_HOME/data/rsm.db" ] && return 0
  [ -d "$RSM_HOME/data" ] && [ -n "$(ls -A "$RSM_HOME/data" 2>/dev/null)" ] && return 0
  return 1
}

require_installed() {
  instance_installed || die "未安装 RSM（$RSM_HOME 下没有 current/rsm）。请先在仓库目录或发行包目录运行 ./rsm.sh 完成部署"
}

# ---- 文件安装 ----
ensure_service_wrapper() {
  _esw_src="$RSM_ROOT/scripts/lib/service-run.sh"
  _esw_dst="$(home_wrapper_path)"
  mkdir -p "$(dirname "$_esw_dst")" || die "无法创建目录: $(dirname "$_esw_dst")"
  if [ -f "$_esw_src" ] && [ "$_esw_src" != "$_esw_dst" ]; then
    cp -p "$_esw_src" "$_esw_dst.tmp.$$" && mv -f "$_esw_dst.tmp.$$" "$_esw_dst" || die "安装启动包装失败: $_esw_dst"
  fi
  [ -f "$_esw_dst" ] || die "缺少启动包装: ${_esw_dst}（安装不完整，请重新部署）"
  chmod 755 "$_esw_dst" 2>/dev/null || true
}

install_management_scripts() {
  _ims_src="$1"
  [ -f "$_ims_src/rsm.sh" ] || die "包内缺少 rsm.sh: $_ims_src"
  mkdir -p "$RSM_HOME/scripts/lib" || die "无法创建 scripts/lib"
  _ims_n=0
  for _ims_f in "$_ims_src"/scripts/lib/*.sh; do
    [ -f "$_ims_f" ] || continue
    _ims_base=$(basename "$_ims_f")
    cp -p "$_ims_f" "$RSM_HOME/scripts/lib/.$_ims_base.tmp.$$" || die "复制脚本失败: $_ims_base"
    chmod 755 "$RSM_HOME/scripts/lib/.$_ims_base.tmp.$$" 2>/dev/null || true
    mv -f "$RSM_HOME/scripts/lib/.$_ims_base.tmp.$$" "$RSM_HOME/scripts/lib/$_ims_base" || die "安装脚本失败: $_ims_base"
    _ims_n=$((_ims_n+1))
  done
  [ "$_ims_n" -gt 0 ] || die "包内 scripts/lib 为空: $_ims_src/scripts/lib"
  cp -p "$_ims_src/rsm.sh" "$RSM_HOME/.rsm.sh.tmp.$$" || die "复制入口失败"
  chmod 755 "$RSM_HOME/.rsm.sh.tmp.$$" 2>/dev/null || true
  mv -f "$RSM_HOME/.rsm.sh.tmp.$$" "$RSM_HOME/rsm.sh" || die "安装入口失败"
  ok "管理入口已更新: $RSM_HOME/rsm.sh"
}

switch_current_link() {
  _scl_target="$1"
  [ -d "$_scl_target" ] || die "目标发布目录不存在: $_scl_target"
  _scl_rel="releases/$(basename "$_scl_target")"
  _scl_link="$(home_current_link)"
  _scl_tmp="$RSM_HOME/.current.tmp.$$"
  rm -f "$_scl_tmp"
  ln -s "$_scl_rel" "$_scl_tmp" || die "创建 current 软链接失败"
  # current 是指向目录的软链接，普通 mv 会把临时链接移入目标目录；macOS 用 -fh，GNU 用 -T。
  _scl_ok=0
  case "$(host_os)" in
    darwin) mv -fh "$_scl_tmp" "$_scl_link" 2>/dev/null && _scl_ok=1 ;;
    *) mv -fT "$_scl_tmp" "$_scl_link" 2>/dev/null && _scl_ok=1 ;;
  esac
  if [ "$_scl_ok" != "1" ]; then
    rm -f "$_scl_link" 2>/dev/null || true
    mv -f "$_scl_tmp" "$_scl_link" || { rm -f "$_scl_tmp"; die "切换 current 失败: $_scl_link"; }
  fi
  _scl_now=$(readlink "$_scl_link" 2>/dev/null || true)
  if [ "$_scl_now" != "$_scl_rel" ]; then
    die "切换 current 后校验失败（期望 ${_scl_rel}，实际 ${_scl_now:-空}）"
  fi
}

check_binary_version() {
  _cbv_v=$(binary_version "$1" 2>/dev/null || true)
  if [ -z "$_cbv_v" ]; then
    die "无法执行程序 --version（${1}）；可能平台不匹配或缺少运行库"
  fi
  if [ -n "${2:-}" ] && [ "$_cbv_v" != "$2" ]; then
    die "程序版本 $_cbv_v 与发行元数据 $2 不一致（发行包可能损坏或被替换）"
  fi
  printf '%s' "$_cbv_v"
}

# ---- 健康检查 ----
# 等待健康：/healthz 返回 200，且 version/schemaVersion 与目标一致（响应缺字段时只要求 200）。
wait_healthy() {
  _wh_want="${1:-}"
  _wh_schema="${2:-0}"
  _wh_timeout="${3:-}"
  if [ -z "$_wh_timeout" ]; then _wh_timeout="${RSM_START_TIMEOUT:-60}"; fi
  _wh_start=$(date +%s)
  _wh_saw_pid=0
  while :; do
    _wh_now=$(date +%s)
    _wh_elapsed=$((_wh_now - _wh_start))
    if instance_pid >/dev/null 2>&1; then
      _wh_saw_pid=1
    else
      if [ "$_wh_saw_pid" = "1" ]; then
        warn "进程已退出（启动失败）"
        return 1
      fi
      if [ "$_wh_elapsed" -ge 5 ]; then
        warn "启动后 5 秒内未写入 run/rsm.pid 或进程未存活"
        return 1
      fi
    fi
    _wh_code=$(http_code "$RSM_ADDR" "$RSM_HEALTH_PATH" 2 2>/dev/null || printf '000')
    if [ "$_wh_code" = "200" ]; then
      _wh_body=$(http_body "$RSM_ADDR" "$RSM_HEALTH_PATH" 2 2>/dev/null || true)
      _wh_ver=$(json_field_from_body "$_wh_body" version)
      _wh_sch=$(json_field_from_body "$_wh_body" schemaVersion)
      if [ -n "$_wh_want" ] && [ -n "$_wh_ver" ] && [ "$_wh_ver" != "$_wh_want" ]; then
        warn "健康检查版本不一致：目标 ${_wh_want}，运行中 $_wh_ver"
        return 1
      fi
      if [ -n "$_wh_sch" ] && [ -n "$_wh_schema" ] && [ "$_wh_schema" != "0" ] && [ "$(to_int "$_wh_sch")" != "$(to_int "$_wh_schema")" ]; then
        warn "健康检查 schemaVersion 不一致：目标 ${_wh_schema}，实际 $_wh_sch"
        return 1
      fi
      return 0
    fi
    if [ "$_wh_elapsed" -ge "$_wh_timeout" ]; then
      warn "等待健康检查超时（$_wh_timeout 秒，最后状态码 ${_wh_code}）"
      return 1
    fi
    sleep 0.5
  done
}

wait_pidfile() {
  _wpfb_secs="${1:-8}"
  _wpfb_i=0
  while [ "$_wpfb_i" -lt $((_wpfb_secs * 2)) ]; do
    if [ -f "$(home_pid_path)" ]; then return 0; fi
    sleep 0.5
    _wpfb_i=$((_wpfb_i+1))
  done
  return 1
}

show_start_failure() {
  warn "启动日志（最后 40 行，$RSM_HOME/logs/rsm.log）:"
  tail_lines "$RSM_HOME/logs/rsm.log" 40 >&2 || warn "（暂无日志文件）"
}

# ---- 启动 ----
start_instance() {
  if instance_running; then
    info "实例已在运行（pid=$(instance_pid)，地址 ${RSM_ADDR}）"
    return 0
  fi
  instance_installed || die "未安装 RSM，无法 start"
  cleanup_stale_pid
  ensure_layout
  persist_addr_if_explicit
  ensure_port_available
  ensure_service_wrapper
  _si_dir=$(current_release_dir) || die "current 软链接无效，请重新部署"
  _si_want=$(release_version_of "$_si_dir")
  _si_schema=$(release_schema_of "$_si_dir")
  [ -n "$_si_want" ] || die "发行元数据缺少 version: $_si_dir/release.json"
  is_uint "$_si_schema" || _si_schema=0
  check_binary_version "$(home_current_binary)" "$_si_want" >/dev/null
  rotate_log "$RSM_HOME/logs/rsm.log" "${RSM_LOG_MAX_BYTES:-10485760}"
  mark_schema_attempt "$_si_schema"
  if autostart_enabled; then
    _si_mode="launchd/systemd"
  else
    _si_mode="background"
  fi
  event_log "start version=$_si_want schema=$_si_schema addr=$RSM_ADDR mode=$_si_mode"
  if autostart_enabled; then
    service_start
  else
    ( cd "$RSM_HOME" || exit 1
      nohup "$(home_wrapper_path)" --home "$RSM_HOME" --addr "$RSM_ADDR" >/dev/null 2>&1 &
    ) || die "启动后台进程失败"
    if ! wait_pidfile 8; then
      show_start_failure
      die "后台进程未写入 run/rsm.pid（启动失败）"
    fi
  fi
  if wait_healthy "$_si_want" "$_si_schema"; then
    mark_schema_confirmed "$_si_schema"
    ST_LAST_STARTED_AT=$(now_iso)
    state_save
    _si_pid=$(instance_pid 2>/dev/null || true)
    ok "已启动 RSM v${_si_want}（pid $(echo "$_si_pid" | sed 's/^$/未知/')，监听 ${RSM_ADDR}）"
    return 0
  fi
  show_start_failure
  stop_instance_quiet
  warn "启动失败；数据与配置均保留，未做任何自动清理"
  return 1
}

# ---- 停止 ----
stop_instance_quiet() {
  _sq_pid=$(instance_pid 2>/dev/null || true)
  if [ -z "$_sq_pid" ]; then
    pid_clear
    if autostart_enabled; then service_stop >/dev/null 2>&1 || true; fi
    return 0
  fi
  if autostart_enabled; then
    service_stop >/dev/null 2>&1 || true
    if service_loaded; then
      warn "服务管理器仍在管理实例，停止失败；为避免自动重启，跳过强制终止"
      pid_clear
      return 1
    fi
  else
    kill -TERM "$_sq_pid" 2>/dev/null || true
  fi
  _sq_wait=0
  while [ "$_sq_wait" -lt 20 ]; do
    if ! pid_alive "$_sq_pid"; then return 0; fi
    sleep 0.5
    _sq_wait=$((_sq_wait+1))
  done
  _pio_home="$RSM_HOME"
  if pid_is_ours "$_sq_pid"; then
    warn "进程 $_sq_pid 未在 20 秒内退出，发送 SIGKILL（已再次校验归属）"
    kill -KILL "$_sq_pid" 2>/dev/null || true
    sleep 1
  fi
  pid_clear
  return 0
}

stop_instance() {
  if ! instance_running; then
    cleanup_stale_pid
    if autostart_enabled; then service_stop; fi
    info "实例未运行（${RSM_HOME}）"
    return 0
  fi
  _so_pid=$(instance_pid) || die "无法确认运行中的实例进程"
  info "停止 RSM（pid=${_so_pid}）…"
  event_log "stop pid=$_so_pid"
  if autostart_enabled; then
    service_stop
    _so_i=0
    while [ "$_so_i" -lt 6 ] && pid_alive "$_so_pid"; do
      sleep 0.5
      _so_i=$((_so_i+1))
    done
    if pid_alive "$_so_pid"; then
      if service_loaded; then
        die "服务管理器仍在管理该实例（pid=${_so_pid}），为避免自动重启循环，已中止停止操作"
      fi
      _pio_home="$RSM_HOME"
      if pid_is_ours "$_so_pid"; then
        warn "自启动服务未接管该进程，经 PID 归属校验后按普通进程停止"
        kill -TERM "$_so_pid" 2>/dev/null || true
      else
        die "进程 $_so_pid 归属不明，拒绝停止"
      fi
    fi
  else
    kill -TERM "$_so_pid" 2>/dev/null || die "向进程 $_so_pid 发送 SIGTERM 失败"
  fi
  _so_timeout="${RSM_STOP_TIMEOUT:-20}"
  _so_wait=0
  while [ "$_so_wait" -lt "$_so_timeout" ]; do
    pid_alive "$_so_pid" || break
    sleep 0.5
    _so_wait=$((_so_wait+1))
  done
  if pid_alive "$_so_pid"; then
    _pio_home="$RSM_HOME"
    if ! pid_is_ours "$_so_pid"; then
      die "进程 $_so_pid 已不再属于本实例，拒绝强制终止（请人工核对）"
    fi
    warn "进程未在 $_so_timeout 秒内退出，再次发送 SIGTERM 并等待 5 秒"
    kill -TERM "$_so_pid" 2>/dev/null || true
    sleep 5
  fi
  if pid_alive "$_so_pid"; then
    _pio_home="$RSM_HOME"
    if pid_is_ours "$_so_pid"; then
      warn "强制终止进程 $_so_pid"
      kill -KILL "$_so_pid" 2>/dev/null || true
      sleep 1
    fi
  fi
  if pid_alive "$_so_pid"; then
    die "无法停止进程 ${_so_pid}；为避免误杀其他进程已中止，请人工检查"
  fi
  pid_clear
  ST_LAST_STOPPED_AT=$(now_iso)
  state_save
  _so_p=0
  while [ "$_so_p" -lt 10 ]; do
    if ! port_open "$(probe_host "$RSM_ADDR")" "$(addr_port "$RSM_ADDR")"; then break; fi
    sleep 0.5
    _so_p=$((_so_p+1))
  done
  ok "已停止（${RSM_HOME}）"
}

restart_instance() {
  stop_instance
  start_instance || die "重启失败"
}

# ---- 信息输出 ----
access_urls() {
  _au_port=$(addr_port "$RSM_ADDR")
  _au_host=$(addr_host "$RSM_ADDR")
  case "$_au_host" in
    ''|0.0.0.0|'*'|'::'|'[::]')
      printf '  本机:   http://127.0.0.1:%s\n' "$_au_port"
      _au_ips=""
      case "$(host_os)" in
        darwin) _au_ips=$(ifconfig -a 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' | sort -u) ;;
        linux) _au_ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | sort -u) ;;
      esac
      for _au_ip in $_au_ips; do
        printf '  局域网: http://%s:%s\n' "$_au_ip" "$_au_port"
      done
      ;;
    *)
      printf '  监听:   http://%s:%s\n' "$_au_host" "$_au_port"
      ;;
  esac
}

latest_backup_path() {
  [ -d "$(home_backups_dir)" ] || return 1
  ls -t "$(home_backups_dir)"/*.tar.gz 2>/dev/null | head -n1
}

print_status() {
  printf '%sRSM 状态%s\n' "$C_BOLD" "$C_RESET"
  printf '安装目录: %s\n' "$RSM_HOME"
  printf '监听地址: %s\n' "${RSM_ADDR:-unknown}"
  if instance_installed; then
    _ps_dir=$(current_release_dir)
    printf '程序版本: %s（%s）\n' "$(release_version_of "$_ps_dir")" "$(basename "$_ps_dir")"
    printf 'schema:   程序支持 %s / 记录确认 %s\n' "$(release_schema_of "$_ps_dir")" "$ST_SCHEMA_VERSION"
  else
    printf '程序版本: 未安装\n'
  fi
  if instance_running; then
    _ps_pid=$(instance_pid)
    _ps_code=$(http_code "$RSM_ADDR" "$RSM_HEALTH_PATH" 2)
    _ps_body=""
    if [ "$_ps_code" = "200" ]; then _ps_body=$(http_body "$RSM_ADDR" "$RSM_HEALTH_PATH" 2 2>/dev/null || true); fi
    printf '运行状态: %s运行中%s（pid=%s）\n' "$C_GREEN" "$C_RESET" "$_ps_pid"
    printf '健康检查: %s %s\n' "$_ps_code" "$_ps_body"
    printf 'PID 文件: %s\n' "$(home_pid_path)"
    access_urls
  else
    printf '运行状态: %s未运行%s\n' "$C_YELLOW" "$C_RESET"
  fi
  _ps_latest=$(latest_backup_path 2>/dev/null || true)
  if [ -n "$_ps_latest" ]; then
    printf '最近备份: %s（%s）\n' "$_ps_latest" "$(human_size "$(file_size "$_ps_latest")")"
  fi
  printf '日志:     %s\n' "$(home_log_path)"
  autostart_status_print
}

logs_path() {
  if [ -f "$(home_log_path)" ]; then printf '%s' "$(home_log_path)"
  elif [ -f "$(home_service_log_path)" ]; then printf '%s' "$(home_service_log_path)"
  else return 1; fi
}

logs_tail() {
  _lt_file=$(logs_path 2>/dev/null) || die "暂无日志文件（$RSM_HOME/logs/）"
  _lt_n="${1:-}"
  if [ -z "$_lt_n" ]; then _lt_n="${RSM_LOG_LINES:-200}"; fi
  info "日志: $_lt_file"
  tail_lines "$_lt_file" "$_lt_n" || die "读取日志失败"
}

logs_follow() {
  _lf_file=$(logs_path 2>/dev/null) || die "暂无日志文件（$RSM_HOME/logs/）"
  _lf_n="${1:-}"
  if [ -z "$_lf_n" ]; then _lf_n="${RSM_LOG_LINES:-200}"; fi
  info "跟踪日志: ${_lf_file}（Ctrl-C 退出）"
  tail -n "$_lf_n" -f "$_lf_file"
}

# 清理旧程序版本目录（仅程序，不触碰数据；保留最近 N 个，默认 5）。
cleanup_old_releases() {
  _cor_keep="${1:-}"
  if [ -z "$_cor_keep" ]; then _cor_keep="${RSM_KEEP_RELEASES:-5}"; fi
  is_uint "$_cor_keep" || return 0
  _cor_current=$(current_release_dir 2>/dev/null || true)
  [ -d "$(home_releases_dir)" ] || return 0
  _cor_tab=$(printf '\t')
  _cor_raw=""
  for _cor_d in "$(home_releases_dir)"/*; do
    [ -d "$_cor_d" ] || continue
    _cor_base=$(basename "$_cor_d")
    if [ "${_cor_base#.}" != "$_cor_base" ]; then continue; fi
    _cor_raw="$_cor_raw$(release_installed_at_of "$_cor_d")$_cor_tab$_cor_d
"
  done
  _cor_n=0
  printf '%s' "$_cor_raw" | sort -rn | while IFS="$_cor_tab" read -r _cor_ts _cor_dir; do
    [ -n "$_cor_dir" ] || continue
    _cor_n=$((_cor_n+1))
    [ "$_cor_n" -le "$_cor_keep" ] && continue
    [ "$_cor_dir" = "$_cor_current" ] && continue
    info "清理旧程序版本: $(basename "$_cor_dir")"
    rm -rf "$_cor_dir"
  done
}
