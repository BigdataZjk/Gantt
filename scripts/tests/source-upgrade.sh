#!/usr/bin/env bash
set -eu
set -o pipefail

RSM_TEST_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
RSM_TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rsm-source-tests.XXXXXX")
trap 'rm -rf "$RSM_TEST_TMP"' EXIT
passed=0
pass() { passed=$((passed+1)); printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

make_zip() (
  local destination="$1" version="$2" kind="${3:-normal}" tree prefix=rsm/
  local fixture="$RSM_TEST_TMP/fixture-$version-$kind"
  mkdir -p "$fixture/api" "$fixture/cmd/rsm" "$fixture/web" "$fixture/scripts"
  touch "$fixture/go.mod" "$fixture/api/openapi.yaml" "$fixture/api/generated.sha256" "$fixture/cmd/rsm/main.go" "$fixture/web/pnpm-lock.yaml" "$fixture/scripts/toolchain.json" "$fixture/rsm.sh"
  printf '{\n  "version": "%s"\n}\n' "$version" >"$fixture/web/package.json"
  cat >"$fixture/scripts/bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
printf 'bootstrap %s\n' "$RSM_BUILD_ROOT" >>"$RSM_TEST_CALLS"
EOF
  cat >"$fixture/scripts/build.sh" <<'EOF'
#!/usr/bin/env bash
printf 'build %s %s\n' "$RSM_BUILD_ROOT" "$RSM_VERSION" >>"$RSM_TEST_CALLS"
[ "${RSM_TEST_BUILD_FAIL:-0}" = 0 ] || exit 9
root=$(cd "$(dirname "$0")/.." && pwd -P)
mkdir -p "$root/build"
touch "$root/build/package.tar.gz"
printf '%s/build/package.tar.gz\n' "$root" >"$root/build/package.path"
EOF
  chmod +x "$fixture/scripts/"*.sh
  case "$kind" in
    traversal) prefix=rsm/../ ;;
    symlink) ln -s ../../outside "$fixture/link" ;;
    incomplete) rm "$fixture/go.mod" ;;
  esac
  git -C "$fixture" init -q
  git -C "$fixture" add .
  tree=$(git -C "$fixture" write-tree)
  git -C "$fixture" archive --format=zip --prefix="$prefix" --output="$destination" "$tree"
)

make_zip "$RSM_TEST_TMP/new.zip" 0.1.1
make_zip "$RSM_TEST_TMP/traversal.zip" 0.1.1 traversal
make_zip "$RSM_TEST_TMP/symlink.zip" 0.1.1 symlink
make_zip "$RSM_TEST_TMP/incomplete.zip" 0.1.1 incomplete
make_zip "$RSM_TEST_TMP/0.1.9.zip" 0.1.9
make_zip "$RSM_TEST_TMP/0.1.10.zip" 0.1.10
make_zip "$RSM_TEST_TMP/ambiguous.zip" 0.1.10 incomplete

source_case() (
  local scenario="$1" file="$RSM_TEST_TMP/new.zip" fixture="$RSM_TEST_TMP/$1"
  RSM_ROOT="$RSM_TEST_ROOT"
  RSM_HOME="$fixture/instance with space"
  export RSM_TEST_CALLS="$fixture/calls"
  mkdir -p "$RSM_HOME/data"
  printf 'business data' >"$RSM_HOME/data/preserved"
  . "$RSM_TEST_ROOT/scripts/lib/common.sh"
  . "$RSM_TEST_ROOT/scripts/lib/toolchain.sh"
  . "$RSM_TEST_ROOT/scripts/lib/release.sh"
  . "$RSM_TEST_ROOT/scripts/lib/source.sh"
  trap source_cleanup EXIT
  ensure_layout() { :; }
  resolve_addr() { :; }
  instance_installed() { [ "$scenario" != fresh ]; }
  installed_version() {
    case "$scenario" in
      fresh) return 1 ;;
      same|force) printf 0.1.1 ;;
      older|old-auto|old-upgrade) printf 0.1.2 ;;
      *) printf 0.1.0 ;;
    esac
  }
  start_instance() { printf 'start-current\n' >>"$RSM_TEST_CALLS"; }
  ensure_download_tools() { :; }
  persist_addr_if_explicit() { :; }
  current_release_dir() { printf '%s/current' "$RSM_HOME"; }
  print_deploy_summary() { :; }
  resolve_package() { PKG_ROOT="$SOURCE_ROOT"; }
  prepare_release_dir() { CANDIDATE_DIR="$RSM_HOME/candidate"; }
  deploy_activate() { printf 'activate %s\n' "$2" >>"$RSM_TEST_CALLS"; }
  case "$scenario" in
    auto|default|old-auto|old-upgrade)
      mkdir -p "$RSM_HOME/upgrade"
      cp "$file" "$RSM_HOME/upgrade/arbitrary-name.zip"
      file="" ;;
    empty-upgrade) file="" ;;
    force) RSM_FORCE=1 ;;
    failure) export RSM_TEST_BUILD_FAIL=1 ;;
    traversal|symlink|incomplete) file="$RSM_TEST_TMP/$scenario.zip" ;;
    corrupt) file="$fixture/corrupt.zip"; head -c 40 "$RSM_TEST_TMP/new.zip" >"$file" ;;
    checksum) file="$fixture/checksum.zip"; cp "$RSM_TEST_TMP/new.zip" "$file"; printf 'incorrect\n' >"$file.sha256" ;;
    mislabeled) file="$fixture/rsm-source-9.0.0.zip"; cp "$RSM_TEST_TMP/new.zip" "$file" ;;
  esac
  if [ "$scenario" = default ] || [ "$scenario" = empty ] || [ "$scenario" = old-auto ]; then
    RSM_ROOT="$RSM_HOME"
    deploy_cmd >"$fixture/output" 2>&1
  else
    upgrade_cmd "$file" >"$fixture/output" 2>&1
  fi
)

