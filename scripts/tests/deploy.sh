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
  linux_service_backend() { printf systemd; }
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

source_case() (
  local scenario="$1" fixture="$RSM_TEST_TMP/source-$1"
  RSM_ROOT="$fixture/new source"
  RSM_HOME="$fixture/original instance"
  export RSM_SOURCE_TEST_CALLS="$fixture/calls"
  mkdir -p "$RSM_ROOT/api" "$RSM_ROOT/cmd/rsm" "$RSM_ROOT/web" "$RSM_ROOT/scripts" "$RSM_ROOT/build" "$RSM_HOME"
  touch "$RSM_ROOT/go.mod" "$RSM_ROOT/api/openapi.yaml" "$RSM_ROOT/cmd/rsm/main.go" "$RSM_ROOT/build/package.tar.gz"
  cat >"$RSM_ROOT/scripts/bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
printf 'bootstrap %s\n' "$RSM_BUILD_ROOT" >>"$RSM_SOURCE_TEST_CALLS"
EOF
  cat >"$RSM_ROOT/scripts/build.sh" <<'EOF'
#!/usr/bin/env bash
printf 'build %s\n' "$RSM_BUILD_ROOT" >>"$RSM_SOURCE_TEST_CALLS"
[ "${RSM_SOURCE_TEST_FAIL:-0}" = 0 ] || exit 9
root=$(cd "$(dirname "$0")/.." && pwd -P)
printf '%s/build/package.tar.gz\n' "$root" >"$root/build/package.path"
EOF
  chmod +x "$RSM_ROOT/scripts/bootstrap.sh" "$RSM_ROOT/scripts/build.sh"
  . "$RSM_TEST_ROOT/scripts/lib/release.sh"
  instance_installed() { [ "$scenario" != fresh ]; }
  resolve_package() { PKG_ROOT="$RSM_ROOT"; }
  prepare_release_dir() { CANDIDATE_DIR="$RSM_HOME/candidate"; }
  deploy_activate() { printf 'activate %s\n' "$2" >>"$RSM_SOURCE_TEST_CALLS"; }
  stop_instance() { touch "$fixture/stopped"; }
  if [ "$scenario" = failure ]; then export RSM_SOURCE_TEST_FAIL=1; fi
  deploy_from_source >"$fixture/output" 2>&1
)
for scenario in fresh existing failure; do
  status=0
  source_case "$scenario" || status=$?
  fixture="$RSM_TEST_TMP/source-$scenario"
  grep -Fxq "bootstrap $fixture/original instance" "$fixture/calls" &&
    grep -Fxq "build $fixture/original instance" "$fixture/calls" || fail "source $scenario lost the original build cache root"
  [ ! -f "$fixture/stopped" ] || fail "source $scenario stopped the service while building"
  case "$scenario" in
    fresh) [ "$status" = 0 ] && grep -Fxq 'activate deploy' "$fixture/calls" || fail 'fresh source used upgrade mode' ;;
    existing) [ "$status" = 0 ] && grep -Fxq 'activate upgrade' "$fixture/calls" || fail 'source upgrade bypassed schema protection' ;;
    failure) [ "$status" != 0 ] && ! grep -q '^activate ' "$fixture/calls" || fail 'build failure activated an incomplete release' ;;
  esac
  pass "source $scenario preserves the running instance, shares caches and selects the correct activation mode"
done

(
  RSM_ROOT="$RSM_TEST_TMP/new source"
  RSM_BUILD_ROOT="$RSM_TEST_TMP/original instance"
  . "$RSM_TEST_ROOT/scripts/lib/toolchain.sh"
  [ "$TOOLS_DIR" = "$RSM_BUILD_ROOT/.tools" ] && [ "$CACHE_DIR" = "$RSM_BUILD_ROOT/.cache" ]
) || fail 'source upgrades discarded the original instance toolchain and build caches'
pass 'source upgrades reuse toolchains and build caches inside the original instance'

