#!/usr/bin/env bash
# 发布包：校验/解包、候选版本准备、原子切换、升级失败回退、rollback（仅程序 + schema 兼容检查）。
# 依赖 common.sh / instance.sh / service.sh / backup.sh 已 source。

PKG_ROOT=""
PKG_TMP=""
PKG_VERSION=""
PKG_SCHEMA="0"
PKG_OS=""
PKG_ARCH=""
CANDIDATE_DIR=""

package_cleanup() {
  if [ -n "$PKG_TMP" ] && [ -d "$PKG_TMP" ]; then
    rm -rf "$PKG_TMP" 2>/dev/null || true
  fi
  PKG_TMP=""
}

package_fail() {
  package_cleanup
  die "$@"
}

# 校验 SHA256SUMS（<sha>  <相对路径>）；拒绝绝对路径与 .. 路径。
package_verify_manifest() {
  _pvm_root="$1"
  _pvm_sums="$_pvm_root/SHA256SUMS"
  [ -f "$_pvm_sums" ] || package_fail "发行包缺少 SHA256SUMS: $_pvm_root"
  have_cmd awk || package_fail "缺少 awk，无法校验发行包"
  _pvm_count=0
  while IFS= read -r _pvm_line || [ -n "$_pvm_line" ]; do
    [ -n "$_pvm_line" ] || continue
    _pvm_sha=$(printf '%s' "$_pvm_line" | awk '{print $1}')
    _pvm_path=$(printf '%s' "$_pvm_line" | sed 's/^[^ ]*  *//')
    case "$_pvm_path" in
      /*) package_fail "发行包清单包含绝对路径，已拒绝: $_pvm_path" ;;
      *..*) package_fail "发行包清单包含可疑路径，已拒绝: $_pvm_path" ;;
    esac
    _pvm_file="$_pvm_root/$_pvm_path"
    [ -f "$_pvm_file" ] || package_fail "发行包文件缺失: $_pvm_path"
    _pvm_actual=$(sha256_file "$_pvm_file")
    if [ "$_pvm_actual" != "$_pvm_sha" ]; then
      package_fail "发行包文件校验失败: ${_pvm_path}（期望 ${_pvm_sha}，实际 ${_pvm_actual}）"
    fi
    _pvm_count=$((_pvm_count+1))
  done <"$_pvm_sums"
  [ "$_pvm_count" -gt 0 ] || package_fail "发行包 SHA256SUMS 为空: $_pvm_sums"
  ok "发行包文件校验通过（$_pvm_count 个文件）"
}

# 校验发行包并设置 PKG_VERSION/PKG_SCHEMA/PKG_OS/PKG_ARCH。
package_verify() {
  _pkg_root="$1"
  _pkg_meta="$_pkg_root/release.json"
  [ -f "$_pkg_meta" ] || package_fail "发行包缺少 release.json: $_pkg_root"
  PKG_VERSION=$(json_get "$_pkg_meta" version 2>/dev/null || true)
  PKG_SCHEMA=$(json_get "$_pkg_meta" schemaVersion 2>/dev/null || true)
  PKG_OS=$(json_get "$_pkg_meta" os 2>/dev/null || true)
  PKG_ARCH=$(json_get "$_pkg_meta" arch 2>/dev/null || true)
  is_uint "$PKG_SCHEMA" || PKG_SCHEMA=0
  [ -n "$PKG_VERSION" ] || package_fail "发行包 release.json 缺少 version"
  [ -n "$PKG_OS" ] || package_fail "发行包 release.json 缺少 os"
  [ -n "$PKG_ARCH" ] || package_fail "发行包 release.json 缺少 arch"
  if [ "$PKG_OS" != "$(host_os)" ] || [ "$PKG_ARCH" != "$(host_arch)" ]; then
    package_fail "发行包平台不匹配：包为 $PKG_OS-${PKG_ARCH}，本机为 $(platform_key)。请在目标平台重新构建/使用对应发行包"
  fi
  [ -x "$_pkg_root/rsm" ] || package_fail "发行包缺少可执行文件 rsm"
  [ -f "$_pkg_root/rsm.sh" ] || package_fail "发行包缺少入口 rsm.sh"
  _pkg_lib=$(ls "$_pkg_root"/scripts/lib/*.sh 2>/dev/null | head -n1)
  [ -n "$_pkg_lib" ] || package_fail "发行包缺少 scripts/lib/"
  package_verify_manifest "$_pkg_root"
  _pkg_binver=$(binary_version "$_pkg_root/rsm" 2>/dev/null || true)
  [ -n "$_pkg_binver" ] || package_fail "发行包程序无法执行 --version（可能平台不匹配或缺少运行库）"
  [ "$_pkg_binver" = "$PKG_VERSION" ] || package_fail "发行包程序版本 $_pkg_binver 与 release.json 的 $PKG_VERSION 不一致"
  PKG_ROOT="$_pkg_root"
  ok "发行包校验通过：v${PKG_VERSION}（$PKG_OS-${PKG_ARCH}，schema ${PKG_SCHEMA}）"
}

# 解析发行包参数：tar.gz 文件或已解压目录；设置 PKG_ROOT/PKG_TMP 等。
resolve_package() {
  _rp_input="$1"
  [ -n "$_rp_input" ] || package_fail "缺少发行包参数（tar.gz 文件或已解压目录）"
  if [ -d "$_rp_input" ]; then
    package_verify "$(abs_path "$_rp_input")"
    return 0
  fi
  if [ ! -f "$_rp_input" ]; then
    package_fail "发行包不存在: $_rp_input"
  fi
  _rp_abs=$(abs_path "$_rp_input")
  case "$_rp_abs" in
    *.tar.gz|*.tgz) ;;
    *) package_fail "不支持的发行包格式: ${_rp_input}（请提供 .tar.gz 或解压后的目录）" ;;
  esac
  if [ -f "$_rp_abs.sha256" ]; then
    _rp_want=$(awk 'NR==1{print $1}' "$_rp_abs.sha256")
    _rp_act=$(sha256_file "$_rp_abs")
    [ "$_rp_want" = "$_rp_act" ] || package_fail "发行包 SHA256 校验失败: $_rp_abs"
    ok "发行包归档校验通过"
  else
    warn "发行包未附带 .sha256 校验文件；继续校验包内 SHA256SUMS"
  fi
  if have_cmd tar; then :; else package_fail "缺少 tar，无法解压发行包"; fi
  if tar -tzf "$_rp_abs" 2>/dev/null | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    package_fail "发行包内含绝对路径或 .. 路径，已拒绝: $_rp_abs"
  fi
  mkdir -p "$CACHE_DIR" 2>/dev/null || true
  PKG_TMP=$(mktemp -d "$CACHE_DIR/pkg.XXXXXX") || package_fail "无法创建临时解包目录"
  tar -xzf "$_rp_abs" -C "$PKG_TMP" || package_fail "解压发行包失败: $_rp_abs"
  # 兼容 tar 内单层目录与根目录直接放文件两种布局
  _rp_meta=$(find "$PKG_TMP" -maxdepth 2 -name release.json -type f | head -n1)
  [ -n "$_rp_meta" ] || package_fail "发行包内未找到 release.json"
  _rp_root=$(dirname "$_rp_meta")
  [ "$_rp_root" != "$PKG_TMP" ] || _rp_root=$(dirname "$_rp_meta")
  package_verify "$_rp_root"
}

# 把已校验发行包准备为候选发布目录（不切换、不重启）。
prepare_release_dir() {
  _prd_root="$1"
  _prd_id="$PKG_VERSION-$(timestamp_compact)"
  _prd_dst="$RSM_HOME/releases/$_prd_id"
  _prd_stage="$RSM_HOME/releases/.staging-$_prd_id.$$"
  rm -rf "$_prd_stage"
  mkdir -p "$_prd_stage" || package_fail "无法创建候选目录: $_prd_stage"
  cp -p "$_prd_root/rsm" "$_prd_stage/rsm" || package_fail "复制程序失败"
  chmod 755 "$_prd_stage/rsm" 2>/dev/null || true
  cp -p "$_prd_root/release.json" "$_prd_stage/release.json" || package_fail "复制发行元数据失败"
  printf '%s\n' "$(date +%s)" >"$_prd_stage/installed-at" || package_fail "写入安装时间失败"
  chmod 600 "$_prd_stage/installed-at" 2>/dev/null || true
  ( cd "$_prd_stage" && ./rsm --version >/dev/null 2>&1 ) || {
    rm -rf "$_prd_stage"
    package_fail "候选程序无法在当前系统执行 --version: $_prd_stage/rsm"
  }
  rm -rf "$_prd_dst"
  mv "$_prd_stage" "$_prd_dst" || { rm -rf "$_prd_stage"; package_fail "准备候选目录失败"; }
  CANDIDATE_DIR="$_prd_dst"
  ok "候选版本已就绪: releases/$_prd_id"
}

record_active_release() {
  _rar_dir="$1"
  ST_ACTIVE_RELEASE=$(basename "$_rar_dir")
  ST_ACTIVE_VERSION=$(release_version_of "$_rar_dir")
  ST_INSTALLED_AT=$(release_installed_at_of "$_rar_dir")
}

# 切换前备份（调用 Go CLI，由调用方保证此时服务已停止或允许在线备份）。
backup_for_change() {
  _bfc_label="$1"
  _bfc_out=$(backup_unique_path "$RSM_HOME/backups" "$_bfc_label")
  BACKUP_CREATED_PATH=""
  backup_create_file "$_bfc_out" || return 1
  BACKUP_CREATED_PATH="$_bfc_out"
  return 0
}

print_deploy_summary() {
  _pds_dir="$1"; _pds_backup="${2:-}"
  _pds_ver=$(release_version_of "$_pds_dir")
  printf '\n%sRSM 部署完成%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  printf '  版本:     %s（%s）\n' "$_pds_ver" "$(basename "$_pds_dir")"
  printf '  安装目录: %s\n' "$RSM_HOME"
  printf '  监听:     %s\n' "$RSM_ADDR"
  printf '  状态:     '
  if instance_running; then printf '运行中（pid=%s）\n' "$(instance_pid)"; else printf '未运行\n'; fi
  access_urls
  printf '  运行日志: %s\n' "$(home_log_path)"
  if [ -n "${RSM_LOG_FILE:-}" ]; then printf '  部署日志: %s\n' "$RSM_LOG_FILE"; fi
  printf '  备份目录: %s\n' "$(home_backups_dir)"
  if [ -n "$_pds_backup" ] && [ -f "$_pds_backup" ]; then
    printf '  切换前备份: %s\n' "$_pds_backup"
  fi
  printf '提示: 首次使用请在浏览器打开页面，按提示设置超级管理员（张金科）密码；密码不会写入日志或命令行。\n'
}

# 激活候选版本：先安装管理脚本（失败时可无损中止），再短暂停服、切换前备份、切换、启动、健康核对。
# MODE: deploy（普通部署/同版本重装）| upgrade（升级，要求目标 schema 不低于当前确认 schema）
deploy_activate() {
  _da_candidate="$1"; _da_mode="${2:-deploy}"
  [ -d "$_da_candidate" ] || die "候选版本目录不存在: $_da_candidate"
  [ -n "$PKG_ROOT" ] || die "内部错误：发行包未解析"
  _da_new_version=$(release_version_of "$_da_candidate")
  _da_new_schema=$(release_schema_of "$_da_candidate")
  is_uint "$_da_new_schema" || _da_new_schema=0
  _da_prev=$(current_release_dir 2>/dev/null || true)
  _da_prev_ver=""
  if [ -n "$_da_prev" ]; then _da_prev_ver=$(release_version_of "$_da_prev"); fi
  _da_was_running=0
  if instance_running; then _da_was_running=1; fi

  if [ "$_da_mode" = "upgrade" ] && num_gt "$ST_SCHEMA_VERSION" "$_da_new_schema"; then
    die "拒绝升级：目标版本 schemaVersion=$_da_new_schema 低于当前已确认的数据库 schema（${ST_SCHEMA_VERSION}）。请使用 rollback（回退程序）或显式 restore（恢复备份）"
  fi

  step "安装管理脚本（不影响当前运行的服务）"
  ensure_layout
  install_management_scripts "$PKG_ROOT"

  step "保护现有数据（按需停服并备份）"
  if [ "$_da_was_running" = "1" ]; then
    info "短暂停止当前服务"
    stop_instance
  else
    info "当前没有运行中的实例"
  fi

  _da_backup=""
  if data_present; then
    info "切换前创建一致性备份（保留数据可回滚）"
    if backup_for_change "pre-deploy"; then _da_backup="$BACKUP_CREATED_PATH"; else _da_backup=""; fi
    if [ -z "$_da_backup" ] || [ ! -f "$_da_backup" ]; then
      warn "切换前备份失败，未切换程序"
      if [ "$_da_was_running" = "1" ] && [ -n "$_da_prev" ]; then
        start_instance >/dev/null 2>&1 || warn "旧版本也未能重新启动，请检查日志: $(home_log_path)"
      fi
      die "已中止：未切换程序、未改变数据。请修复备份问题（查看日志）后重试"
    fi
  else
    info "尚无业务数据，跳过切换前备份"
  fi

  step "切换到新版本并检查服务健康状态"
  info "目标版本: $(basename "$_da_candidate")"
  switch_current_link "$_da_candidate"

  if start_instance; then
    record_active_release "$_da_candidate"
    ST_LAST_DEPLOYED_AT=$(now_iso)
    state_save
    cleanup_old_releases
    package_cleanup
    print_deploy_summary "$_da_candidate" "$_da_backup"
    return 0
  fi

  warn "新版本启动失败，开始故障回退（只回退程序，不会用旧备份覆盖数据库）"
  stop_instance_quiet
  if [ -n "$_da_prev" ]; then
    warn "回退到上一版本 v${_da_prev_ver}（$(basename "$_da_prev")）"
    switch_current_link "$_da_prev"
    if start_instance; then
      record_active_release "$_da_prev"
      ST_LAST_DEPLOYED_AT=$(now_iso)
      state_save
      warn "已恢复上一版本运行。"
      if [ -n "$_da_backup" ]; then
        warn "注意：新版本可能已对数据库执行过迁移，因此未自动用备份覆盖数据。若确认新版本未接收写入、需要回到切换前数据，请显式执行:"
        warn "  $RSM_HOME/rsm.sh restore \"$_da_backup\""
      fi
      warn "失败的新版本目录保留在 releases/$(basename "$_da_candidate")，日志: $(home_log_path)"
      package_cleanup
      return 1
    fi
    warn "上一版本也未能启动；服务保持停止，所有数据与备份均保留，未做任何覆盖"
  else
    warn "首次部署启动失败；服务保持停止（数据目录为空或保留），未做任何清理"
  fi
  if [ -n "$_da_backup" ]; then printf '切换前备份: %s\n' "$_da_backup" >&2; fi
  printf '候选程序: %s\n日志: %s\n' "$_da_candidate" "$(home_log_path)" >&2
  package_cleanup
  return 1
}

# ---- 部署入口 ----
deploy_from_source() {
  progress_plan 6
  _dfs_repo="$RSM_ROOT"
  if [ ! -f "$_dfs_repo/go.mod" ] || [ ! -f "$_dfs_repo/api/openapi.yaml" ] || [ ! -d "$_dfs_repo/web" ] || [ ! -f "$_dfs_repo/scripts/build.sh" ]; then
    die "当前目录不是完整 RSM 源码仓库（需要 go.mod、api/openapi.yaml、web/、scripts/build.sh）: $_dfs_repo"
  fi
  if [ ! -f "$_dfs_repo/cmd/rsm/main.go" ]; then
    die "源码缺少 cmd/rsm/main.go，无法构建（当前源码树可能尚未完成）"
  fi
  step "准备源码构建工具链（固定版本；缺失时联网下载到 .tools，不替换系统工具）"
  "$_dfs_repo/scripts/bootstrap.sh" --ensure-build || die "构建依赖准备失败，未做任何部署变更"
  step "生成接口类型并构建发行包"
  "$_dfs_repo/scripts/build.sh" || die "构建失败，未做任何部署变更"
  _dfs_pkg=$(cat "$_dfs_repo/build/package.path" 2>/dev/null | head -n1)
  [ -n "$_dfs_pkg" ] || die "构建未产生发行包（build/package.path 缺失）"
  [ -f "$_dfs_pkg" ] || die "构建输出的发行包不存在: $_dfs_pkg"
  step "校验发行包"
  resolve_package "$_dfs_pkg"
  prepare_release_dir "$PKG_ROOT"
  deploy_activate "$CANDIDATE_DIR" "deploy"
}

deploy_from_package() {
  progress_plan 4
  _dfp_pkg="$1"
  step "校验发行包"
  resolve_package "$_dfp_pkg"
  prepare_release_dir "$PKG_ROOT"
  deploy_activate "$CANDIDATE_DIR" "deploy"
}

deploy_cmd() {
  ensure_download_tools
  case "$RSM_MODE" in
    source)
      deploy_from_source ;;
    package)
      deploy_from_package "$RSM_ROOT" ;;
    installed)
      progress_plan 1
      require_installed
      step "已在实例目录：确保服务运行（升级请使用 ./rsm.sh upgrade <发行包>）"
      ensure_layout
      resolve_addr
      persist_addr_if_explicit
      if instance_running; then
        ok "实例已在运行（pid=$(instance_pid)，${RSM_ADDR}）"
      else
        start_instance || die "启动失败"
      fi
      print_deploy_summary "$(current_release_dir)" "" ;;
    *)
      die "无法识别运行模式: $RSM_MODE" ;;
  esac
}

# ---- 升级 ----
upgrade_cmd() {
  _uc_pkg="${1:-}"
  [ -n "$_uc_pkg" ] || die "用法: rsm.sh upgrade <发行包.tar.gz|发行包目录>"
  require_installed
  ensure_layout
  resolve_addr
  _uc_cur=$(installed_version 2>/dev/null || true)
  step "校验目标发行包"
  resolve_package "$_uc_pkg"
  if [ "$PKG_VERSION" = "$_uc_cur" ]; then
    if [ "${RSM_FORCE:-0}" != "1" ]; then
      die "目标版本与当前一致（v${PKG_VERSION}）。如需重装同一版本，请使用无参数部署或加 --force"
    fi
    warn "目标版本与当前一致（v${PKG_VERSION}），按 --force 重新部署"
  fi
  if num_gt "$ST_SCHEMA_VERSION" "$PKG_SCHEMA"; then
    die "拒绝升级：目标版本 schemaVersion=$PKG_SCHEMA 低于当前已确认数据库 schema（${ST_SCHEMA_VERSION}）。请使用 rollback 回退程序，或用 restore 恢复备份"
  fi
  _uc_was_running=0
  if instance_running; then _uc_was_running=1; fi
  if [ "$_uc_was_running" = "0" ]; then ensure_port_available; fi
  step "从 v${_uc_cur:-未安装} 升级到 v$PKG_VERSION"
  prepare_release_dir "$PKG_ROOT"
  deploy_activate "$CANDIDATE_DIR" "upgrade"
}

# ---- 回退（仅程序） ----
release_installed_ts() { release_installed_at_of "$1"; }

previous_release_dir() {
  _prd_cur=$(current_release_dir 2>/dev/null || true)
  [ -n "$_prd_cur" ] || return 1
  _prd_cur_ts=$(release_installed_ts "$_prd_cur"); is_uint "$_prd_cur_ts" || _prd_cur_ts=0
  _prd_best=""
  _prd_best_ts=-1
  for _prd_d in "$(home_releases_dir)"/*; do
    [ -d "$_prd_d" ] || continue
    _prd_base=$(basename "$_prd_d")
    if [ "${_prd_base#.}" != "$_prd_base" ]; then continue; fi
    [ "$_prd_d" = "$_prd_cur" ] && continue
    _prd_ts=$(release_installed_ts "$_prd_d")
    is_uint "$_prd_ts" || _prd_ts=0
    # 只回退到当前版本之前安装的历史版本，避免把“更新的候选”当回退目标
    if [ "$_prd_ts" -lt "$_prd_cur_ts" ] 2>/dev/null && [ "$_prd_ts" -gt "$_prd_best_ts" ] 2>/dev/null; then
      _prd_best_ts="$_prd_ts"
      _prd_best="$_prd_d"
    fi
  done
  [ -n "$_prd_best" ] || return 1
  printf '%s' "$_prd_best"
}

release_dir_for_version() {
  _rdv_ver="$1"
  _rdv_best=""
  _rdv_best_ts=-1
  for _rdv_d in "$(home_releases_dir)"/*; do
    [ -d "$_rdv_d" ] || continue
    _rdv_base=$(basename "$_rdv_d")
    if [ "${_rdv_base#.}" != "$_rdv_base" ]; then continue; fi
    _rdv_v=$(release_version_of "$_rdv_d")
    [ "$_rdv_v" = "$_rdv_ver" ] || continue
    _rdv_ts=$(release_installed_ts "$_rdv_d"); is_uint "$_rdv_ts" || _rdv_ts=0
    if [ "$_rdv_ts" -gt "$_rdv_best_ts" ] 2>/dev/null; then _rdv_best_ts="$_rdv_ts"; _rdv_best="$_rdv_d"; fi
  done
  [ -n "$_rdv_best" ] || return 1
  printf '%s' "$_rdv_best"
}

rollback_cmd() {
  _rc_arg="${1:-}"
  require_installed
  ensure_layout
  resolve_addr
  _rc_cur=$(current_release_dir) || die "current 软链接无效，无法回退"
  _rc_cur_ver=$(release_version_of "$_rc_cur")
  if [ -n "$_rc_arg" ]; then
    _rc_target=$(release_dir_for_version "$_rc_arg" 2>/dev/null || true)
    [ -n "$_rc_target" ] || die "releases/ 中未找到版本 v$_rc_arg"
    [ "$_rc_target" = "$_rc_cur" ] && die "目标就是当前运行版本 v$_rc_arg"
  else
    _rc_target=$(previous_release_dir 2>/dev/null || true)
    [ -n "$_rc_target" ] || die "没有可回退的历史程序版本（releases/ 中只有当前版本）。如需恢复数据请使用 restore"
  fi
  _rc_tver=$(release_version_of "$_rc_target")
  _rc_tschema=$(release_schema_of "$_rc_target"); is_uint "$_rc_tschema" || _rc_tschema=0
  if num_gt "$ST_SCHEMA_VERSION" "$_rc_tschema"; then
    if [ "${RSM_FORCE:-0}" != "1" ]; then
      die "拒绝回退：目标版本 v$_rc_tver 仅支持 schema ${_rc_tschema}，当前已确认数据库 schema 为 ${ST_SCHEMA_VERSION}。程序回退不会降级数据库；请使用 restore 显式恢复备份。若已人工确认数据库未发生迁移，可加 --force 强制执行（高风险）"
    fi
    warn "已通过 --force 忽略 schema 兼容检查（目标 schema $_rc_tschema < 当前 ${ST_SCHEMA_VERSION}），失败时将保持停服并保留数据"
  fi
  _rc_was_running=0
  if instance_running; then _rc_was_running=1; fi
  if [ "$_rc_was_running" = "0" ]; then ensure_port_available; fi
  step "回退程序：v$_rc_cur_ver -> v${_rc_tver}（数据库保持现状，不自动恢复备份）"
  if [ "$_rc_was_running" = "1" ]; then stop_instance; fi
  switch_current_link "$_rc_target"
  if start_instance; then
    record_active_release "$_rc_target"
    ST_LAST_DEPLOYED_AT=$(now_iso)
    state_save
    ok "已回退到 v${_rc_tver}（仅程序；schema 记录 ${ST_SCHEMA_VERSION}）"
    print_deploy_summary "$_rc_target" ""
    return 0
  fi
  warn "回退后的版本启动失败，恢复原版本 v$_rc_cur_ver"
  stop_instance_quiet
  switch_current_link "$_rc_cur"
  if start_instance; then
    record_active_release "$_rc_cur"
    warn "已恢复原版本 v$_rc_cur_ver 运行"
  else
    warn "原版本也未能启动；服务保持停止，数据与备份均保留"
  fi
  die "回退失败：已尽量恢复原版本，请查看日志 $(home_log_path)"
}

list_releases() {
  printf '当前版本: %s\n' "$(installed_version 2>/dev/null || echo '未安装')"
  printf 'releases/ 程序版本（按安装顺序列出）:\n'
  _lr_cur=$(current_release_dir 2>/dev/null || true)
  for _lr_d in "$(home_releases_dir)"/*; do
    [ -d "$_lr_d" ] || continue
    _lr_base=$(basename "$_lr_d")
    if [ "${_lr_base#.}" = "$_lr_base" ]; then :; else continue; fi
    _lr_mark=""
    [ "$_lr_d" = "$_lr_cur" ] && _lr_mark="  <== current"
    printf '  %-24s v%-12s schema=%s%s\n' "$_lr_base" "$(release_version_of "$_lr_d")" "$(release_schema_of "$_lr_d")" "$_lr_mark"
  done
}
