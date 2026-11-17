#!/usr/bin/env bash

supervisor_name() { printf 'rsm-%s' "$(service_hash)"; }
supervisor_marker() { printf '%s/run/supervisor-config' "$RSM_HOME"; }

linux_service_backend() {
  if [ -f "$(supervisor_marker)" ] || [ -n "${RSM_SUPERVISOR_CONFIG:-}" ]; then
    printf supervisor
  elif [ -f "$(linux_unit_path)" ]; then
    printf systemd
  elif [ "$(cat /proc/1/comm 2>/dev/null)" = supervisord ]; then
    printf supervisor
  else
    printf systemd
  fi
}

# Resolve the running daemon's configuration before selecting an included file.
supervisor_config_info() {
  python3 - "$1" "$(supervisor_name)" <<'PY'
import configparser
import fnmatch
import os
import pathlib
import subprocess
import sys

hint, name = sys.argv[1:]

def fail(message):
    sys.exit("错误: " + message)

def controller_pid(config=None):
    args = ["supervisorctl"]
    if config:
        args += ["-c", config]
    try:
        result = subprocess.run(args + ["pid"], capture_output=True, text=True, timeout=10)
        value = result.stdout.strip()
        if result.returncode == 0 and value.isdecimal() and int(value) > 0:
            return int(value)
    except (OSError, subprocess.TimeoutExpired):
        pass
    fail("无法连接现有 Supervisor 控制接口；当前服务保持不变")

pid = controller_pid(hint or None)
if not hint and pathlib.Path("/proc/1/comm").is_file():
    if pathlib.Path("/proc/1/comm").read_text().strip() == "supervisord" and pid != 1:
        fail("默认控制接口没有指向 PID 1 的 Supervisor，拒绝接管")
config = hint
proc = pathlib.Path("/proc") / str(pid)
if proc.exists():
    try:
        argv = (proc / "cmdline").read_bytes().rstrip(b"\0").decode().split("\0")
        cwd = str((proc / "cwd").resolve(strict=True))
    except (OSError, UnicodeError):
        fail("无法核实 Supervisor 进程配置；当前服务保持不变")
    script = next((arg for arg in argv if os.path.basename(arg) == "supervisord"), None)
    if not script:
        fail("控制接口未指向可确认的 supervisord 进程")
    actual = None
    for index, arg in enumerate(argv):
        if arg in ("-c", "--configuration") and index + 1 < len(argv):
            actual = argv[index + 1]
            break
        if arg.startswith("--configuration="):
            actual = arg.split("=", 1)[1]
            break
        if arg.startswith("-c") and len(arg) > 2:
            actual = arg[2:]
            break
    if actual is None:
        here = os.path.dirname(os.path.dirname(script))
        candidates = [os.path.join(here, "etc/supervisord.conf"),
                      os.path.join(here, "supervisord.conf"), "supervisord.conf",
                      "etc/supervisord.conf", "/etc/supervisord.conf",
                      "/etc/supervisor/supervisord.conf"]
        actual = next((os.path.join(cwd, p) for p in candidates if os.path.isfile(os.path.join(cwd, p))), None)
    if actual is None:
        fail("无法确定 Supervisor 实际加载的配置，请显式设置 RSM_SUPERVISOR_CONFIG")
    actual = os.path.realpath(os.path.join(cwd, actual))
    if config and os.path.realpath(config) != actual:
        fail("指定的配置与运行中 Supervisor 的配置不一致")
    config = actual
elif not config:
    fail("无法读取 Supervisor 进程信息，请显式设置 RSM_SUPERVISOR_CONFIG")

config = os.path.realpath(config)
if controller_pid(config) != pid:
    fail("Supervisor 配置连接到了不同进程，拒绝继续")
parser = configparser.RawConfigParser(inline_comment_prefixes=(";", "#"))
try:
    with open(config, encoding="utf-8") as source:
        parser.read_file(source)
    includes = parser.get("include", "files")
except (OSError, configparser.Error):
    fail("Supervisor 配置没有可用的 include files，未修改主配置")
expansions = {"here": os.path.dirname(config)}
try:
    environ = (proc / "environ").read_bytes().split(b"\0") if proc.exists() else []
    for item in environ:
        if b"=" in item:
            key, value = item.decode().split("=", 1)
            expansions["ENV_" + key] = value
    includes = includes % expansions
except (OSError, UnicodeError, KeyError, ValueError):
    fail("无法安全解析 Supervisor include 配置")
target = None
for pattern in includes.split():
    pattern = os.path.join(os.path.dirname(config), pattern)
    parent, glob = os.path.split(pattern)
    if any(char in parent for char in "*?["):
        continue
    if fnmatch.fnmatchcase(name + ".conf", glob) and os.path.isdir(parent) and os.access(parent, os.W_OK):
        target = os.path.join(os.path.realpath(parent), name + ".conf")
        break
if not target:
    fail("Supervisor 没有可写的独立配置加载目录；未修改其他配置")
if any(char in config + target for char in "\r\n"):
    fail("Supervisor 配置路径含非法换行")
print(config)
print(target)
PY
}

