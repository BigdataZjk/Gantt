#!/usr/bin/env bash
# 自启动：macOS 用户级 launchd；Linux root 使用系统级 systemd，普通用户使用 --user。
# 一律以前台方式运行 scripts/lib/service-run.sh；启用自启动后 start/stop 必须走服务管理器，
# 避免 launchd/systemd 的 KeepAlive/Restart 与手工 kill 互相冲突。

SERVICE_UID=$(id -u)
HOST_USER_HOME=$(user_home)

service_hash() { short_hash "$RSM_HOME"; }
mac_label() { printf 'com.rsm.service.%s' "$(service_hash)"; }
mac_plist_path() { printf '%s/Library/LaunchAgents/%s.plist' "$HOST_USER_HOME" "$(mac_label)"; }
linux_unit_name() { printf 'rsm-%s.service' "$(service_hash)"; }
linux_system_service() { [ "$SERVICE_UID" = "0" ]; }
linux_systemctl() {
  if linux_system_service; then systemctl "$@"
  else systemctl --user "$@"; fi
}
linux_unit_dir() {
  if linux_system_service; then printf '/etc/systemd/system'
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then printf '%s/systemd/user' "$XDG_CONFIG_HOME"
  else printf '%s/.config/systemd/user' "$HOST_USER_HOME"; fi
}
linux_unit_path() { printf '%s/%s' "$(linux_unit_dir)" "$(linux_unit_name)"; }

autostart_enabled() {
  case "$(host_os)" in
    darwin) [ -f "$(mac_plist_path)" ] ;;
    linux) [ -f "$(linux_unit_path)" ] ;;
    *) return 1 ;;
  esac
}

service_loaded() {
  case "$(host_os)" in
    darwin) launchctl print "gui/$SERVICE_UID/$(mac_label)" >/dev/null 2>&1 ;;
    linux) linux_systemctl is-active --quiet "$(linux_unit_name)" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

write_plist() {
  _wp_plist="$(mac_plist_path)"
  _wp_wrapper="$RSM_HOME/scripts/lib/service-run.sh"
  _wp_log="$RSM_HOME/logs/service.log"
  mkdir -p "$(dirname "$_wp_plist")" || return 1
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "$(mac_label)")"
    printf '  <key>ProgramArguments</key>\n  <array>\n'
    printf '    <string>%s</string>\n' "$(xml_escape "$_wp_wrapper")"
    printf '    <string>--home</string>\n    <string>%s</string>\n' "$(xml_escape "$RSM_HOME")"
    printf '    <string>--addr</string>\n    <string>%s</string>\n' "$(xml_escape "$RSM_ADDR")"
    printf '  </array>\n'
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$RSM_HOME")"
    printf '  <key>RunAtLoad</key><true/>\n'
    printf '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key><false/>\n  </dict>\n'
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$_wp_log")"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$_wp_log")"
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } | atomic_write "$_wp_plist" 600
}

write_unit() {
  _wu_unit="$(linux_unit_path)"
  _wu_wrapper="$RSM_HOME/scripts/lib/service-run.sh"
  _wu_home_esc=$(systemd_escape "$RSM_HOME")
  _wu_exec_home_esc=$(systemd_exec_escape "$RSM_HOME")
  _wu_addr_esc=$(systemd_exec_escape "$RSM_ADDR")
  _wu_wrapper_esc=$(systemd_exec_escape "$_wu_wrapper")
  mkdir -p "$(dirname "$_wu_unit")" || return 1
  {
    printf '[Unit]\n'
    printf 'Description=RSM Request Schedule Manager\n'
    printf 'After=network.target\n\n'
    printf '[Service]\n'
    printf 'Type=simple\n'
    printf 'WorkingDirectory="%s"\n' "$_wu_home_esc"
    printf 'ExecStart="%s" --home "%s" --addr "%s"\n' "$_wu_wrapper_esc" "$_wu_exec_home_esc" "$_wu_addr_esc"
    printf 'Restart=on-failure\n'
    printf 'RestartSec=3\n'
    printf 'UMask=0077\n'
    printf 'KillMode=mixed\n\n'
    printf '[Install]\n'
    if linux_system_service; then printf 'WantedBy=multi-user.target\n'
    else printf 'WantedBy=default.target\n'; fi
  } | atomic_write "$_wu_unit" 644
}

systemd_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

systemd_exec_escape() { systemd_escape "$1" | sed 's/\$/$$/g'; }

linux_require_manager() {
  have_cmd systemctl || die "未安装 systemd，无法启用开机自启动；当前后台服务保持不变"
  linux_systemctl show-environment >/dev/null 2>&1 && return 0
  if linux_system_service; then
    die "系统级 systemd 不可用（精简容器可能未以 systemd 为 PID 1）；当前后台服务保持不变，请在宿主机启用自启动"
  fi
  die "用户级 systemd 不可用；请按服务器策略启用用户服务或 loginctl enable-linger 后重试，当前后台服务保持不变"
}

