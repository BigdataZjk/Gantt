#!/usr/bin/env bash
set -eu
set -o pipefail

RSM_TEST_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
RSM_TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rsm-codegen-tests.XXXXXX")
trap 'rm -rf "$RSM_TEST_TMP"' EXIT
passed=0
pass() { passed=$((passed+1)); printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

RSM_ROOT="$RSM_TEST_TMP/source with space"
export RSM_TEST_CALLS="$RSM_TEST_TMP/calls"
mkdir -p "$RSM_ROOT/api" "$RSM_ROOT/scripts/lib" "$RSM_ROOT/internal/server" "$RSM_ROOT/web/src/api" "$RSM_ROOT/bin"
cp "$RSM_TEST_ROOT/scripts/generate.sh" "$RSM_ROOT/scripts/"
cp "$RSM_TEST_ROOT/scripts/lib/common.sh" "$RSM_TEST_ROOT/scripts/lib/codegen.sh" "$RSM_ROOT/scripts/lib/"
cp "$RSM_TEST_ROOT/scripts/toolchain.json" "$RSM_ROOT/scripts/"
printf 'openapi: 3.0.3\n' >"$RSM_ROOT/api/openapi.yaml"
printf 'package server\n' >"$RSM_ROOT/internal/server/types.gen.go"
printf 'export {}\n' >"$RSM_ROOT/web/src/api/types.gen.ts"
cat >"$RSM_ROOT/scripts/lib/toolchain.sh" <<'EOF'
CACHE_DIR="$RSM_ROOT/.cache"
ensure_toolchain() {
  printf 'toolchain\n' >>"$RSM_TEST_CALLS"
  RSM_GO_BIN="$RSM_ROOT/bin/generator"
  RSM_PNPM_BIN="$RSM_ROOT/bin/generator"
}
tc_oapi_codegen() { printf v2.8.2; }
tc_openapi_ts() { printf 7.13.0; }
EOF
cat >"$RSM_ROOT/bin/generator" <<'EOF'
#!/usr/bin/env bash
printf 'generator\n' >>"$RSM_TEST_CALLS"
if [ "${RSM_TEST_GENERATOR_FAIL:-0}" = 1 ]; then exit 1; fi
kind="$1"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    if [ "$kind" = run ]; then printf 'package server\n' >"$2"
    else printf 'export {}\n' >"$2"; fi
    exit 0
  fi
  shift
done
exit 1
EOF
chmod +x "$RSM_ROOT/bin/generator"
. "$RSM_ROOT/scripts/lib/common.sh"
. "$RSM_ROOT/scripts/lib/codegen.sh"

run_generator() { bash "$RSM_ROOT/scripts/generate.sh" "$@" >"$RSM_TEST_TMP/output" 2>&1; }

codegen_record
run_generator --ensure || fail 'verified source types could not be reused'
[ ! -f "$RSM_TEST_CALLS" ] || fail 'verified types still invoked a toolchain or generator'
pass 'verified types reuse without preparing a toolchain or invoking generators'

for change in missing-manifest contract go-output ts-output generator-script helper-script toolchain-version; do
  case "$change" in
    missing-manifest) rm "$RSM_ROOT/api/generated.sha256" ;;
    contract) printf 'info: {}\n' >>"$RSM_ROOT/api/openapi.yaml" ;;
    go-output) printf '// stale\n' >>"$RSM_ROOT/internal/server/types.gen.go" ;;
    ts-output) rm "$RSM_ROOT/web/src/api/types.gen.ts" ;;
    generator-script) printf '\n# revised generator\n' >>"$RSM_ROOT/scripts/generate.sh" ;;
    helper-script) printf '\n# revised verification\n' >>"$RSM_ROOT/scripts/lib/codegen.sh" ;;
    toolchain-version) printf '\n' >>"$RSM_ROOT/scripts/toolchain.json" ;;
  esac
  rm -f "$RSM_TEST_CALLS"
  run_generator --ensure || fail "$change did not regenerate successfully"
  [ -f "$RSM_TEST_CALLS" ] && codegen_current || fail "$change was accepted without regenerating and recording current inputs"
  pass "$change invalidates reuse and regenerates both outputs"
done

run_generator --check || fail 'forced generation check failed for current types'
pass 'check mode still runs generators and validates current outputs and manifest'
printf '# changed contract\n' >>"$RSM_ROOT/api/openapi.yaml"
cp "$RSM_ROOT/api/generated.sha256" "$RSM_TEST_TMP/manifest-before"
if run_generator --check; then fail 'check mode accepted an outdated manifest'; fi
cmp -s "$RSM_ROOT/api/generated.sha256" "$RSM_TEST_TMP/manifest-before" || fail 'check mode wrote the manifest'
pass 'check mode rejects stale verification without rewriting the manifest'

cp "$RSM_ROOT/internal/server/types.gen.go" "$RSM_TEST_TMP/go-before"
cp "$RSM_ROOT/web/src/api/types.gen.ts" "$RSM_TEST_TMP/ts-before"
if RSM_TEST_GENERATOR_FAIL=1 run_generator --ensure; then fail 'generator failure was ignored'; fi
cmp -s "$RSM_ROOT/api/generated.sha256" "$RSM_TEST_TMP/manifest-before" &&
  cmp -s "$RSM_ROOT/internal/server/types.gen.go" "$RSM_TEST_TMP/go-before" &&
  cmp -s "$RSM_ROOT/web/src/api/types.gen.ts" "$RSM_TEST_TMP/ts-before" || fail 'failed generation changed existing types or accepted a partial manifest'
if codegen_current; then fail 'failed generation was recorded as current'; fi
pass 'failed generation preserves previous types and manifest without accepting stale inputs'

printf '%s code generation regression checks passed\n' "$passed"