supervisor_bind() {
  if [ -n "${SUPERVISOR_MAIN_CONFIG:-}" ]; then return 0; fi
  have_cmd supervisorctl || die "未安装 supervisorctl；当前服务保持不变"
  have_cmd python3 || die "Supervisor 适配需要现有 Python 3；当前服务保持不变"
  local hint="${RSM_SUPERVISOR_CONFIG:-}" info stored
  if [ -f "$(supervisor_marker)" ]; then
    stored=$(sed -n '1p' "$(supervisor_marker)")
    if [ -n "$hint" ] && [ "$hint" != "$stored" ]; then die "Supervisor 配置与本实例注册记录不一致"; fi
    hint="$stored"
  fi
  info=$(supervisor_config_info "$hint") || die "Supervisor 配置核实失败；当前服务保持不变"
  SUPERVISOR_MAIN_CONFIG=$(printf '%s\n' "$info" | sed -n '1p')
  SUPERVISOR_PROGRAM_CONFIG=$(printf '%s\n' "$info" | sed -n '2p')
  [ -n "$SUPERVISOR_MAIN_CONFIG" ] && [ -n "$SUPERVISOR_PROGRAM_CONFIG" ] || die "Supervisor 配置解析失败"
  if [ -f "$(supervisor_marker)" ]; then
    [ "$(sed -n '2p' "$(supervisor_marker)")" = "$SUPERVISOR_PROGRAM_CONFIG" ] || die "Supervisor 加载目录已变化，请先核对原注册配置"
  fi
}

supervisor_ctl() {
  case "${1:-}" in
    reread) [ "$#" -eq 1 ] || return 1 ;;
    update|start|stop|remove|status|pid) [ "$#" -eq 2 ] && [ "$2" = "$(supervisor_name)" ] || return 1 ;;
    *) return 1 ;;
  esac
  supervisorctl -c "$SUPERVISOR_MAIN_CONFIG" "$@"
}

supervisor_state() {
  local output
  output=$(supervisor_ctl status "$(supervisor_name)" 2>/dev/null) || true
  printf '%s\n' "$output" | awk -v name="$(supervisor_name)" '$1 == name {print $2}'
}

supervisor_loaded() {
  supervisor_bind
  case "$(supervisor_state)" in RUNNING|STARTING|BACKOFF|STOPPING) return 0 ;; *) return 1 ;; esac
}

supervisor_wait_healthy() {
  wait_healthy "$(installed_version)" "$(release_schema_of "$(current_release_dir)")" || return 1
  [ "$(supervisor_ctl pid "$(supervisor_name)")" = "$(instance_pid)" ]
}

supervisor_owned_config() {
  [ ! -L "$SUPERVISOR_PROGRAM_CONFIG" ] && [ -f "$SUPERVISOR_PROGRAM_CONFIG" ] &&
    [ "$(head -n 1 "$SUPERVISOR_PROGRAM_CONFIG")" = "# RSM managed home: $RSM_HOME" ]
}

supervisor_write_config() {
  if [ -e "$SUPERVISOR_PROGRAM_CONFIG" ] || [ -L "$SUPERVISOR_PROGRAM_CONFIG" ]; then
    supervisor_owned_config || die "Supervisor 目标配置不属于本实例，拒绝覆盖"
  fi
  local config
  config=$(python3 - "$RSM_HOME" "$RSM_ADDR" "$(supervisor_name)" <<'PY'
import shlex
import sys

home, addr, name = sys.argv[1:]
if any(char in home + addr for char in "\r\n;#"):
    sys.exit("错误: Supervisor 不支持此实例路径或地址中的换行、分号、井号")
def escape(value):
    return value.replace("%", "%%")
command = " ".join(shlex.quote(value) for value in [home + "/scripts/lib/service-run.sh", "--home", home, "--addr", addr])
print("# RSM managed home: " + home)
print("[program:" + name + "]")
print("command=" + escape(command))
print("directory=" + escape(home))
print("autostart=true\nautorestart=unexpected\nexitcodes=0\nstartsecs=1\nstartretries=3")
print("stopsignal=TERM\nstopwaitsecs=20\nstopasgroup=true\nkillasgroup=true\numask=0077")
print("redirect_stderr=true\nstdout_logfile=" + escape(escape(home + "/logs/service.log")))
print("stdout_logfile_maxbytes=5MB\nstdout_logfile_backups=1")
PY
  ) || return 1
  printf '%s\n' "$config" | atomic_write "$SUPERVISOR_PROGRAM_CONFIG" 600
}