for scenario in fresh existing auto default force mislabeled; do
  source_case "$scenario" || { cat "$RSM_TEST_TMP/$scenario/output"; fail "$scenario"; }
  fixture="$RSM_TEST_TMP/$scenario"
  if [ "$scenario" = fresh ]; then mode=deploy; else mode=upgrade; fi
  grep -Fxq "activate $mode" "$fixture/calls" || { cat "$fixture/output"; fail "$scenario wrong activation mode"; }
  grep -Fxq "build $fixture/instance with space 0.1.1" "$fixture/calls" || fail "$scenario lost tools/cache/version context"
  [ "$(cat "$fixture/instance with space/data/preserved")" = 'business data' ] || fail "$scenario touched business data"
  [ -z "$(find "$fixture/instance with space/.cache" -name 'source-upgrade.*' -type d)" ] || fail "$scenario leaked extraction workspace"
  pass "$scenario ZIP deploys through the existing activation path and cleans its workspace"
done

source_case same || fail 'same version failed'
! grep -Eq '^(build|activate) ' "$RSM_TEST_TMP/same/calls" || fail 'same version rebuilt or stopped the service'
pass 'same version exits successfully without rebuilding or restarting'

source_case empty || fail 'empty upgrade directory prevented normal startup'
grep -Fxq 'start-current' "$RSM_TEST_TMP/empty/calls" || fail 'empty upgrade directory did not start current version'
pass 'default entry starts the installed version when upgrade directory is empty'

source_case old-auto || fail 'older inbox package prevented normal startup'
! grep -Eq '^(build|activate) ' "$RSM_TEST_TMP/old-auto/calls" || fail 'old inbox package downgraded current version'
pass 'automatic entry ignores older inbox packages and keeps the installed version'

for scenario in empty-upgrade old-upgrade; do
  source_case "$scenario" || fail "$scenario prevented normal startup"
  grep -Fxq 'start-current' "$RSM_TEST_TMP/$scenario/calls" || fail "$scenario did not start the current version"
  ! grep -Eq '^(build|activate) ' "$RSM_TEST_TMP/$scenario/calls" || fail "$scenario unexpectedly deployed"
  pass "$scenario keeps the installed version without rebuilding or restarting"
done

for scenario in older failure traversal symlink incomplete corrupt checksum; do
  if source_case "$scenario"; then cat "$RSM_TEST_TMP/$scenario/output"; fail "$scenario unexpectedly succeeded"; fi
  fixture="$RSM_TEST_TMP/$scenario"
  if [ -f "$fixture/calls" ] && grep -q '^activate ' "$fixture/calls"; then fail "$scenario activated a bad release"; fi
  [ "$(cat "$fixture/instance with space/data/preserved")" = 'business data' ] || fail "$scenario touched business data"
  [ -z "$(find "$fixture/instance with space/.cache" -name 'source-upgrade.*' -type d)" ] || fail "$scenario leaked extraction workspace"
  pass "$scenario fails before activation and preserves existing data"
done

(
  . "$RSM_TEST_ROOT/scripts/lib/common.sh"
  . "$RSM_TEST_ROOT/scripts/lib/source.sh"
  RSM_HOME="$RSM_TEST_TMP/selection"
  trap source_cleanup EXIT
  mkdir -p "$RSM_HOME/upgrade"
  cp "$RSM_TEST_TMP/0.1.9.zip" "$RSM_HOME/upgrade/z-9.0.0.zip"
  cp "$RSM_TEST_TMP/0.1.10.zip" "$RSM_HOME/upgrade/a-0.0.1.zip"
  touch "$RSM_HOME/upgrade/new.zip.part" "$RSM_HOME/upgrade/unrelated.zip"
  ln -s "$RSM_TEST_TMP/new.zip" "$RSM_HOME/upgrade/link.zip"
  select_source_zip >/dev/null
  [ "$UPGRADE_INPUT" = "$RSM_HOME/upgrade/a-0.0.1.zip" ]
) || fail 'automatic package selection'
pass 'automatic selection uses numeric versions inside ZIPs and ignores filenames, partial uploads and links'

if (
  . "$RSM_TEST_ROOT/scripts/lib/common.sh"
  . "$RSM_TEST_ROOT/scripts/lib/source.sh"
  trap source_cleanup EXIT
  RSM_HOME="$RSM_TEST_TMP/selection"
  cp "$RSM_TEST_TMP/ambiguous.zip" "$RSM_HOME/upgrade/duplicate.zip"
  select_source_zip >/dev/null 2>&1
); then fail 'different archives with the same highest version were silently selected'; fi
pass 'ambiguous highest-version archives fail without selecting either package'

printf '\n%s source ZIP upgrade checks passed.\n' "$passed"
