#!/usr/bin/env bash
# 备份与恢复：包装 Go CLI（一致性快照、校验、恢复），负责显式确认、先备份现状、停服/启动编排。
# 依赖 common.sh / instance.sh / service.sh / release.sh 已 source。

backup_unique_path() {
  local dir="$1" prefix="$2" version stamp stem output count=1
  version=$(installed_version) || return 1
  case "$version" in ''|*[!A-Za-z0-9._+-]*) return 1 ;; esac
  stamp=$(TZ=CST-8 date '+%Y%m%d-%H%M%S') || return 1
  stem="${prefix}-v${version}-${stamp}"
  output="$dir/$stem.zip"
  while [ -e "$output" ]; do
    output="$dir/$stem-$count.zip"
    count=$((count+1))
  done
  printf '%s' "$output"
}

backup_binary() {
  _bb_bin="$(home_current_binary)"
  [ -x "$_bb_bin" ] || die "未安装 RSM 或当前程序不存在: $_bb_bin"
  printf '%s' "$_bb_bin"
}

# 调用 Go CLI 创建备份；成功返回路径并记录状态。失败返回非 0（不删除已生成文件，便于排查）。
backup_create_file() {
  _bcf_out="$1"
  _bcf_bin=$(backup_binary)
  _bcf_dir=$(dirname "$_bcf_out")
  mkdir -p "$_bcf_dir" || die "无法创建备份目录: $_bcf_dir"
  if [ -e "$_bcf_out" ]; then
    die "备份文件已存在，拒绝覆盖: $_bcf_out"
  fi
  info "创建一致性备份: $_bcf_out"
  if ! "$_bcf_bin" backup --home "$RSM_HOME" --output "$_bcf_out"; then
    warn "备份命令失败（服务根目录 ${RSM_HOME}）"
    rm -f "$_bcf_out" 2>/dev/null || true
    return 1
  fi
  if [ ! -f "$_bcf_out" ] || [ "$(file_size "$_bcf_out")" -le 0 ]; then
    warn "备份命令返回成功但未生成有效文件: $_bcf_out"
    return 1
  fi
  if ! "$_bcf_bin" verify-backup --input "$_bcf_out"; then
    warn "备份校验失败: ${_bcf_out}（文件保留，可人工检查）"
    return 1
  fi
  chmod 600 "$_bcf_out" 2>/dev/null || true
  ST_LAST_BACKUP="$_bcf_out"
  state_save
  event_log "backup $RSM_HOME -> $_bcf_out size=$(file_size "$_bcf_out")"
  BACKUP_CREATED_PATH="$_bcf_out"
  ok "备份完成: ${_bcf_out}（$(human_size "$(file_size "$_bcf_out")")）"
  return 0
}

verify_backup_file() {
  _vbf_file="$1"
  _vbf_bin=$(backup_binary)
  [ -f "$_vbf_file" ] || die "备份文件不存在: $_vbf_file"
  info "校验备份: $_vbf_file"
  if ! "$_vbf_bin" verify-backup --input "$_vbf_file"; then
    die "备份校验失败: ${_vbf_file}（文件未通过完整性/密钥/版本检查）"
  fi
  ok "备份校验通过"
}

backup_cmd() {
  _bc_out="${1:-}"
  require_installed
  ensure_layout
  resolve_addr
  if [ -z "$_bc_out" ]; then
    _bc_out=$(backup_unique_path "$(home_backups_dir)" "rsm-backup") || die "无法生成备份文件名"
  else
    case "$_bc_out" in
      /*) ;;
      *) _bc_out="$(pwd -P)/$_bc_out" ;;
    esac
    if [ -e "$_bc_out" ]; then die "输出文件已存在，拒绝覆盖: $_bc_out"; fi
  fi
  backup_create_file "$_bc_out" || die "备份失败（服务与数据保持不变）"
  printf '\n备份文件: %s\n' "$_bc_out"
  printf '默认文件名包含程序版本和北京时间；本次已完成完整性校验。\n'
}

verify_backup_cmd() {
  _vb_file="${1:-}"
  [ -n "$_vb_file" ] || die "用法: rsm.sh verify-backup <备份文件>"
  [ -f "$_vb_file" ] || die "备份文件不存在: $_vb_file"
  require_installed
  verify_backup_file "$_vb_file"
}

restore_cmd() {
  _rs_file="${1:-}"
  [ -n "$_rs_file" ] || die "用法: rsm.sh restore <备份文件>（需先校验，恢复前会自动备份当前状态）"
  [ -f "$_rs_file" ] || die "备份文件不存在: $_rs_file"
  require_installed
  ensure_layout
  resolve_addr
  verify_backup_file "$_rs_file"

  step "确认恢复操作"
  confirm_yes "将用备份恢复实例 $RSM_HOME 的数据库与密钥（当前状态会先备份）"

  _rs_pre=""
  if data_present; then
    step "先备份当前状态（失败则中止，不修改数据）"
    if backup_for_change "pre-restore"; then _rs_pre="$BACKUP_CREATED_PATH"; else _rs_pre=""; fi
    if [ -z "$_rs_pre" ] || [ ! -f "$_rs_pre" ]; then
      die "无法备份当前状态，已中止恢复；数据未被修改"
    fi
    ok "当前状态已备份: $_rs_pre"
  else
    info "当前没有业务数据，跳过恢复前备份"
  fi

  _rs_was_running=0
  if instance_running; then
    _rs_was_running=1
    step "停止服务（restore 要求停服）"
    stop_instance
  fi

  _rs_bin=$(backup_binary)
  step "执行恢复"
  if ! "$_rs_bin" restore --home "$RSM_HOME" --input "$_rs_file"; then
    warn "restore 命令失败；服务保持停止，未自动启动"
    if [ -n "$_rs_pre" ]; then warn "恢复前状态备份: $_rs_pre"; fi
    die "恢复失败：请检查上方错误与日志 $(home_log_path)。数据目录可能处于需人工处理状态，未做任何自动覆盖"
  fi

  # 跨机器恢复保留目标实例地址，避免备份中的旧端口与实际启动参数不一致。
  config_write_addr "$RSM_ADDR" || die "数据已恢复，但保存目标实例监听地址失败；请修复 config.json 后启动"

  ST_LAST_RESTORE=$(now_iso)
  state_save
  event_log "restore $RSM_HOME <- $_rs_file"
  step "启动并核对健康状态"
  if start_instance; then
    ok "恢复完成并已启动"
    print_deploy_summary "$(current_release_dir)" ""
    return 0
  fi
  warn "恢复成功但服务启动失败；服务保持停止，请检查日志"
  if [ -n "$_rs_pre" ]; then warn "如需回到恢复前状态，可显式执行: $RSM_HOME/rsm.sh restore \"$_rs_pre\""; fi
  die "恢复后启动失败"
}
