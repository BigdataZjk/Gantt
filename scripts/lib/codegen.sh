#!/usr/bin/env bash

codegen_fingerprint() {
  local file digest
  for file in api/openapi.yaml scripts/generate.sh scripts/lib/codegen.sh scripts/toolchain.json internal/server/types.gen.go web/src/api/types.gen.ts; do
    [ -s "$RSM_ROOT/$file" ] || return 1
    digest=$(sha256_file "$RSM_ROOT/$file") || return 1
    printf '%s  %s\n' "$digest" "$file"
  done
}

codegen_current() {
  local fingerprint
  [ -f "$RSM_ROOT/api/generated.sha256" ] || return 1
  fingerprint=$(codegen_fingerprint) || return 1
  [ "$fingerprint" = "$(cat "$RSM_ROOT/api/generated.sha256")" ]
}

codegen_record() {
  local fingerprint
  fingerprint=$(codegen_fingerprint) || return 1
  printf '%s\n' "$fingerprint" | atomic_write "$RSM_ROOT/api/generated.sha256" 644
}