proxy_case() (
  local scenario="$1" fixture="$RSM_TEST_TMP/proxy-$1"
  CACHE_DIR="$fixture"
  mkdir -p "$CACHE_DIR"
  unset GOPROXY GOSUMDB
  curl() {
    printf '%s\n' "$*" >>"$fixture/requests"
    case "$scenario:$*" in
      cn:*goproxy.cn*|failure-cache:*|success-cache:*) return 0 ;;
      http-error:*goproxy.cn*)
        case " $* " in *' -fsSL '*) return 22 ;; *) return 0 ;; esac ;;
      http-error:*proxy.golang.org*) return 0 ;;
      alternate:*goproxy.io*) return 0 ;;
      *) return 28 ;;
    esac
  }
  case "$scenario" in
    explicit)
      export GOPROXY='https://company.invalid|direct' GOSUMDB='company-checksum.invalid'
      setup_go_env
      [ "$GOPROXY" = 'https://company.invalid|direct' ] && [ "$GOSUMDB" = company-checksum.invalid ] && [ ! -f "$fixture/requests" ] ;;
    failure-cache)
      printf '%s 0\n' "$(($(date +%s)-61))" >"$CACHE_DIR/probe-stale"
      probe_cached stale https://test.invalid && [ -f "$fixture/requests" ] ;;
    success-cache)
      probe_cached current https://test.invalid
      probe_cached current https://test.invalid
      [ "$(wc -l <"$fixture/requests" | tr -d ' ')" = 1 ] ;;
    *)
      setup_go_env
      [ "$GOSUMDB" = sum.golang.org ] || exit 1
      case "$scenario:$GOPROXY" in
        cn:https://goproxy.cn\|*) [ "$(wc -l <"$fixture/requests" | tr -d ' ')" = 1 ] ;;
        http-error:https://proxy.golang.org\|*|alternate:https://goproxy.io\|*) : ;;
        *) exit 1 ;;
      esac ;;
  esac
)
for scenario in cn http-error alternate explicit failure-cache success-cache; do
  proxy_case "$scenario" || fail "Go proxy selection or bounded probe caching failed: $scenario"
  pass "Go proxy selection preserves checksum validation and handles $scenario"
done

toolchain_case() (
  local action="$1" fixture="$RSM_TEST_TMP/pnpm $1" status=0
  mkdir -p "$fixture/tools/node/bin" "$fixture/tools/go/bin" "$fixture/tools/pnpm/node_modules/.bin" "$fixture/system"
  TOOLS_DIR="$fixture/tools"
  TOOLCHAIN_ENV_FILE="$TOOLS_DIR/toolchain.env"
  CACHE_DIR="$fixture/cache"
  export RSM_TEST_NODE_VERSION="$(tc_node_version)"
  export RSM_TEST_PNPM_VERSION="$(tc_pnpm_version)"
  export RSM_TEST_GO_VERSION="$(tc_go_version)"
  export RSM_TEST_NPM_CALLED="$fixture/npm-called"
  cat >"$TOOLS_DIR/node/bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'v%s\n' "$RSM_TEST_NODE_VERSION"
EOF
  cat >"$TOOLS_DIR/go/bin/go" <<'EOF'
#!/usr/bin/env bash
printf 'go version go%s linux/amd64\n' "$RSM_TEST_GO_VERSION"
EOF
  cat >"$TOOLS_DIR/node/bin/npm" <<'EOF'
#!/usr/bin/env bash
touch "$RSM_TEST_NPM_CALLED"
exit 1
EOF
  cat >"$fixture/system/node" <<'EOF'
#!/usr/bin/env bash
printf 'v22.23.2\n'
EOF
  cat >"$TOOLS_DIR/pnpm/node_modules/.bin/pnpm" <<'EOF'
#!/usr/bin/env bash
[ "$(node --version)" = "v$RSM_TEST_NODE_VERSION" ] || exit 1
if [ "${PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS:-true}" = false ]; then
  printf '%s\n' "$RSM_TEST_PNPM_VERSION"
else
  printf '11.2.2\n'
fi
EOF
  chmod +x "$TOOLS_DIR/node/bin/"* "$TOOLS_DIR/go/bin/go" "$TOOLS_DIR/pnpm/node_modules/.bin/pnpm" "$fixture/system/node"
  export PATH="$fixture/system:$PATH"
  export PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=true
  RSM_GO_BIN="$TOOLS_DIR/go/bin/go"
  RSM_NODE_BIN="$TOOLS_DIR/node/bin/node"
  RSM_NPM_BIN="$TOOLS_DIR/node/bin/npm"
  RSM_PNPM_BIN="$TOOLS_DIR/pnpm/node_modules/.bin/pnpm"
  setup_build_cache_env
  case "$action" in
    reuse) ensure_pnpm ;;
    cached) save_toolchain_env; load_toolchain_env || status=$? ;;
  esac
  [ "$status" = 0 ] && [ "$RSM_PNPM_BIN" = "$TOOLS_DIR/pnpm/node_modules/.bin/pnpm" ] && [ ! -f "$RSM_TEST_NPM_CALLED" ]
)
toolchain_case reuse >"$RSM_TEST_TMP/pnpm-reuse.log" 2>&1 || fail 'a parent pnpm pin or system Node displaced the existing project toolchain'
pass 'project pnpm uses the selected Node and ignores inherited version switching without reinstalling'
toolchain_case cached >"$RSM_TEST_TMP/pnpm-cached.log" 2>&1 || fail 'cached toolchain validation used a foreign pnpm or Node version'
pass 'cached project toolchain validates despite a conflicting parent pnpm pin and system Node'

