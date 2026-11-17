#!/usr/bin/env bash
set -eu
set -o pipefail

RSM_TEST_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)

if [ "${1:-}" = "--service-case" ]; then
  . "$RSM_TEST_ROOT/scripts/lib/common.sh"
  . "$RSM_TEST_ROOT/scripts/lib/service.sh"
  SERVICE_UID="$2"
  action="$3"
  failure="$4"
  RSM_HOME="$RSM_TEST_DIR/instance with space"
  RSM_ADDR=0.0.0.0:1111
  host_os() { printf linux; }
  printf '%s\n' "$(linux_unit_dir)" >"$RSM_TEST_DIR/default-unit-dir"
  linux_unit_dir() { printf '%s/units' "$RSM_TEST_DIR"; }
  ensure_layout() { mkdir -p "$RSM_HOME/logs"; }
  ensure_service_wrapper() { :; }
  rotate_log() { :; }
  instance_running() { [ ! -f "$RSM_TEST_DIR/stopped" ]; }
  stop_instance() { printf 'stop-instance\n' >>"$RSM_TEST_DIR/calls"; touch "$RSM_TEST_DIR/stopped"; }
  wait_healthy() { [ "$failure" != health ]; }
  systemctl() {
    local scope=system command
    if [ "${1:-}" = --user ]; then scope=user; shift; fi
    command="$1"
    printf '%s %s\n' "$scope" "$*" >>"$RSM_TEST_DIR/calls"
    case "$failure:$command" in
      manager:show-environment|reload:daemon-reload|enable:enable|start:start|disable:disable) return 1 ;;
    esac
    if [ "$command" = is-active ]; then return 1; fi
    return 0
  }
  case "$action" in
    install) service_install_and_start ;;
    start) service_start ;;
    remove) ensure_layout; write_unit; service_remove ;;
    loaded) service_loaded ;;
  esac
  exit
fi