mac_bootstrap() {
  _mb_plist="$(mac_plist_path)"
  _mb_label="$(mac_label)"
  launchctl print "gui/$SERVICE_UID/$_mb_label" >/dev/null 2>&1 && return 0
  # 之前被 disable 过的 label 需先 enable，否则 bootstrap 会失败
  launchctl enable "gui/$SERVICE_UID/$_mb_label" 2>/dev/null || true
  launchctl bootstrap "gui/$SERVICE_UID" "$_mb_plist" 2>/dev/null && return 0
  launchctl load -w "$_mb_plist" 2>/dev/null && return 0
  return 1
}

mac_bootout() {
  _mo_label=$(mac_label)
  launchctl bootout "gui/$SERVICE_UID/$_mo_label" 2>/dev/null && return 0
  _mo_plist="$(mac_plist_path)"
  if [ -f "$_mo_plist" ]; then launchctl unload -w "$_mo_plist" 2>/dev/null && return 0; fi
  launchctl print "gui/$SERVICE_UID/$_mo_label" >/dev/null 2>&1 && return 1
  return 0
}

service_start() {
  case "$(host_os)" in
    darwin)
      write_plist || die "更新 launchd 配置失败"
      mac_bootstrap || die "launchd 启动自启动服务失败（plist: $(mac_plist_path)）"
      if ! launchctl kickstart -k "gui/$SERVICE_UID/$(mac_label)" 2>/dev/null; then
        launchctl start "$(mac_label)" 2>/dev/null || true
      fi
      ;;
    linux)
      write_unit || die "更新 systemd 配置失败"
      linux_systemctl daemon-reload || die "systemd 重载失败"
      linux_systemctl start "$(linux_unit_name)" || die "systemd 启动失败，请检查服务日志"
      ;;
    *) die "不支持的自启动平台: $(host_os)" ;;
  esac
}

service_stop() {
  if autostart_enabled; then
    case "$(host_os)" in
      darwin) mac_bootout || die "无法停止 launchd 服务，已中止以避免残留实例" ;;
      linux) linux_systemctl stop "$(linux_unit_name)" || die "无法停止 systemd 服务，已中止以避免残留实例" ;;
      *) die "不支持的自启动平台: $(host_os)" ;;
    esac
  fi
}

service_install_and_start() {
  if [ "$(host_os)" = "linux" ]; then linux_require_manager; fi
  ensure_layout
  ensure_service_wrapper
  rotate_log "$RSM_HOME/logs/service.log" 5242880
  case "$(host_os)" in
    darwin)
      write_plist || die "写入 launchd plist 失败"
      if have_cmd plutil; then plutil -lint "$(mac_plist_path)" >/dev/null 2>&1 || die "launchd plist 校验失败"; fi
      ;;
    linux)
      write_unit || die "写入 systemd unit 失败"
      linux_systemctl daemon-reload || die "systemd 重载失败，请确认服务管理器可用"
      linux_systemctl enable "$(linux_unit_name)" || die "启用 systemd 开机自启动失败"
      ;;
    *) die "不支持的自启动平台: $(host_os)" ;;
  esac
  info "已生成自启动配置: $(autostart_config_path)"
  if instance_running; then stop_instance; fi
  service_start
  if wait_healthy "" ""; then
    if [ "$(host_os)" = "linux" ] && linux_system_service; then
      ok "开机自启动已启用且服务健康（系统级，无需用户登录）"
    else
      ok "自启动已启用且服务健康（用户级，Linux 无登录运行需启用 linger）"
    fi
  else
    die "自启动配置已生成，但服务未通过健康检查；请查看 $(home_log_path) 与系统服务日志"
  fi
}

service_remove() {
  if autostart_enabled; then
    if instance_running; then stop_instance; fi
    case "$(host_os)" in
      darwin)
        launchctl bootout "gui/$SERVICE_UID/$(mac_label)" >/dev/null 2>&1 || true
        launchctl disable "gui/$SERVICE_UID/$(mac_label)" >/dev/null 2>&1 || true
        rm -f "$(mac_plist_path)" ;;
      linux)
        linux_systemctl disable --now "$(linux_unit_name)" || die "关闭 systemd 自启动失败，配置已保留"
        rm -f "$(linux_unit_path)" || die "删除 systemd 配置失败"
        linux_systemctl daemon-reload || die "systemd 重载失败" ;;
    esac
    ok "自启动已关闭（服务已停止，配置已删除）"
  else
    info "自启动未启用"
  fi
}

autostart_config_path() {
  case "$(host_os)" in
    darwin) mac_plist_path ;;
    linux) linux_unit_path ;;
    *) printf '' ;;
  esac
}

autostart_status_print() {
  printf '自启动: '
  if autostart_enabled; then
    printf '已启用\n'
    printf '  配置文件: %s\n' "$(autostart_config_path)"
    case "$(host_os)" in
      darwin) printf '  服务管理器: launchd（用户级）\n' ;;
      linux)
        if linux_system_service; then printf '  服务管理器: systemd（系统级）\n'
        else printf '  服务管理器: systemd --user\n'; fi
        if ! linux_systemctl is-enabled --quiet "$(linux_unit_name)" >/dev/null 2>&1; then
          printf '  注意: 配置存在但未启用，执行 autostart enable 重试\n'
        fi ;;
    esac
  else
    printf '未启用（当前为普通后台运行）\n'
  fi
}
