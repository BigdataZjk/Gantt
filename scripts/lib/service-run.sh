#!/usr/bin/env bash
# RSM 前台启动包装：写入 run/rsm.pid 后 exec 当前版本程序。
# 由 rsm.sh start 或 launchd/systemd 调用；PID 在 exec 前后保持不变，便于 stop 校验归属。
set -u

home=""
addr=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) home="${2:-}"; shift 2 ;;
    --home=*) home="${1#*=}"; shift ;;
    --addr) addr="${2:-}"; shift 2 ;;
    --addr=*) addr="${1#*=}"; shift ;;
    *) shift ;;
  esac
done

if [ -z "$home" ] || [ -z "$addr" ]; then
  printf 'run-service: 缺少 --home 或 --addr\n' >&2
  exit 2
fi

bin="$home/current/rsm"
if [ ! -x "$bin" ]; then
  printf 'run-service: 未找到可执行程序 %s\n' "$bin" >&2
  exit 3
fi

umask 077
mkdir -p "$home/run" "$home/logs" || exit 4
printf '%s\n' "$$" >"$home/run/rsm.pid.tmp.$$" || exit 4
mv -f "$home/run/rsm.pid.tmp.$$" "$home/run/rsm.pid" || exit 4

exec "$bin" serve --home "$home" --addr "$addr" >>"$home/logs/rsm.log" 2>&1
