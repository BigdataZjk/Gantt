#!/usr/bin/env bash
# RSM 唯一用户入口。
#   ./rsm.sh                         首次安装；已安装时检查 upgrade/ 中包内版本并自动升级/启动
#   ./rsm.sh start|stop|restart|status|logs
#   ./rsm.sh upgrade [源码ZIP或发行包] | rollback [版本]
#   ./rsm.sh backup [--output FILE] | restore <备份> [--yes] | verify-backup <备份>
#   ./rsm.sh autostart enable|disable|status
# 环境变量：RSM_HOME（默认脚本所在目录）、RSM_ADDR（默认 0.0.0.0:1111）、RSM_ASSUME_YES=1、RSM_FORCE=1 等。
set -u
set -o pipefail
umask 077

RSM_SH_VERSION="1.0.0"

# ---- 解析脚本所在目录（允许软链接）----
_self="$0"
while [ -L "$_self" ]; do
  _self_dir=$(cd "$(dirname "$_self")" 2>/dev/null && pwd -P) || break
  _self_target=$(readlink "$_self" 2>/dev/null) || break
  case "$_self_target" in
    /*) _self="$_self_target" ;;
    *) _self="$_self_dir/$_self_target" ;;
  esac
done
SCRIPT_DIR=$(cd "$(dirname "$_self")" 2>/dev/null && pwd -P) || { printf '无法定位脚本目录: %s\n' "$0" >&2; exit 1; }
RSM_ROOT="$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/scripts/lib/common.sh" ]; then
  printf '错误: 缺少 scripts/lib（安装或仓库不完整）: %s\n' "$SCRIPT_DIR" >&2
  exit 1
fi

# ---- 运行模式 ----
if [ -f "$SCRIPT_DIR/go.mod" ] && [ -d "$SCRIPT_DIR/api" ]; then
  RSM_MODE="source"
elif [ -f "$SCRIPT_DIR/release.json" ] && [ -x "$SCRIPT_DIR/rsm" ]; then
  RSM_MODE="package"
elif [ -f "$SCRIPT_DIR/config.json" ] || [ -d "$SCRIPT_DIR/releases" ] || [ -d "$SCRIPT_DIR/run" ]; then
  RSM_MODE="installed"
else
  RSM_MODE="unknown"
fi
export RSM_MODE

# ---- 加载函数库 ----
. "$SCRIPT_DIR/scripts/lib/common.sh"
. "$SCRIPT_DIR/scripts/lib/toolchain.sh"
. "$SCRIPT_DIR/scripts/lib/lock.sh"
. "$SCRIPT_DIR/scripts/lib/instance.sh"
. "$SCRIPT_DIR/scripts/lib/service.sh"
. "$SCRIPT_DIR/scripts/lib/release.sh"
. "$SCRIPT_DIR/scripts/lib/source.sh"
. "$SCRIPT_DIR/scripts/lib/backup.sh"

# ---- 参数解析 ----
CMD=""
ARGS=()
LOG_FOLLOW=0
BACKUP_OUT=""
RSM_LOG_LINES_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) [ "$#" -ge 2 ] || die "--home 缺少取值"; RSM_HOME_ARG="$2"; shift 2 ;;
    --home=*) RSM_HOME_ARG="${1#*=}"; shift ;;
    --addr) [ "$#" -ge 2 ] || die "--addr 缺少取值"; RSM_ADDR_ARG="$2"; shift 2 ;;
    --addr=*) RSM_ADDR_ARG="${1#*=}"; shift ;;
    --yes|-y) RSM_ASSUME_YES=1; shift ;;
    --force) RSM_FORCE=1; export RSM_FORCE; shift ;;
    --follow|-f) LOG_FOLLOW=1; shift ;;
    --lines|-n) [ "$#" -ge 2 ] || die "--lines/-n 缺少取值"; RSM_LOG_LINES_ARG="$2"; shift 2 ;;
    --lines=*) RSM_LOG_LINES_ARG="${1#*=}"; shift ;;
    --output|-o) [ "$#" -ge 2 ] || die "--output 缺少取值"; BACKUP_OUT="$2"; shift 2 ;;
    --output=*) BACKUP_OUT="${1#*=}"; shift ;;
    --version) CMD="version"; shift ;;
    --help|-h) CMD="help"; shift ;;
    --*) die "未知参数: ${1}（可运行 ./rsm.sh --help 查看用法）" ;;
    *)
      if [ -z "$CMD" ]; then
        CMD="$1"
      else
        ARGS[${#ARGS[@]}]="$1"
      fi
      shift ;;
  esac
done

if [ -n "$RSM_LOG_LINES_ARG" ]; then RSM_LOG_LINES="$RSM_LOG_LINES_ARG"; else RSM_LOG_LINES=200; fi
BACKUP_ARG_OUT="$BACKUP_OUT"
# 环境变量作为默认值（命令行 --home/--addr 优先）
if [ -z "${RSM_HOME_ARG:-}" ]; then RSM_HOME_ARG="${RSM_HOME:-}"; fi
if [ -z "${RSM_ADDR_ARG:-}" ]; then RSM_ADDR_ARG="${RSM_ADDR:-}"; fi
RSM_ADDR_REQUESTED="${RSM_ADDR_ARG:-}"
RSM_ASSUME_YES="${RSM_ASSUME_YES:-0}"
export RSM_ASSUME_YES

cmd_first_arg() { printf '%s' "${ARGS[0]:-}"; }

on_exit() {
  progress_stop
  lock_release_all >/dev/null 2>&1 || true
  package_cleanup >/dev/null 2>&1 || true
  source_cleanup >/dev/null 2>&1 || true
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

print_usage() {
  cat <<USAGE
RSM Request Schedule Manager 一键部署与管理入口（$(os_pretty) $(host_arch)）

用法:
  ./rsm.sh                              首次安装；已安装时检查 upgrade/ 中包内版本并自动升级/启动
  ./rsm.sh start|stop|restart|status   实例启停与状态
  ./rsm.sh logs [--follow] [-n N]      查看运行日志
  ./rsm.sh upgrade [包路径]            选择 upgrade/ 中包内版本最高的 ZIP，也可指定源码 ZIP / 发行包
  ./rsm.sh rollback [版本] [--force]   仅回退程序；检查数据库 schema 兼容
  ./rsm.sh backup [--output FILE]      创建一致性备份（默认 backups/rsm-<时间>.tar.gz）
  ./rsm.sh restore <备份> [--yes]      显式恢复备份（先备份现状、停服后恢复、启动并核对）
  ./rsm.sh verify-backup <备份>        校验备份完整性
  ./rsm.sh autostart enable|disable|status
  ./rsm.sh releases                    列出已安装程序版本
  ./rsm.sh version                     版本信息

环境变量:
  RSM_HOME   安装目录（默认此入口脚本所在目录；也可 --home 指定）
  RSM_ADDR   监听地址（默认 0.0.0.0:1111；也可 --addr 指定）
  RSM_ASSUME_YES=1  非交互确认（危险操作建议仍显式 --yes）
  RSM_FORCE=1       强制同版本重装（upgrade --force）或忽略 schema 检查（rollback --force）
  RSM_VERBOSE=1     实时展开依赖下载与构建详情（默认收起，详情保存在部署日志）
  RSM_START_TIMEOUT / RSM_STOP_TIMEOUT / RSM_KEEP_RELEASES / RSM_LOG_LINES 等见脚本内注释
USAGE
}

version_cmd() {
  printf 'rsm.sh %s\n' "$RSM_SH_VERSION"
  printf '系统: %s %s\n' "$(os_pretty)" "$(host_arch)"
  case "$RSM_MODE" in
    source) printf '模式: 源码仓库 %s\n' "$RSM_ROOT" ;;
    package) printf '模式: 发行包 %s\n' "$RSM_ROOT" ;;
    installed) printf '模式: 已安装实例 %s\n' "$RSM_ROOT" ;;
    *) printf '模式: 未知目录 %s\n' "$RSM_ROOT" ;;
  esac
  if looks_like_installed_home "$RSM_ROOT"; then
    RSM_HOME="$RSM_ROOT"; RSM_HOME_EXPLICIT=0
    if instance_installed; then printf '已安装版本: %s\n' "$(installed_version)"; fi
  fi
}

prepare_context() {
  resolve_home
  export RSM_HOME
  state_load
  if [ -d "$RSM_HOME/logs" ]; then RSM_LOG_FILE="$RSM_HOME/logs/rsm.sh.log"; export RSM_LOG_FILE; fi
  resolve_addr
}

require_mode_for_install() {
  case "$RSM_MODE" in
    source|package|installed) return 0 ;;
    *) die "当前目录既不是 RSM 源码仓库、发行包，也不是已安装实例: $RSM_ROOT" ;;
  esac
}

lock_instance() {
  ensure_dir "$RSM_HOME/run" || die "无法创建 run 目录: $RSM_HOME/run"
  lock_acquire "$RSM_HOME/run/lock" "rsm.sh $CMD"
}

case "$CMD" in
  ""|deploy)
    require_mode_for_install
    prepare_context
    lock_instance
    ensure_layout
    init_task_log "$RSM_HOME/logs/deploy-details.log"
    step "RSM 部署（模式: ${RSM_MODE}，目标: ${RSM_HOME}，监听: ${RSM_ADDR}）"
    info "详细日志默认收起，完整记录: ${RSM_LOG_FILE}（RSM_VERBOSE=1 可实时展开）"
    deploy_cmd
    ;;

  start)
    prepare_context
    require_installed
    lock_instance
    ensure_layout
    start_instance || die "启动失败"
    print_status
    ;;

  stop)
    prepare_context
    if ! looks_like_installed_home "$RSM_HOME"; then
      die "未安装 RSM（${RSM_HOME}）"
    fi
    lock_instance
    ensure_layout
    stop_instance
    ;;

  restart)
    prepare_context
    require_installed
    lock_instance
    ensure_layout
    restart_instance
    print_status
    ;;

  status)
    prepare_context
    if ! instance_installed; then
      printf 'RSM 未安装（%s）\n' "$RSM_HOME"
      exit 4
    fi
    print_status
    if instance_running; then
      _st_code=$(http_code "$RSM_ADDR" "$RSM_HEALTH_PATH" 2)
      if [ "$_st_code" = "200" ]; then exit 0; else exit 1; fi
    fi
    exit 3
    ;;

  logs)
    prepare_context
    require_installed
    _logs_arg="${ARGS[0]:-}"
    if [ -n "$_logs_arg" ]; then
      case "$_logs_arg" in
        ''|*[!0-9]*) die "logs 的行数必须是数字（例如 ./rsm.sh logs -n 100 或 ./rsm.sh logs 100）" ;;
        *) RSM_LOG_LINES="$_logs_arg" ;;
      esac
    fi
    if [ "$LOG_FOLLOW" = "1" ]; then
      logs_follow "$RSM_LOG_LINES"
    else
      logs_tail "$RSM_LOG_LINES"
    fi
    ;;

  upgrade)
    _up_pkg=$(cmd_first_arg)
    [ "${#ARGS[@]}" -le 1 ] || die "用法: ./rsm.sh upgrade [源码.zip|发行包.tar.gz|发行包目录]"
    prepare_context
    lock_instance
    ensure_layout
    init_task_log "$RSM_HOME/logs/deploy-details.log"
    step "RSM 安装/升级（目标: ${RSM_HOME}，监听: ${RSM_ADDR}）"
    info "详细日志默认收起，完整记录: ${RSM_LOG_FILE}（RSM_VERBOSE=1 可实时展开）"
    upgrade_cmd "$_up_pkg"
    ;;

  rollback)
    _rb_arg=$(cmd_first_arg)
    prepare_context
    require_installed
    lock_instance
    ensure_layout
    rollback_cmd "$_rb_arg"
    ;;

  backup)
    _bk_out="$BACKUP_ARG_OUT"
    if [ -z "$_bk_out" ]; then _bk_out=$(cmd_first_arg); fi
    prepare_context
    require_installed
    lock_instance
    ensure_layout
    backup_cmd "$_bk_out"
    ;;

  verify-backup|verify_backup)
    _vb_file=$(cmd_first_arg)
    [ -n "$_vb_file" ] || die "用法: ./rsm.sh verify-backup <备份文件>"
    prepare_context
    verify_backup_cmd "$_vb_file"
    ;;

  restore)
    _rs_file=$(cmd_first_arg)
    [ -n "$_rs_file" ] || die "用法: ./rsm.sh restore <备份文件> [--yes]"
    prepare_context
    require_installed
    lock_instance
    ensure_layout
    restore_cmd "$_rs_file"
    ;;

  autostart)
    _as_sub=$(cmd_first_arg)
    prepare_context
    require_installed
    lock_instance
    ensure_layout
    case "$_as_sub" in
      enable) service_install_and_start ;;
      disable) service_remove ;;
      status) autostart_status_print ;;
      *) die "用法: ./rsm.sh autostart enable|disable|status" ;;
    esac
    ;;

  releases)
    prepare_context
    if ! looks_like_installed_home "$RSM_HOME"; then printf 'RSM 未安装（%s）\n' "$RSM_HOME"; exit 4; fi
    list_releases
    ;;

  version)
    version_cmd
    ;;

  help|usage)
    print_usage
    ;;

  *)
    print_usage >&2
    die "未知命令: $CMD"
    ;;
esac
