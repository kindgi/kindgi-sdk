#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Decision-path tests for upgrade.sh, with gcloud / terraform / docker / kindgi
# / sleep stubbed on PATH (jq is real). No cloud calls, no credentials. Run it:
#
#     deploy/gcp-cloud-run/tests/upgrade_test.sh
#
# It exercises: the happy path, the version floor, already-at-target, a failed
# check, a refused plan, a failed apply, a start that never comes up, and a
# host instance that isn't Postgres 16 — asserting the exit code, key output,
# and that nothing is exported or applied when a check or the plan stops it.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../upgrade.sh"
[[ -f $SCRIPT ]] || { echo "can't find $SCRIPT" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"
OUT="$TMP/out.txt"

DIGEST="sha256:$(printf '%064d' 0)"
REPO="northamerica-northeast2-docker.pkg.dev/demo-proj/kindgi-images"
RUNNING_IMAGE="$REPO/runtime@$DIGEST"

# --- stubs ------------------------------------------------------------------

cat >"$BIN/gcloud" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "run services describe"*)
    if [[ "$*" == *"--format=json"* ]]; then printf '%s' "${STUB_SERVICE_JSON:-}"; else printf '%s\n' "${STUB_RUNNING_IMAGE:-}"; fi; exit 0 ;;
  "artifacts docker images list"*) printf '%s\n' "${STUB_TAGS:-}"; exit 0 ;;
  "sql instances describe"*)
    if [[ "$*" == *"databaseVersion"* ]]; then printf '%s\n' "${STUB_DB_VERSION:-POSTGRES_16}";
    elif [[ "$*" == *"ipv4Enabled"* ]]; then printf '%s\n' "${STUB_DB_PUBLIC:-True}";
    elif [[ "$*" == *"serviceAccountEmailAddress"* ]]; then printf 'p-sql@demo-proj.iam.gserviceaccount.com\n'; fi; exit 0 ;;
  "run jobs create"*) exit "${STUB_JOB_CREATE_RC:-0}" ;;
  "run jobs execute"*) exit "${STUB_CHECK_RC:-0}" ;;
  "run jobs delete"*) exit 0 ;;
  "storage buckets add-iam-policy-binding"*) exit 0 ;;
  "sql export sql"*) : >"${STUB_MARKER_EXPORT:-/dev/null}"; exit "${STUB_EXPORT_RC:-0}" ;;
  "auth configure-docker"*) exit 0 ;;
  *) exit 0 ;;
esac
STUB