RSM_TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rsm-deploy-tests.XXXXXX")
trap 'rm -rf "$RSM_TEST_TMP"' EXIT
passed=0
pass() { passed=$((passed+1)); printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

service_case() {
  local uid="$1" action="$2" failure="$3" expected="$4" status=0
  RSM_TEST_DIR="$RSM_TEST_TMP/$uid-$action-$failure"
  mkdir -p "$RSM_TEST_DIR"
  RSM_TEST_DIR="$RSM_TEST_DIR" "$BASH" "$0" --service-case "$uid" "$action" "$failure" >"$RSM_TEST_DIR/output" 2>&1 || status=$?
  if [ "$expected" = success ]; then
    [ "$status" -eq 0 ] || { cat "$RSM_TEST_DIR/output"; fail "$uid $action $failure"; }
  else
    [ "$status" -ne 0 ] || fail "failure returned success: $uid $action $failure"
  fi
}

for uid in 0 1000; do
  if [ "$uid" = 0 ]; then scope=system; target=multi-user.target
  else scope=user; target=default.target; fi
  service_case "$uid" install none success
  unit=$(find "$RSM_TEST_DIR/units" -name '*.service' -type f)
  [ -n "$unit" ] || fail "missing unit"
  grep -q "^WantedBy=$target$" "$unit" || fail "wrong boot target"
  grep -q '^WorkingDirectory=".*instance with space"$' "$unit" || fail "unquoted working directory"
  grep -q '^UMask=0077$' "$unit" || fail "missing private umask"
  awk -v scope="$scope" '
    $1 != scope && $1 != "stop-instance" { exit 1 }
    $2 == "enable" { enabled=NR }
    $1 == "stop-instance" { stopped=NR }
    $2 == "start" { started=NR }
    END { if (!(enabled > 0 && stopped > enabled && started > stopped)) exit 1 }
  ' "$RSM_TEST_DIR/calls" || fail "wrong service scope or install order"
  if [ "$uid" = 0 ]; then
    [ "$(cat "$RSM_TEST_DIR/default-unit-dir")" = /etc/systemd/system ] || fail "root unit path"
  fi
  pass "$scope install enables correct boot target before replacing the running process"

  for failure in manager reload enable; do
    service_case "$uid" install "$failure" failure
    [ ! -f "$RSM_TEST_DIR/stopped" ] || fail "$failure stopped existing process"
    if grep -q ' start ' "$RSM_TEST_DIR/calls"; then fail "$failure still started service"; fi
    pass "$scope $failure failure preserves the current process"
  done
  for failure in start health; do
    service_case "$uid" install "$failure" failure
    pass "$scope $failure failure returns nonzero"
  done
  service_case "$uid" start none success
  if grep -q ' enable ' "$RSM_TEST_DIR/calls"; then fail "ordinary start enabled autostart"; fi
  grep -q -- '--addr "0.0.0.0:1111"' "$RSM_TEST_DIR"/units/*.service || fail "start did not refresh address"
  pass "$scope start refreshes configuration without enabling autostart"
  service_case "$uid" loaded none failure
  grep -q "$scope is-active --quiet" "$RSM_TEST_DIR/calls" || fail "loaded checked enablement instead of activity"
  pass "$scope stopped service is inactive even while enabled"
  service_case "$uid" remove none success
  grep -q "$scope disable --now" "$RSM_TEST_DIR/calls" || fail "disable missing"
  [ -z "$(find "$RSM_TEST_DIR/units" -name '*.service' -type f)" ] || fail "unit not removed"
  pass "$scope disable stops and removes the service"
  service_case "$uid" remove disable failure
  [ -n "$(find "$RSM_TEST_DIR/units" -name '*.service' -type f)" ] || fail "failed disable discarded configuration"
  pass "$scope failed disable preserves configuration and returns nonzero"
done

. "$RSM_TEST_ROOT/scripts/lib/common.sh"
. "$RSM_TEST_ROOT/scripts/lib/lock.sh"
lock_acquire "$RSM_TEST_TMP/lock with space" test
mkdir -p "$RSM_TEST_TMP/unrelated"
lock_release_all
[ ! -d "$RSM_TEST_TMP/lock with space" ] && [ -d "$RSM_TEST_TMP/unrelated" ] || fail "lock cleanup split a path"
pass 'lock cleanup preserves paths with spaces and unrelated directories'
mkdir -p "$RSM_TEST_TMP/initializing-lock"
if (lock_acquire "$RSM_TEST_TMP/initializing-lock" test) >/dev/null 2>&1; then fail "initializing lock was stolen"; fi
[ -d "$RSM_TEST_TMP/initializing-lock" ] || fail 'initializing lock removed'
pass 'concurrent management cannot steal a lock before its PID is written'

RSM_ROOT="$RSM_TEST_ROOT"
. "$RSM_TEST_ROOT/scripts/lib/toolchain.sh"
TOOLS_DIR="$RSM_TEST_TMP/tools with space"
TOOLCHAIN_ENV_FILE="$TOOLS_DIR/toolchain.env"
RSM_GO_BIN="$TOOLS_DIR/go/bin/go"
RSM_NODE_BIN="$TOOLS_DIR/node/bin/node"
RSM_NPM_BIN="$TOOLS_DIR/node/bin/npm"
RSM_PNPM_BIN="$TOOLS_DIR/pnpm/bin/pnpm"
save_toolchain_env
(
  . "$TOOLCHAIN_ENV_FILE"
  [ "$RSM_GO_BIN" = "$TOOLS_DIR/go/bin/go" ] && [ "$RSM_PNPM_BIN" = "$TOOLS_DIR/pnpm/bin/pnpm" ]
) || fail 'toolchain path roundtrip failed'
pass 'saved toolchain paths support spaces'

(
  unset GOPATH GOMODCACHE GOCACHE GOENV TEST_TELEMETRY_DIR npm_config_cache PNPM_CONFIG_STORE_DIR PNPM_CONFIG_CACHE_DIR PNPM_CONFIG_STATE_DIR
  unset XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME
  CACHE_DIR="$RSM_TEST_TMP/source with space/.cache"
  setup_build_cache_env
  for cache_path in "$GOPATH" "$GOMODCACHE" "$GOCACHE" "$GOENV" "$TEST_TELEMETRY_DIR" "$npm_config_cache" "$PNPM_CONFIG_STORE_DIR" "$PNPM_CONFIG_CACHE_DIR" "$PNPM_CONFIG_STATE_DIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"; do
    case "$cache_path" in
      "$CACHE_DIR"/*) : ;;
      *) exit 1 ;;
    esac
  done
) || fail 'default build cache escaped the project directory'
pass 'default Go, npm, pnpm and XDG caches stay inside the project'

(
  GOPATH="$RSM_TEST_TMP/custom go"
  GOMODCACHE="$RSM_TEST_TMP/custom modules"
  GOCACHE="$RSM_TEST_TMP/custom build"
  npm_config_cache="$RSM_TEST_TMP/custom npm"
  PNPM_CONFIG_STORE_DIR="$RSM_TEST_TMP/custom pnpm"
  XDG_CONFIG_HOME="$RSM_TEST_TMP/custom config"
  setup_build_cache_env
  [ "$GOPATH" = "$RSM_TEST_TMP/custom go" ] &&
    [ "$GOMODCACHE" = "$RSM_TEST_TMP/custom modules" ] &&
    [ "$GOCACHE" = "$RSM_TEST_TMP/custom build" ] &&
    [ "$npm_config_cache" = "$RSM_TEST_TMP/custom npm" ] &&
    [ "$PNPM_CONFIG_STORE_DIR" = "$RSM_TEST_TMP/custom pnpm" ] &&
    [ "$XDG_CONFIG_HOME" = "$RSM_TEST_TMP/custom config" ]
) || fail 'explicit build cache configuration was overwritten'
pass 'explicit cache locations remain configurable'

. "$RSM_TEST_ROOT/scripts/lib/instance.sh"
RSM_ROOT="$RSM_TEST_TMP/source root with space"
RSM_HOME_ARG=""
mkdir -p "$RSM_ROOT"
RSM_ROOT=$(cd "$RSM_ROOT" && pwd -P)
resolve_home
[ "$RSM_HOME" = "$RSM_ROOT" ] || fail 'first deployment did not default to its script root'
pass 'first source deployment uses its own directory without RSM_HOME'
(
  cd "$RSM_TEST_TMP/unrelated"
  resolve_home
  [ "$RSM_HOME" = "$RSM_ROOT" ]
) || fail 'caller working directory changed the default instance'
pass 'caller working directory does not change the default instance'
RSM_HOME_ARG="$RSM_TEST_TMP/explicit target"
resolve_home
[ "$RSM_HOME" = "$(abs_path "$RSM_HOME_ARG")" ] || fail 'explicit target was ignored'
pass 'explicit instance directory still overrides the portable default'

printf '%s deployment regression checks passed\n' "$passed"