apt_case() (
  local scenario="$1" expected="$2" fixture="$RSM_TEST_TMP/apt-$1" status=0
  mkdir -p "$fixture/bin"
  export RSM_TEST_APT_SCENARIO="$scenario"
  export RSM_TEST_APT_FIXTURE="$fixture"
  cat >"$fixture/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$RSM_TEST_APT_FIXTURE/calls"
case " $* " in
  *' update '*) touch "$RSM_TEST_APT_FIXTURE/refreshed"; exit 0 ;;
  *' --simulate '*)
    case "$RSM_TEST_APT_SCENARIO" in
      refresh|refresh-upgrade)
        [ -f "$RSM_TEST_APT_FIXTURE/refreshed" ] || { printf 'E: stale package index\n'; exit 100; } ;;
      unavailable) printf 'E: unable to resolve dependencies\n'; exit 100 ;;
    esac
    case "$RSM_TEST_APT_SCENARIO" in
      upgrade|refresh-upgrade) printf 'Inst libc6 [2.36-1] (2.36-2 Debian:12 [amd64])\n' ;;
      remove) printf 'Remv shared-service [1.0]\n' ;;
      configure) printf 'Conf shared-service (1.0 Debian:12 [amd64])\n' ;;
      *) printf 'Inst gcc (4:12.2.0-3 Debian:12 [amd64])\nConf gcc (4:12.2.0-3 Debian:12 [amd64])\n' ;;
    esac
    exit 0 ;;
esac
[ "${NEEDRESTART_MODE:-}" = l ] || exit 90
case " $* " in *' --no-remove '*) ;; *) exit 91 ;; esac
case " $* " in *' --no-upgrade '*) ;; *) exit 92 ;; esac
touch "$RSM_TEST_APT_FIXTURE/installed"
EOF
  chmod +x "$fixture/bin/apt-get"
  export PATH="$fixture/bin:$PATH"
  RSM_LOG_FILE="$fixture/details.log"
  pkg_manager() { printf apt; }
  id() { printf '0\n'; }
  pkg_install build-essential >"$fixture/output" 2>&1 || status=$?
  case "$expected" in
    installed) [ "$status" = 0 ] && [ -f "$fixture/installed" ] ;;
    blocked) [ "$status" != 0 ] && [ ! -f "$fixture/installed" ] ;;
  esac
)
apt_case new installed || fail 'safe installation of missing Debian packages failed'
pass 'missing Debian packages install after simulation with upgrades, removals and automatic service restarts disabled'
for scenario in upgrade remove configure; do
  apt_case "$scenario" blocked || fail "Debian package plan allowed $scenario of existing system packages"
  pass "Debian package installation blocks $scenario of existing system packages before execution"
done
apt_case refresh installed || fail 'safe Debian installation failed after refreshing a stale package index'
pass 'Debian package index refresh is followed by a new safe installation plan'
apt_case refresh-upgrade blocked || fail 'package index refresh bypassed the existing-package protection'
pass 'refreshed Debian package plan still blocks dependency upgrades'
apt_case unavailable blocked || fail 'Debian packages installed without a valid simulation'
pass 'unresolved Debian package plans never proceed to installation'

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