cat >"$BIN/terraform" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  output) printf '%s' "${STUB_TF_OUTPUTS:-}"; exit 0 ;;
  console) cat >/dev/null; printf '%s\n' "${STUB_TF_VARS_RAW:-}"; exit 0 ;;
  plan)
    out=""
    for a in "$@"; do case "$a" in -out=*) out="${a#-out=}" ;; esac; done
    [[ -n $out ]] && : >"$out"
    exit "${STUB_PLAN_RC:-0}" ;;
  apply) : >"${STUB_MARKER_APPLY:-/dev/null}"; exit "${STUB_APPLY_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "buildx imagetools create"*) exit "${STUB_MIRROR_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/kindgi"
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/sleep"
chmod +x "$BIN"/*

export PATH="$BIN:$PATH"

# --- fixtures ---------------------------------------------------------------

VAR_FILE="$TMP/dev.tfvars"
: >"$VAR_FILE"

TF_OUTPUTS=$(cat <<JSON
{"image_repository":{"value":"$REPO"},
 "sql_connection_name":{"value":"demo-proj:northamerica-northeast2:kindgi"},
 "service_accounts":{"value":{"server":"kindgi-server@demo-proj.iam.gserviceaccount.com","pack":null}},
 "server_url":{"value":"https://kindgi-server-xxx.a.run.app"}}
JSON
)

# A vars object, HCL-quoted the way `terraform console` renders jsonencode().
vars_raw() { jq -n --arg s "$1" '$s'; }

vars_own_instance=$(jq -cn --arg img "$RUNNING_IMAGE" '{
  project_id:"demo-proj", region:"northamerica-northeast2", name_prefix:"kindgi",
  database_host_instance:null, database_name:"kindgi", secrets_backend:"postgres",
  tenancy:"single", database_private_network:"", server_image:$img, pack_image:"",
  database_instance:null}')

vars_host_instance=$(jq -cn --arg img "$RUNNING_IMAGE" '{
  project_id:"demo-proj", region:"northamerica-northeast2", name_prefix:"kindgi",
  database_host_instance:"app-db", database_name:"kindgi", secrets_backend:"postgres",
  tenancy:"single", database_private_network:"", server_image:$img, pack_image:"",
  database_instance:null}')

SERVICE_READY='{"terminalCondition":{"state":"CONDITION_SUCCEEDED"},"latestReadyRevision":"kindgi-server-00002","latestCreatedRevision":"kindgi-server-00002"}'
SERVICE_STUCK='{"terminalCondition":{"state":"CONDITION_PENDING"},"latestReadyRevision":"kindgi-server-00001","latestCreatedRevision":"kindgi-server-00002"}'

# --- harness ----------------------------------------------------------------

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$*"; }

reset_env() {
  unset STUB_RUNNING_IMAGE STUB_TAGS STUB_SERVICE_JSON STUB_DB_VERSION STUB_DB_PUBLIC \
        STUB_JOB_CREATE_RC STUB_CHECK_RC STUB_EXPORT_RC STUB_PLAN_RC STUB_APPLY_RC \
        STUB_MIRROR_RC STUB_TF_OUTPUTS STUB_TF_VARS_RAW STUB_MARKER_EXPORT STUB_MARKER_APPLY
  export STUB_TF_OUTPUTS="$TF_OUTPUTS"
  export STUB_RUNNING_IMAGE="$RUNNING_IMAGE"
  export STUB_SERVICE_JSON="$SERVICE_READY"
  export STUB_TF_VARS_RAW; STUB_TF_VARS_RAW="$(vars_raw "$vars_own_instance")"
  export STUB_MARKER_EXPORT="$TMP/exported"; rm -f "$STUB_MARKER_EXPORT"
  export STUB_MARKER_APPLY="$TMP/applied"; rm -f "$STUB_MARKER_APPLY"
}

run() { # $1 = stdin (the plan confirmation); rest = script args
  local confirm="$1"; shift
  "$SCRIPT" "$@" >"$OUT" 2>&1 <<<"$confirm"
  rc=$?
}

ARGS=(--var-file "$VAR_FILE" --runtime-digest "$DIGEST" --backup-bucket "gs://backups/dev")

case_start() { printf '• %s\n' "$1"; }
assert_rc()      { if [[ $rc -eq $1 ]]; then pass; else fail "$2 (rc=$rc, wanted $1)"; fi; }
assert_out()     { if grep -qi -- "$1" "$OUT"; then pass; else fail "output missing /$1/"; fi; }
assert_absent()  { if [[ ! -e $1 ]]; then pass; else fail "$2 happened but shouldn't have"; fi; }
assert_present() { if [[ -e $1 ]]; then pass; else fail "$2 should have happened"; fi; }

# 1. Happy path: 0.1.8 -> 0.1.10, own instance, no pack, confirm yes.
case_start "happy path"
reset_env; export STUB_TAGS="0.1.8"
run "yes" "${ARGS[@]}"
assert_rc 0 "happy path exits 0"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.1.8 -> 0.1.10 applied"

# 2. Below the floor: 0.1.7 is refused, nothing backed up.
case_start "below floor"
reset_env; export STUB_TAGS="0.1.7"
run "yes" "${ARGS[@]}"
assert_rc 1 "floor refused"
assert_out "upgrades from 0.1.8"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 3. Already at/past the target.
case_start "already at target"
reset_env; export STUB_TAGS="0.1.10"
run "yes" "${ARGS[@]}"
assert_rc 1 "already at target"
assert_out "already on"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 4. A check fails: stop before the backup, say so.
case_start "a check fails"
reset_env; export STUB_TAGS="0.1.8" STUB_CHECK_RC=1
run "yes" "${ARGS[@]}"
assert_rc 1 "check failure stops it"
assert_out "checks failed"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 5. Plan refused: operator types no — backup taken, nothing applied.
case_start "plan refused"
reset_env; export STUB_TAGS="0.1.8"
run "no" "${ARGS[@]}"
assert_rc 1 "refusal stops it"
assert_out "not confirmed"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 6. Apply fails: the go-back instructions are printed.
case_start "apply fails"
reset_env; export STUB_TAGS="0.1.8" STUB_APPLY_RC=1
run "yes" "${ARGS[@]}"
assert_rc 1 "apply failure"
assert_out "To go back"
assert_out "import sql"

# 7. The new revision never becomes ready: go-back printed.
case_start "start never ready"
reset_env; export STUB_TAGS="0.1.8" STUB_SERVICE_JSON="$SERVICE_STUCK"
run "yes" "${ARGS[@]}"
assert_rc 1 "unhealthy start"
assert_out "did not become ready"
assert_out "fresh database"

# 8. Host instance not Postgres 16: a check fails, nothing backed up.
case_start "host instance not pg16"
reset_env; export STUB_TAGS="0.1.8" STUB_DB_VERSION="POSTGRES_15"
STUB_TF_VARS_RAW="$(vars_raw "$vars_host_instance")"
run "yes" "${ARGS[@]}"
assert_rc 1 "pg15 host refused"
assert_out "Postgres 16"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
