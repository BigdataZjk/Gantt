#!/usr/bin/env bash
# 管理锁：基于 mkdir 的原子锁，同一实例/同一仓库构建互斥；陈旧锁（持有进程已死）可回收。

RSM_LOCK_DIRS=()

lock_acquire() {
  _la_dir="$1"; _la_label="${2:-管理操作}"
  _la_try=1
  while [ "$_la_try" -le 2 ]; do
    if mkdir "$_la_dir" 2>/dev/null; then
      printf '%s\n' "$$" >"$_la_dir/pid" 2>/dev/null || true
      printf '%s %s %s\n' "$(now_iso)" "$_la_label" "$(hostname 2>/dev/null || uname -n)" >"$_la_dir/owner" 2>/dev/null || true
      RSM_LOCK_DIRS[${#RSM_LOCK_DIRS[@]}]="$_la_dir"
      return 0
    fi
    _la_pid=$(cat "$_la_dir/pid" 2>/dev/null || true)
    is_uint "$_la_pid" || die "管理锁正在初始化或信息不完整: $_la_dir。请等待；若确认没有管理操作运行，可删除该锁目录后重试"
    if is_uint "$_la_pid" && pid_alive "$_la_pid"; then
      _la_owner=$(cat "$_la_dir/owner" 2>/dev/null || true)
      die "另一个管理操作正在进行（pid=${_la_pid}，${_la_owner}，锁=${_la_dir}）。请等待其完成；若确认误解锁可删除锁目录"
    fi
    _la_stale="$_la_dir.stale.$$"
    if mv "$_la_dir" "$_la_stale" 2>/dev/null; then
      rm -rf "$_la_stale" 2>/dev/null || true
      debug "已回收陈旧锁: $_la_dir"
      _la_try=$((_la_try+1))
      continue
    fi
    die "无法获取管理锁: ${_la_dir}（可能被并发操作占用，请稍后重试）"
  done
  die "无法获取管理锁: $_la_dir"
}

lock_release_all() {
  if [ "${#RSM_LOCK_DIRS[@]}" -gt 0 ]; then
    for _lr_dir in "${RSM_LOCK_DIRS[@]}"; do
      rm -rf "$_lr_dir" 2>/dev/null || true
    done
  fi
  RSM_LOCK_DIRS=()
}

lock_holder() {
  [ -d "$1" ] || return 1
  cat "$1/owner" 2>/dev/null || true
}
