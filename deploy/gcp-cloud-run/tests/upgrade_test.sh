#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Decision-path tests for upgrade.sh, with gcloud / terraform / docker / kindgi
# / sleep stubbed on PATH (jq is real). No cloud calls, no credentials. Run it:
#
#     deploy/gcp-cloud-run/tests/upgrade_test.sh
#
# The stubs answer only for the shapes the real tools return: the service read
# answers only for the v1 field path, the instance read returns gcloud's JSON,
# and the pack envelope has the fields `kindgi build` writes. Each case asserts
# the exit code, key output, and what was (or wasn't) mirrored, exported,
# applied and written to the var-file.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../upgrade.sh"
[[ -f $SCRIPT ]] || { echo "can't find $SCRIPT" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"

OLD_DIGEST="sha256:$(printf '%064d' 0)"
NEW_DIGEST="sha256:$(printf '%063d1' 0)"
REPO="northamerica-northeast2-docker.pkg.dev/demo-proj/kindgi-images"
RUNNING_IMAGE="$REPO/runtime@$OLD_DIGEST"
NEW_IMAGE="$REPO/runtime@$NEW_DIGEST"
OLD_PACK="$REPO/pack@sha256:$(printf '%064d' 2)"

# --- stubs ------------------------------------------------------------------

cat >"$BIN/gcloud" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "run services describe"*)
    if [[ "$*" == *"--format=json"* ]]; then printf '%s' "${STUB_SERVICE_JSON:-}"
    elif [[ "$*" == *"--format=value(spec.template.spec.containers[0].image)"* ]]; then printf '%s\n' "${STUB_RUNNING_IMAGE:-}"
    fi; exit 0 ;;
  "artifacts docker images list"*) printf '%s\n' "${STUB_TAGS:-}"; exit 0 ;;
  "sql instances describe"*)
    name="$4"
    jq -n --arg n "$name" --arg v "${STUB_DB_VERSION:-POSTGRES_16}" --argjson pub "${STUB_DB_PUBLIC:-true}" '{
      name: $n, connectionName: ("demo-proj:northamerica-northeast2:" + $n),
      serviceAccountEmailAddress: "p-sql@demo-proj.iam.gserviceaccount.com",
      databaseVersion: $v, settings: {ipConfiguration: {ipv4Enabled: $pub}}}'
    exit 0 ;;
  "run jobs create"*) printf '%s\n' "$*" >>"${STUB_JOBS_LOG:-/dev/null}"; exit "${STUB_JOB_CREATE_RC:-0}" ;;
  "run jobs execute"*) exit "${STUB_CHECK_RC:-0}" ;;
  "sql export sql"*) : >"${STUB_MARKER_EXPORT:-/dev/null}"; exit "${STUB_EXPORT_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