supervisor_start() {
  supervisor_bind
  supervisor_write_config || die "写入 RSM Supervisor 配置失败"
  supervisor_ctl reread || die "Supervisor 配置校验失败，未更新进程组"
  supervisor_ctl update "$(supervisor_name)" || die "更新 RSM 进程组失败"
  case "$(supervisor_state)" in
    RUNNING|STARTING) return 0 ;;
    *) supervisor_ctl start "$(supervisor_name)" || die "Supervisor 启动 RSM 失败" ;;
  esac
}

supervisor_stop() {
  supervisor_bind
  case "$(supervisor_state)" in
    STOPPED|EXITED|FATAL) return 0 ;;
    '') die "找不到本实例的 Supervisor 进程组，拒绝继续停止操作" ;;
    *) supervisor_ctl stop "$(supervisor_name)" || die "停止 RSM Supervisor 进程组失败" ;;
  esac
}

supervisor_install_and_start() {
  supervisor_bind
  if [ -f "$(supervisor_marker)" ]; then
    supervisor_start
    supervisor_wait_healthy || die "RSM 未通过健康或托管进程检查，请查看 $(home_log_path)"
    ok "Supervisor 自启动已启用，RSM 服务健康"
    return 0
  fi
  [ -z "$(supervisor_state)" ] || die "同名 Supervisor 进程组已存在且没有本实例注册记录，拒绝接管"
  [ ! -e "$SUPERVISOR_PROGRAM_CONFIG" ] && [ ! -L "$SUPERVISOR_PROGRAM_CONFIG" ] || die "Supervisor 同名配置已存在，拒绝覆盖"
  ensure_layout
  ensure_service_wrapper
  rotate_log "$RSM_HOME/logs/service.log" 5242880
  supervisor_write_config || die "写入 RSM Supervisor 配置失败"
  local result was_running=0
  if result=$(supervisor_ctl reread 2>&1) && printf '%s\n' "$result" | grep -Fxq "$(supervisor_name): available"; then
    info "RSM 独立配置已通过 Supervisor 校验"
  else
    rm -f "$SUPERVISOR_PROGRAM_CONFIG"
    supervisor_ctl reread >/dev/null 2>&1 || true
    die "Supervisor 未识别 RSM 独立配置，当前进程保持不变: $result"
  fi
  if instance_running; then was_running=1; stop_instance
  else ensure_port_available; fi
  if ! {
    printf '%s\n' "$SUPERVISOR_MAIN_CONFIG"
    printf '%s\n' "$SUPERVISOR_PROGRAM_CONFIG"
  } | atomic_write "$(supervisor_marker)" 600; then
    rm -f "$SUPERVISOR_PROGRAM_CONFIG"
    supervisor_ctl reread >/dev/null 2>&1 || true
    if [ "$was_running" = 1 ]; then start_instance || true; fi
    die "保存 Supervisor 注册记录失败，未接管 RSM"
  fi
  if supervisor_ctl update "$(supervisor_name)" && supervisor_wait_healthy; then
    ok "Supervisor 自启动已启用，RSM 服务健康（进程组: $(supervisor_name)）"
    return 0
  fi
  warn "Supervisor 接管失败，恢复原后台运行方式"
  if supervisor_loaded; then supervisor_stop; fi
  if [ -n "$(supervisor_state)" ]; then supervisor_ctl remove "$(supervisor_name)" || die "无法移除失败的 RSM 进程组，请先检查状态"; fi
  rm -f "$SUPERVISOR_PROGRAM_CONFIG"
  supervisor_ctl reread >/dev/null 2>&1 || true
  rm -f "$(supervisor_marker)"
  if [ "$was_running" = 1 ]; then start_instance || die "RSM 恢复后台启动失败，请查看 $(home_log_path)"; fi
  die "Supervisor 接管失败；未修改其他服务"
}

supervisor_remove() {
  supervisor_bind
  supervisor_owned_config || die "Supervisor 配置归属不符，拒绝删除"
  stop_instance
  supervisor_ctl remove "$(supervisor_name)" || die "移除 RSM 进程组失败，配置已保留"
  rm -f "$SUPERVISOR_PROGRAM_CONFIG" || die "删除 RSM 独立配置失败"
  supervisor_ctl reread || die "RSM 已停止并移除，但配置重新校验失败，请检查 Supervisor 日志"
  rm -f "$(supervisor_marker)"
  ok "RSM Supervisor 自启动已关闭（RSM 已停止，其他进程组保持不变）"
}