cat >"$BIN/terraform" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  output) printf '%s' "${STUB_TF_OUTPUTS:-}"; exit 0 ;;
  console) cat >/dev/null; printf '%s\n' "${STUB_TF_VARS_RAW:-}"; exit 0 ;;
  plan)
    for a in "$@"; do
      case "$a" in
        -out=*) : >"${a#-out=}" ;;
        -var-file=*) cp "${a#-var-file=}" "${STUB_PLAN_SAW:-/dev/null}" ;;
        -var) printf 'plan got -var\n' >>"${STUB_PLAN_SAW:-/dev/null}" ;;
      esac
    done
    exit "${STUB_PLAN_RC:-0}" ;;
  apply) : >"${STUB_MARKER_APPLY:-/dev/null}"; exit "${STUB_APPLY_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "buildx imagetools inspect"*)
    printf '%s\n' "$*" >>"${STUB_DOCKER_LOG:-/dev/null}"
    if [[ -n ${STUB_INSPECT_ERR:-} ]]; then printf '%s\n' "$STUB_INSPECT_ERR" >&2; exit 1; fi
    printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":1609}\n' "${STUB_RELEASE_DIGEST:-}"; exit 0 ;;
  "buildx imagetools create"*)
    printf '%s\n' "$*" >>"${STUB_DOCKER_LOG:-/dev/null}"
    : >"${STUB_MARKER_MIRROR:-/dev/null}"; exit "${STUB_MIRROR_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/kindgi"
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/sleep"
chmod +x "$BIN"/*

export PATH="$BIN:$PATH"

# --- fixtures ---------------------------------------------------------------

TF_OUTPUTS=$(cat <<JSON
{"image_repository":{"value":"$REPO"},
 "sql_connection_name":{"value":"demo-proj:northamerica-northeast2:kindgi"},
 "service_accounts":{"value":{"server":"kindgi-server@demo-proj.iam.gserviceaccount.com","pack":null}},
 "server_url":{"value":"https://kindgi-server-xxx.a.run.app"}}
JSON
)

# A vars object, HCL-quoted the way `terraform console` renders jsonencode().
vars_raw() { jq -n --arg s "$1" '$s'; }

# The module's variables; V_* override the small dev defaults.
mkvars() {
  jq -cn --arg img "$RUNNING_IMAGE" --arg net "${V_NET:-none}" --arg host "${V_HOST:-}" \
    --arg tenancy "${V_TENANCY:-single}" --arg pack "${V_PACK:-}" --arg aad "${V_AAD-1}" \
    --arg prefix "${V_PREFIX:-kindgi}" --argjson dbi "${V_DBI:-null}" '{
    project_id:"demo-proj", region:"northamerica-northeast2", name_prefix:$prefix,
    network_mode:$net, database_host_instance:(if $host == "" then null else $host end),
    database_name:"kindgi", secrets_backend:"postgres",
    secrets_aad_key_version:(if $aad == "" then null else $aad end),
    tenancy:$tenancy, server_image:$img, pack_image:$pack, database_instance:$dbi}'
}

SERVICE_READY='{"status":{"conditions":[{"type":"Ready","status":"True"}],"latestReadyRevisionName":"kindgi-server-00002","latestCreatedRevisionName":"kindgi-server-00002"}}'
SERVICE_STUCK='{"status":{"conditions":[{"type":"Ready","status":"Unknown"}],"latestReadyRevisionName":"kindgi-server-00001","latestCreatedRevisionName":"kindgi-server-00002"}}'

# --- harness ----------------------------------------------------------------

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$*"; }

# A fresh case directory, var-file and markers. $1 = a pack_image line to add.
reset_env() {
  unset STUB_TAGS STUB_DB_VERSION STUB_DB_PUBLIC STUB_JOB_CREATE_RC STUB_CHECK_RC \
        STUB_EXPORT_RC STUB_PLAN_RC STUB_APPLY_RC STUB_MIRROR_RC STUB_INSPECT_ERR \
        V_NET V_HOST V_TENANCY V_PACK V_AAD V_PREFIX V_DBI
  CASE_DIR="$(mktemp -d "$TMP/case.XXXXXX")"
  OUT="$CASE_DIR/out.txt"
  VAR_FILE="$CASE_DIR/dev.tfvars"
  {
    printf 'project_id   = "demo-proj"\n'
    printf '# the runtime, pinned by digest\n'
    printf 'server_image = "%s"  # mirrored 0.1.8\n' "$RUNNING_IMAGE"
    if [[ -n ${1:-} ]]; then printf 'pack_image   = "%s"\n' "$1"; fi
  } >"$VAR_FILE"
  cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
  export STUB_TF_OUTPUTS="$TF_OUTPUTS"
  export STUB_RUNNING_IMAGE="$RUNNING_IMAGE"
  export STUB_SERVICE_JSON="$SERVICE_READY"
  export STUB_RELEASE_DIGEST="$NEW_DIGEST"
  export STUB_DOCKER_LOG="$CASE_DIR/docker.log"
  export STUB_MARKER_EXPORT="$CASE_DIR/exported"
  export STUB_MARKER_APPLY="$CASE_DIR/applied"
  export STUB_MARKER_MIRROR="$CASE_DIR/mirrored"
  export STUB_PLAN_SAW="$CASE_DIR/plan-saw"
  export STUB_JOBS_LOG="$CASE_DIR/jobs.log"
  ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev")
}

run() { # $1 = stdin (the plan confirmation); rest = extra script args
  local confirm="$1"; shift
  export STUB_TF_VARS_RAW; STUB_TF_VARS_RAW="$(vars_raw "$(mkvars)")"
  "$SCRIPT" "${ARGS[@]}" "$@" >"$OUT" 2>&1 <<<"$confirm"
  rc=$?
}

case_start() { printf '• %s\n' "$1"; }
assert_rc()      { if [[ $rc -eq $1 ]]; then pass; else fail "$2 (rc=$rc, wanted $1)"; fi; }
assert_out()     { if grep -qi -- "$1" "$OUT"; then pass; else fail "output missing /$1/"; fi; }
assert_absent()  { if [[ ! -e $1 ]]; then pass; else fail "$2 happened but shouldn't have"; fi; }
assert_present() { if [[ -e $1 ]]; then pass; else fail "$2 should have happened"; fi; }
assert_file_has() { if grep -qF -- "$2" "$1" 2>/dev/null; then pass; else fail "$3: $1 lacks \"$2\""; fi; }
assert_varfile_unchanged() {
  if cmp -s "$VAR_FILE" "$CASE_DIR/original.tfvars"; then pass; else fail "the var-file changed but shouldn't have"; fi
}

# 1. Happy path: 0.1.8 -> 0.1.11, own instance, no pack, confirm yes.
case_start "happy path"
reset_env; export STUB_TAGS="0.1.8"
run "yes"
assert_rc 0 "happy path exits 0"
assert_present "$STUB_MARKER_MIRROR" "mirror"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.1.8 -> 0.1.11 applied"
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"  # mirrored 0.1.8" "var-file pins the new image, comment kept"
assert_file_has "$STUB_PLAN_SAW" "$NEW_IMAGE" "the plan read the new image from the var-file"
if grep -q "plan got -var" "$STUB_PLAN_SAW"; then fail "plan was given -var"; else pass; fi
if cmp -s "$(ls "$CASE_DIR"/dev.tfvars.pre-upgrade-*)" "$CASE_DIR/original.tfvars"; then pass; else fail "no .pre-upgrade copy of the original"; fi

# 2. Below the floor: 0.1.7 is refused, nothing mirrored or backed up.
case_start "below floor"
reset_env; export STUB_TAGS="0.1.7"
run "yes"
assert_rc 1 "floor refused"
assert_out "upgrades from 0.1.8"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 3. Already at the target.
case_start "already at target"
reset_env; export STUB_TAGS="0.1.11"
run "yes"
assert_rc 1 "already at target"
assert_out "already on 0.1.11"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 4. A runtime check fails: stop before the backup, say so.
case_start "a check fails"
reset_env; export STUB_TAGS="0.1.8" STUB_CHECK_RC=1
run "yes"
assert_rc 1 "check failure stops it"
assert_out "checks failed"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 5. Plan refused: backup taken, nothing applied, the var-file put back.
case_start "plan refused"
reset_env; export STUB_TAGS="0.1.8"
run "no"
assert_rc 1 "refusal stops it"
assert_out "not confirmed"
assert_out "put back"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 6. Apply fails: the go-back is printed, the var-file keeps the new image.
case_start "apply fails"
reset_env; export STUB_TAGS="0.1.8" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_out "To go back"
assert_out "memory erasures export"
assert_out "import sql"
assert_out "memory erasures replay"
assert_out "cp $VAR_FILE.pre-upgrade-"
if grep -q "or set database_name" "$OUT"; then fail "go-back still offers database_name"; else pass; fi
assert_file_has "$VAR_FILE" "$NEW_IMAGE" "var-file keeps the new image after a failed apply"

# 7. The new revision never becomes ready: go-back printed.
case_start "start never ready"
reset_env; export STUB_TAGS="0.1.8" STUB_SERVICE_JSON="$SERVICE_STUCK"
run "yes"
assert_rc 1 "unhealthy start"
assert_out "did not become ready"
assert_out "fresh database"

# 8. Host instance not Postgres 16: refused before anything is mirrored.
case_start "host instance not pg16"
reset_env; export STUB_TAGS="0.1.8" STUB_DB_VERSION="POSTGRES_15"; V_HOST="app-db"
run "yes"
assert_rc 1 "pg15 host refused"
assert_out "Postgres 16"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 9. An rc goes to its final.
case_start "rc to its final"
reset_env; export STUB_TAGS="0.1.11-rc.0"
run "yes"
assert_rc 0 "rc -> final runs"
assert_out "0.1.11-rc.0 -> 0.1.11 applied"

# 10. To an rc: its release's steps are included.
case_start "0.1.8 to an rc"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.1.11-rc.0
assert_rc 0 "to an rc runs"
assert_out "crossing: 0.1.9 0.1.10 0.1.11"
assert_out "autoCloseAfterInactiveSeconds"

# 11. An rc promoted to its final carries both tags: the final is the version.
case_start "rc and final tags on one digest"
reset_env; export STUB_TAGS="0.1.11-rc.0;0.1.11"
run "yes"
assert_rc 1 "final read from the two tags"
assert_out "already on 0.1.11,"

# 12. The release's tag isn't the digest given: refused before the mirror.
case_start "digest doesn't match the release tag"
reset_env; export STUB_TAGS="0.1.8" STUB_RELEASE_DIGEST="$OLD_DIGEST"
run "yes"
assert_rc 1 "mismatched digest refused"
assert_out "not the --runtime-digest"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 13. The var-file doesn't set server_image on one line: refused at the start.
case_start "var-file without a server_image line"
reset_env; export STUB_TAGS="0.1.8"
printf 'project_id = "demo-proj"\n' >"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes"
assert_rc 1 "no server_image line refused"
assert_out "must set server_image exactly once"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

# 14. The var-file isn't what's deployed: refused.
case_start "var-file doesn't match the running image"
reset_env; export STUB_TAGS="0.1.8" STUB_RUNNING_IMAGE="$REPO/runtime@sha256:$(printf '%064d' 9)"
run "yes"
assert_rc 1 "drift refused"
assert_out "Make the var-file match"
assert_absent "$STUB_MARKER_MIRROR" "mirror"

# 15. Not the small dev shape.
case_start "network_mode direct"
reset_env; export STUB_TAGS="0.1.8"; V_NET="direct"
run "yes"
assert_rc 1 "other network_mode refused"
assert_out "network_mode = \"none\""
assert_absent "$STUB_MARKER_MIRROR" "mirror"

# 16. A var-file from before secrets_aad_key_version: caught before the export.
case_start "no secrets_aad_key_version"
reset_env; export STUB_TAGS="0.1.8"; V_AAD=""
run "yes"
assert_rc 1 "missing aad key version refused"
assert_out "needs secrets_aad_key_version"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 17. A pack rebuild: the envelope's imageRef + imageDigest become a pinned
# pack_image (the tag dropped, a registry port kept) in the var-file.
case_start "pack rebuilt from the envelope"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.8"; V_PACK="$OLD_PACK"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR/.kindgi/build"
PACK_DIGEST="sha256:$(printf '%064d' 3)"
jq -n --arg d "$PACK_DIGEST" '{"$schema":"kindgi-deploy-envelope/v1",
  imageRef:"registry.local:5000/kindgi-images/pack:dev", imageDigest:$d}' \
  >"$PACK_DIR/.kindgi/build/deploy-envelope.json"
run "yes" --pack-dir "$PACK_DIR"
assert_rc 0 "pack rebuild runs"
assert_file_has "$VAR_FILE" "pack_image   = \"registry.local:5000/kindgi-images/pack@$PACK_DIGEST\"" "var-file pins the new pack"
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"" "var-file pins the new server"

# 18. Serving from a restored instance: the jobs mount that instance's socket
# and read its URL secret.
case_start "restored instance"
reset_env; export STUB_TAGS="0.1.8"; V_DBI='{"name":"kindgi-r1","url_secret":"kindgi-r1-database-url"}'
run "yes"
assert_rc 0 "restored instance runs"
assert_file_has "$STUB_JOBS_LOG" "--set-cloudsql-instances=demo-proj:northamerica-northeast2:kindgi-r1" "check job mounts the restored instance"
assert_file_has "$STUB_JOBS_LOG" "KINDGI_DATABASE_URL=kindgi-r1-database-url:latest" "check job reads the restored URL secret"

# 19. A long name_prefix: every check job name fits in 63 characters.
case_start "long name_prefix"
reset_env; export STUB_TAGS="0.1.8"; V_PREFIX="kindgi-a-very-long-prefix-for-a-shared-dev-project-xyz"
run "yes"
assert_rc 0 "long prefix runs"
long=0
while read -r _ _ _ name _; do
  if [[ ${#name} -gt 63 ]]; then long=1; fi
done <"$STUB_JOBS_LOG"
if [[ $long -eq 0 && -s $STUB_JOBS_LOG ]]; then pass; else fail "a check job name is over 63 characters"; fi

# 20. A .tfvars.json var-file is rewritten as JSON.
case_start "tfvars.json"
reset_env; export STUB_TAGS="0.1.8"
VAR_FILE="$CASE_DIR/dev.tfvars.json"
jq -n --arg img "$RUNNING_IMAGE" '{project_id:"demo-proj", server_image:$img}' >"$VAR_FILE"
ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev")
run "yes"
assert_rc 0 "json var-file runs"
if [[ "$(jq -r .server_image "$VAR_FILE")" == "$NEW_IMAGE" ]]; then pass; else fail "json var-file not rewritten"; fi

# 21. 0.1.10 -> 0.1.11: crosses 0.1.11 alone, copies it from registry.kindgi.com.
case_start "0.1.10 to 0.1.11"
reset_env; export STUB_TAGS="0.1.10"
run "yes"
assert_rc 0 "0.1.10 -> 0.1.11 runs"
assert_out "crossing: 0.1.11$"
assert_out "0.1.11:"
assert_out "Nothing to do by hand"
if grep -q "autoCloseAfterInactiveSeconds" "$OUT"; then fail "0.1.10's steps shown for 0.1.10 -> 0.1.11"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.1.11 " "the release tag is read on registry.kindgi.com"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.1.11@$NEW_DIGEST" "the mirror copies from registry.kindgi.com"
if grep -q "quay.io" "$STUB_DOCKER_LOG"; then fail "an image was read from quay.io"; else pass; fi
assert_out "0.1.10 -> 0.1.11 applied"

# 22. 0.1.10 -> an rc of 0.1.11: its steps are included, and it gets to the mirror.
case_start "0.1.10 to 0.1.11-rc.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.1.11-rc.0
assert_rc 0 "0.1.10 -> 0.1.11-rc.0 runs"
assert_out "crossing: 0.1.11$"
assert_present "$STUB_MARKER_MIRROR" "mirror"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.1.11-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"

# 23. A target before 0.1.11 isn't on registry.kindgi.com: refused at the start.
case_start "target before 0.1.11"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.1.10
assert_rc 1 "0.1.10 target refused"
assert_out "has 0.1.11 and later"
assert_out "as of the @kindgi/sdk@0.1.10 tag"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

# 24. Not logged in to registry.kindgi.com: the login line, before the mirror.
case_start "not logged in to registry.kindgi.com"
reset_env; export STUB_TAGS="0.1.10" STUB_INSPECT_ERR="ERROR: unexpected status from HEAD request: 401 Unauthorized"
run "yes"
assert_rc 1 "no login refused"
assert_out "docker login registry.kindgi.com --username kindgi, with your license key as the password"
assert_out "401 Unauthorized"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 25. Past the newest release this script knows: refused before anything is
# read, mirrored or backed up, though 0.1.9 to 0.1.11 lie on the way.
case_start "target past the newest known release"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.2.0
assert_rc 1 "a later target refused"
assert_out "knows the steps up to 0.1.11"
assert_out "as of the @kindgi/sdk@0.2.0 tag"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 26. An rc of a later release counts as that release.
case_start "rc of a later release"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.2.0-rc.1
assert_rc 1 "a later rc refused"
assert_out "knows the steps up to 0.1.11"
assert_out "as of the @kindgi/sdk@0.2.0 tag (before it's out, that release's newest @kindgi/sdk@0.2.0-rc.N tag)"
assert_absent "$STUB_MARKER_MIRROR" "mirror"

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
