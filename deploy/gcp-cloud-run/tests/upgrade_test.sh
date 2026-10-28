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
# applied and written to the var-file. Every stubbed call is logged, so a dry
# run can be held to reads; docker's config is a file of the case's own.

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
printf 'gcloud %s\n' "$*" >>"${STUB_CALLS_LOG:-/dev/null}"
case "$*" in
  "auth configure-docker"*)
    # As the real one does: a credential helper for the host in docker's config.
    if [[ -n ${DOCKER_CONFIG:-} ]]; then printf '{"credHelpers":{"%s":"gcloud"}}\n' "$3" >"$DOCKER_CONFIG/config.json"; fi
    exit 0 ;;
  "run services describe"*)
    if [[ "$*" == *"--format=json"* ]]; then
      # The v1 object: STUB_SERVICE_JSON's status, and the server's
      # KINDGI_DATABASE_URL as a secret reference at STUB_DBURL_BEFORE
      # (latest), or none with STUB_DBURL_BEFORE=-, twice with
      # STUB_DBURL_TWICE=1.
      svc="${STUB_SERVICE_JSON:-}"; if [[ -z $svc ]]; then svc='{}'; fi
      jq -c --arg k "${STUB_DBURL_BEFORE:-latest}" --arg twice "${STUB_DBURL_TWICE:-}" '. * {spec: {template: {spec: {containers: [{env: ([{name: "KINDGI_ENV", value: "dev"}]
        + (if $k == "-" then [] else [{name: "KINDGI_DATABASE_URL", valueFrom: {secretKeyRef: {name: "kindgi-database-url", key: $k}}}] end)
        + (if $twice == "1" then [{name: "KINDGI_DATABASE_URL", valueFrom: {secretKeyRef: {name: "kindgi-database-url", key: "latest"}}}] else [] end))}]}}}}' <<<"$svc"
    elif [[ "$*" == *"--format=value(spec.template.spec.containers[0].image)"* ]]; then printf '%s\n' "${STUB_RUNNING_IMAGE:-}"
    fi; exit 0 ;;
  "artifacts docker images list"*) printf '%s\n' "${STUB_TAGS:-}"; exit 0 ;;
  "sql instances describe"*)
    name="$4"
    jq -n --arg n "$name" --arg v "${STUB_DB_VERSION:-POSTGRES_16}" --argjson pub "${STUB_DB_PUBLIC:-true}" \
      --arg sa "${STUB_SQL_SA-p-sql@demo-proj.iam.gserviceaccount.com}" '{
      name: $n, connectionName: ("demo-proj:northamerica-northeast2:" + $n),
      serviceAccountEmailAddress: (if $sa == "" then null else $sa end),
      databaseVersion: $v, settings: {ipConfiguration: {ipv4Enabled: $pub}}}'
    exit 0 ;;
  "sql ssl server-ca-certs list"*)
    # gcloud's sslCert objects; each PEM with the whitespace around it the
    # module's trimspace() drops.
    cas='[{"kind":"sql#sslCert","cert":"\nCA-ONE\n"},{"kind":"sql#sslCert","cert":"CA-TWO\n"}]'
    printf '%s' "${STUB_DB_CA-$cas}"
    exit 0 ;;
  "run jobs create"*)
    printf '%s\n' "$*" >>"${STUB_JOBS_LOG:-/dev/null}"
    for a in "$@"; do
      case "$a" in --env-vars-file=*) cp "${a#--env-vars-file=}" "${STUB_JOB_ENV_SAW:-/dev/null}" ;; esac
    done
    exit "${STUB_JOB_CREATE_RC:-0}" ;;
  "run jobs execute"*) exit "${STUB_CHECK_RC:-0}" ;;
  "secrets versions describe"*)
    # A version's metadata, never its value, as gcloud's JSON gives it: its
    # full name and state. latest is STUB_DBURL_LATEST (4); STUB_DBURL_STATE
    # is every version's state; STUB_DBURL_RC fails the read.
    v="$4" secret=""
    for a in "$@"; do case "$a" in --secret=*) secret="${a#--secret=}" ;; esac; done
    if [[ $v == latest ]]; then v="${STUB_DBURL_LATEST:-4}"; fi
    if [[ -n ${STUB_DBURL_RC:-} ]]; then
      echo "ERROR: (gcloud.secrets.versions.describe) NOT_FOUND: Secret Version [projects/123456789012/secrets/$secret/versions/$v] not found or has no versions." >&2
      exit "$STUB_DBURL_RC"
    fi
    jq -n --arg n "projects/123456789012/secrets/$secret/versions/$v" --arg s "${STUB_DBURL_STATE:-ENABLED}" \
      '{name: $n, createTime: "2026-10-01T00:00:00.000000Z", state: $s, replicationStatus: {automatic: {}}}'
    exit 0 ;;
  "sql export sql"*)
    # Counts each try; the first STUB_EXPORT_412 tries are refused as Cloud SQL
    # refuses one before its bucket grant takes effect.
    n=$(( $(cat "$STUB_EXPORT_TRIES" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$STUB_EXPORT_TRIES"
    if (( n <= ${STUB_EXPORT_412:-0} )); then
      echo 'ERROR: (gcloud.sql.export.sql) HTTPError 412: The service account does not have the required permissions for the bucket.' >&2
      exit 1
    fi
    : >"${STUB_MARKER_EXPORT:-/dev/null}"; exit "${STUB_EXPORT_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

cat >"$BIN/terraform" <<'STUB'
#!/usr/bin/env bash
printf 'terraform %s\n' "$*" >>"${STUB_CALLS_LOG:-/dev/null}"
case "${1:-}" in
  output) printf '%s' "${STUB_TF_OUTPUTS:-}"; exit 0 ;;
  console) cat >/dev/null; printf '%s\n' "${STUB_TF_VARS_RAW:-}"; exit 0 ;;
  plan)
    # The plan file is the plan as `terraform show -json` gives it: the server
    # (and the pack, with STUB_PACK_BEFORE) at the image the var files set, a
    # later file over an earlier one and -var over both, as terraform reads
    # them; STUB_PLAN_CHANGES adds resource changes; STUB_PLAN_KEEP_IMAGE
    # leaves the server's image as it is. The server's KINDGI_DATABASE_URL
    # reads STUB_DBURL_BEFORE (latest) before, and after, the
    # database_url_secret_version the var files or a -var set (latest if none).
    # What Terraform loads on its own from the directory it runs in comes
    # first: terraform.tfvars, terraform.tfvars.json, then *.auto.tfvars and
    # *.auto.tfvars.json in one lexical order.
    out="" prev="" img="" pack="" dburl="" auto=()
    for f in terraform.tfvars terraform.tfvars.json; do if [[ -f $f ]]; then auto+=("-var-file=$f"); fi; done
    while IFS= read -r f; do auto+=("-var-file=$f"); done < <(ls -1 | grep -E '\.auto\.tfvars(\.json)?$' | LC_ALL=C sort)
    for a in ${auto[@]+"${auto[@]}"} "$@"; do
      case "$a" in
        -out=*) out="${a#-out=}" ;;
        -var-file=*)
          f="${a#-var-file=}"
          cat "$f" >>"${STUB_PLAN_SAW:-/dev/null}"
          if [[ $f == *.json ]]; then
            v="$(jq -r '.server_image // empty' "$f")"; p="$(jq -r '.pack_image // empty' "$f")"
            d="$(jq -r '.database_url_secret_version // empty' "$f")"
          else
            v="$(sed -nE 's/^[[:space:]]*server_image[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f")"
            p="$(sed -nE 's/^[[:space:]]*pack_image[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f")"
            d="$(sed -nE 's/^[[:space:]]*database_url_secret_version[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f")"
          fi
          img="${v:-$img}"; pack="${p:-$pack}"; dburl="${d:-$dburl}" ;;
        -var) printf 'plan got -var\n' >>"${STUB_PLAN_SAW:-/dev/null}" ;;
        server_image=*) if [[ $prev == -var ]]; then img="${a#server_image=}"; fi ;;
        database_url_secret_version=*) if [[ $prev == -var ]]; then dburl="${a#database_url_secret_version=}"; fi ;;
      esac
      prev="$a"
    done
    if [[ -n ${STUB_PLAN_KEEP_IMAGE:-} ]]; then img="$STUB_RUNNING_IMAGE"; fi
    if [[ -n $out ]]; then
      jq -n --arg old "$STUB_RUNNING_IMAGE" --arg new "${img:-$STUB_RUNNING_IMAGE}" \
        --arg pold "${STUB_PACK_BEFORE:-}" --arg pnew "${pack:-${STUB_PACK_BEFORE:-}}" \
        --arg dbold "${STUB_DBURL_BEFORE:-latest}" --arg dbnew "${dburl:-latest}" \
        --argjson extra "${STUB_PLAN_CHANGES:-[]}" '
        def env($n): [{name: "KINDGI_ENV", value: "dev", value_source: []}]
          + (if $n == "server" then [{name: "KINDGI_DATABASE_URL", value: "",
               value_source: [{secret_key_ref: [{secret: "kindgi-database-url", version: (if . == "before" then $dbold else $dbnew end)}]}]}]
             else [] end);
        def svc($n; $addr; $b; $a):
          {address: $addr, mode: "managed", type: "google_cloud_run_v2_service", name: $n,
           change: {actions: (if $b == $a and ($n != "server" or $dbold == $dbnew) then ["no-op"] else ["update"] end),
             before: {name: ("kindgi-" + $n), template: [{containers: [{image: $b, env: ("before" | env($n))}]}]},
             after: {name: ("kindgi-" + $n), template: [{containers: [{image: $a, env: ("after" | env($n))}]}]},
             after_unknown: {template: [{containers: [{env: [{}]}]}]}}};
        {format_version: "1.2",
         resource_changes: ([svc("server"; "google_cloud_run_v2_service.server"; $old; $new)]
           + (if $pold == "" then [] else [svc("pack"; "google_cloud_run_v2_service.pack[0]"; $pold; $pnew)] end)
           + $extra)}' >"$out"
    fi
    exit "${STUB_PLAN_RC:-0}" ;;
  show) cat "${3:-}"; exit "${STUB_SHOW_RC:-0}" ;;
  apply) : >"${STUB_MARKER_APPLY:-/dev/null}"; exit "${STUB_APPLY_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${STUB_CALLS_LOG:-/dev/null}"
case "$*" in
  "buildx imagetools inspect"*)
    printf '%s\n' "$*" >>"${STUB_DOCKER_LOG:-/dev/null}"
    if [[ -n ${STUB_INSPECT_ERR:-} ]]; then printf '%s\n' "$STUB_INSPECT_ERR" >&2; exit 1; fi
    printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":1609}\n' "${STUB_RELEASE_DIGEST:-}"; exit 0 ;;
  "buildx imagetools create"*)
    printf '%s\n' "$*" >>"${STUB_DOCKER_LOG:-/dev/null}"
    printf 'stub: imagetools create\n' >&2
    : >"${STUB_MARKER_MIRROR:-/dev/null}"; exit "${STUB_MIRROR_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB

printf '#!/usr/bin/env bash\nprintf "kindgi %%s\\n" "$*" >>"${STUB_CALLS_LOG:-/dev/null}"\nexit 0\n' >"$BIN/kindgi"
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
    --arg prefix "${V_PREFIX:-kindgi}" --argjson dbi "${V_DBI:-null}" \
    --arg connector "${V_CONNECTOR:-}" --arg private "${V_DB_PRIVATE:-}" --arg dburl "${V_DBURL:-}" '{
    project_id:"demo-proj", region:"northamerica-northeast2", name_prefix:$prefix,
    network_mode:$net, vpc_connector:$connector, database_private_network:$private,
    database_host_instance:(if $host == "" then null else $host end),
    database_name:"kindgi", secrets_backend:"postgres",
    secrets_aad_key_version:(if $aad == "" then null else $aad end),
    database_url_secret_version:(if $dburl == "" then null else $dburl end),
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
        STUB_EXPORT_RC STUB_EXPORT_412 STUB_PLAN_RC STUB_APPLY_RC STUB_MIRROR_RC STUB_INSPECT_ERR STUB_SQL_SA \
        STUB_DB_CA STUB_PACK_BEFORE STUB_PLAN_CHANGES STUB_PLAN_KEEP_IMAGE STUB_SHOW_RC \
        STUB_DBURL_LATEST STUB_DBURL_STATE STUB_DBURL_RC STUB_DBURL_BEFORE STUB_DBURL_TWICE \
        V_NET V_HOST V_TENANCY V_PACK V_AAD V_PREFIX V_DBI V_CONNECTOR V_DB_PRIVATE V_DBURL
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
  if [[ -n ${1:-} ]]; then export STUB_PACK_BEFORE="$1"; fi
  export STUB_TF_OUTPUTS="$TF_OUTPUTS"
  export STUB_RUNNING_IMAGE="$RUNNING_IMAGE"
  export STUB_SERVICE_JSON="$SERVICE_READY"
  export STUB_RELEASE_DIGEST="$NEW_DIGEST"
  export STUB_DOCKER_LOG="$CASE_DIR/docker.log"
  export STUB_MARKER_EXPORT="$CASE_DIR/exported"
  export STUB_EXPORT_TRIES="$CASE_DIR/export-tries"
  export STUB_MARKER_APPLY="$CASE_DIR/applied"
  export STUB_MARKER_MIRROR="$CASE_DIR/mirrored"
  export STUB_PLAN_SAW="$CASE_DIR/plan-saw"
  export STUB_JOBS_LOG="$CASE_DIR/jobs.log"
  export STUB_JOB_ENV_SAW="$CASE_DIR/job-env"
  export STUB_CALLS_LOG="$CASE_DIR/calls.log"
  export DOCKER_CONFIG="$CASE_DIR/docker"
  mkdir -p "$DOCKER_CONFIG"
  printf '{"auths":{"registry.kindgi.com":{}}}\n' >"$DOCKER_CONFIG/config.json"
  cp "$DOCKER_CONFIG/config.json" "$CASE_DIR/original-docker-config.json"
  # 0.2.0 unless a case says otherwise; the default, the newest release the
  # script knows, has a case of its own.
  ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev" --to 0.2.0)
}

run() { # $1 = stdin (the plan confirmation); rest = extra script args
  local confirm="$1"; shift
  export STUB_TF_VARS_RAW; STUB_TF_VARS_RAW="$(vars_raw "$(mkvars)")"
  # From the case's directory, as from the module's: what Terraform loads on
  # its own is looked for there.
  ( cd "$CASE_DIR" && "$SCRIPT" "${ARGS[@]}" "$@" ) >"$OUT" 2>&1 <<<"$confirm"
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
assert_docker_config_unchanged() {
  if cmp -s "$DOCKER_CONFIG/config.json" "$CASE_DIR/original-docker-config.json"; then pass; else fail "docker's config changed but shouldn't have"; fi
}
# Every call the run made is a read: the deployment's and the registry's, the
# database URL secret's version (its metadata), the module's outputs and
# variables, a plan with no state lock, and that plan read back. So nothing
# writes the state, and nothing else changes. (The real terraform console
# takes the state lock briefly; the stub doesn't model it.)
assert_reads_only() {
  local other
  other="$(grep -vE '^(gcloud (run services describe|artifacts docker images list|sql instances describe|sql ssl server-ca-certs list) |gcloud secrets versions describe [^ ]+ --secret=[^ ]+ --project=[^ ]+ --format=json$|docker buildx imagetools inspect |terraform output -json$|terraform console( -var-file=[^ ]+)+$|terraform plan( -var-file=[^ ]+)+ -var server_image=[^ ]+( -var database_url_secret_version=[0-9]+)? -lock=false -out=[^ ]+$|terraform show -json [^ ]+$)' "$STUB_CALLS_LOG")"
  if [[ -z $other ]]; then pass; else fail "made a call that isn't a read: $other"; fi
}

# 1. Happy path: 0.1.8 -> 0.2.0, own instance, no pack, confirm yes.
case_start "happy path"
reset_env; export STUB_TAGS="0.1.8"
run "yes"
assert_rc 0 "happy path exits 0"
assert_present "$STUB_MARKER_MIRROR" "mirror"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.1.8 -> 0.2.0 applied"
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"  # mirrored 0.1.8" "var-file pins the new image, comment kept"
assert_file_has "$STUB_PLAN_SAW" "$NEW_IMAGE" "the plan read the new image from the var-file"
if grep -q "plan got -var" "$STUB_PLAN_SAW"; then fail "plan was given -var"; else pass; fi
assert_out "plan check: it changes the image(s), and only what the releases crossed change in place."
# The plan applied is kept next to the var-file's copy, readable by its owner
# alone, and the run says where.
kept="$(ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan 2>/dev/null)"
if [[ -n $kept && -f $kept ]]; then pass; else fail "the plan applied wasn't kept next to the var-file"; fi
assert_file_has "$OUT" "yes applies exactly this plan, and keeps it as $kept." "the prompt says where the plan goes"
assert_file_has "$OUT" "the plan applied at $kept." "the end says where the plan is"
if [[ "$(ls -l "$kept" | cut -c1-10)" == "-rw-------" ]]; then pass; else fail "the kept plan is readable by others: $(ls -l "$kept")"; fi
if cmp -s "$(ls "$CASE_DIR"/dev.tfvars.pre-upgrade-*)" "$CASE_DIR/original.tfvars"; then pass; else fail "no .pre-upgrade copy of the original"; fi
if cmp -s "$DOCKER_CONFIG/config.json" "$CASE_DIR/original-docker-config.json"; then fail "docker wasn't set up for Artifact Registry"; else pass; fi

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
reset_env; export STUB_TAGS="0.2.0"
run "yes"
assert_rc 1 "already at target"
assert_out "already on 0.2.0"
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
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a plan not confirmed was kept"; else pass; fi

# 6. Apply fails: the go-back is printed, the var-file keeps the new image.
case_start "apply fails"
reset_env; export STUB_TAGS="0.1.8" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_out "To go back"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.1 memory erasures export --out=erasures-" "the export runs 0.1.8's CLI line"
assert_out "import sql"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.1 memory erasures replay erasures-" "the replay runs 0.1.8's CLI line"
if grep -qF "pre-release" "$OUT"; then fail "a final's go-back has the pre-release note"; else pass; fi
assert_out "cp $VAR_FILE.pre-upgrade-"
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the go-back doesn't plan with the var-file alone"; fi
if grep -qxF "      terraform apply back.tfplan" "$OUT"; then pass; else fail "the go-back doesn't apply its saved plan"; fi
if grep -q "or set database_name" "$OUT"; then fail "go-back still offers database_name"; else pass; fi
assert_file_has "$VAR_FILE" "$NEW_IMAGE" "var-file keeps the new image after a failed apply"

# 7. The new revision never becomes ready: go-back printed.
case_start "start never ready"
reset_env; export STUB_TAGS="0.1.8" STUB_SERVICE_JSON="$SERVICE_STUCK"
run "yes"
assert_rc 1 "unhealthy start"
assert_out "did not become ready"
assert_out "fresh database"

# 7a. The go-back names the CLI of the release the run started from: a server
# fix for 0.2.0 is on the 0.2 line.
case_start "go-back from a server fix"
reset_env; export STUB_SERVICE_JSON="$SERVICE_STUCK"
run "yes" --from 0.2.0.1 --to 0.2.0.2
assert_rc 1 "unhealthy start"
assert_out "did not become ready"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures export --out=erasures-" "the export runs 0.2.0.1's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures replay erasures-" "the replay runs 0.2.0.1's CLI line"
if grep -qF "@kindgi/cli@0.1" "$OUT"; then fail "the go-back from 0.2.0.1 names the 0.1 CLI"; else pass; fi
if grep -qF "pre-release" "$OUT"; then fail "a server fix's go-back has the pre-release note"; else pass; fi

# 7b. From an rc, the 0.2 line finds no CLI until 0.2.0 is out: a note right
# under the export says so.
case_start "go-back from an rc"
reset_env; export STUB_TAGS="0.2.0-rc.0" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures export --out=erasures-" "the export runs the rc's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures replay erasures-" "the replay runs the rc's CLI line"
note="$(grep -A4 -F "memory erasures export" "$OUT" | tail -n 4)"
if [[ $note == "    This deployment runs a pre-release, 0.2.0-rc.0. Until 0.2.0 is out,
    npx finds no @kindgi/cli@0.2: in this step and in step 7, name the
    CLI's own pre-release instead, as @kindgi/cli@0.2.0-rc.N
    (npm view @kindgi/cli versions lists them)." ]]; then pass
else fail "the pre-release note isn't right under the export: $note"; fi

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
reset_env; export STUB_TAGS="0.2.0-rc.0"
run "yes"
assert_rc 0 "rc -> final runs"
assert_out "0.2.0-rc.0 -> 0.2.0 applied"

# 10. To an rc: its release's steps are included.
case_start "0.1.8 to an rc"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.2.0-rc.0
assert_rc 0 "to an rc runs"
assert_out "crossing: 0.1.9 0.1.10 0.2.0"
assert_out "autoCloseAfterInactiveSeconds"

# 11. An rc promoted to its final carries both tags: the final is the version.
case_start "rc and final tags on one digest"
reset_env; export STUB_TAGS="0.2.0-rc.0;0.2.0"
run "yes"
assert_rc 1 "final read from the two tags"
assert_out "already on 0.2.0,"

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

# 15. network_mode direct, the database on its public IP: the check jobs
# leave through the server's subnet, all traffic, and mount the /cloudsql
# socket, as the server does.
case_start "network_mode direct"
reset_env; export STUB_TAGS="0.1.8"; V_NET="direct"
run "yes"
assert_rc 0 "direct runs"
assert_out "network mode    direct"
assert_file_has "$STUB_JOBS_LOG" "--network=kindgi --subnet=kindgi-run --vpc-egress=all-traffic" "check job leaves through the server's subnet"
assert_file_has "$STUB_JOBS_LOG" "--set-cloudsql-instances=demo-proj:northamerica-northeast2:kindgi" "check job mounts the socket"
if grep -q -e "--vpc-connector" -e "--env-vars-file" "$STUB_JOBS_LOG"; then fail "a direct job got a connector or the CAs"; else pass; fi
assert_present "$STUB_MARKER_APPLY" "apply"

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
assert_file_has "$STUB_JOBS_LOG" "KINDGI_DATABASE_URL=kindgi-r1-database-url:4" "check job reads the restored URL secret, at the version the server reads"

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

# The export's tries, as the stub counted them.
assert_export_tries() {
  if [[ "$(cat "$STUB_EXPORT_TRIES" 2>/dev/null)" == "$1" ]]; then pass; else fail "$2 (export tried $(cat "$STUB_EXPORT_TRIES" 2>/dev/null || echo 0) times, wanted $1)"; fi
}

# 21. A new bucket grant that hasn't reached Cloud SQL yet: the export waits
# for it, saying so, then goes on.
case_start "export waits for the bucket grant"
reset_env; export STUB_TAGS="0.1.8" STUB_EXPORT_412=2
run "yes"
assert_rc 0 "the export goes on once the grant takes effect"
assert_export_tries 3 "two refusals, then the export"
assert_out "hasn't taken effect yet"
assert_out "trying the export again (30s waited)"
if [[ "$(grep -c 'HTTPError 412' "$OUT")" == 1 ]]; then pass; else fail "gcloud's refusal should be shown once"; fi
if grep -q "Fix the cause" "$OUT"; then fail "a grant still taking effect was called a cause to fix"; else pass; fi
assert_present "$STUB_MARKER_APPLY" "apply"

# 22. A grant that never takes effect: it stops after 7 minutes, and nothing
# has changed.
case_start "the bucket grant never takes effect"
reset_env; export STUB_TAGS="0.1.8" STUB_EXPORT_412=99
run "yes"
assert_rc 1 "a grant that never takes effect stops it"
assert_export_tries 29 "the first try, then one every 15s for 7 minutes"
assert_out "still can't write to gs://backups after 7 minutes"
assert_out "get-iam-policy gs://backups"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 23. Any other export failure stops at once.
case_start "export fails otherwise"
reset_env; export STUB_TAGS="0.1.8" STUB_EXPORT_RC=1
run "yes"
assert_rc 1 "an export failure stops it"
assert_export_tries 1 "no second try"
assert_out "the export failed (above). Nothing has changed."
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 24. Past the newest release this script knows: refused before anything is
# read, mirrored or backed up, though 0.1.9 to 0.3.0 lie on the way.
case_start "target past the newest known release"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.4.0
assert_rc 1 "a later target refused"
assert_out "knows the steps up to 0.3.0"
assert_out "as of the @kindgi/sdk@0.4.0 tag"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 25. An rc of a later release counts as that release.
case_start "rc of a later release"
reset_env; export STUB_TAGS="0.1.9"
run "yes" --to 0.4.0-rc.1
assert_rc 1 "a later rc refused"
assert_out "knows the steps up to 0.3.0"
assert_out "as of the @kindgi/sdk@0.4.0 tag or, before that release is out, its newest @kindgi/sdk@0.4.0-rc.N tag."
assert_absent "$STUB_MARKER_MIRROR" "mirror"

# 26. 0.1.10 -> 0.2.0: crosses 0.2.0 alone, copies it from registry.kindgi.com.
case_start "0.1.10 to 0.2.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes"
assert_rc 0 "0.1.10 -> 0.2.0 runs"
assert_out "crossing: 0.2.0$"
assert_out "0.2.0:"
assert_out "now comes from registry.kindgi.com"
assert_out "If public_url is empty, set it to the URL people open the console at"
assert_out "console sessions are accepted from that origin only"
assert_out "<public_url>/console/connect/callback"
assert_out "Three of them take a short"
assert_out "kernel_runs, kernel_triggers, hitl_approvals or judgments"
assert_out "With openfga_api_url empty (no authorization store)"
assert_out "an emailed link or an identity provider isn't one"
assert_out "A pack built for 0.1.10 keeps working without a rebuild."
assert_out "the plan also changes it in place"
if grep -q "autoCloseAfterInactiveSeconds" "$OUT"; then fail "0.1.10's steps shown for 0.1.10 -> 0.2.0"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0 " "the release tag is read on registry.kindgi.com"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.2.0@$NEW_DIGEST" "the mirror copies from registry.kindgi.com"
if grep -q "quay.io" "$STUB_DOCKER_LOG"; then fail "an image was read from quay.io"; else pass; fi
assert_file_has "$OUT" "This copies the runtime through this machine, down from registry.kindgi.com and up to Artifact Registry. It takes both platforms (linux/amd64 and linux/arm64), so your copy keeps the release digest." "what the copy is"
assert_file_has "$OUT" "On a slow uplink it can take most of an hour; it says when it's done." "how long the copy can take"
said="$(grep -o -F -e "Mirroring runtime 0.2.0 into" -e "This copies the runtime" -e "it says when it's done." -e "stub: imagetools create" -e "mirrored to $NEW_IMAGE" "$OUT" | tr '\n' '|')"
if [[ $said == "Mirroring runtime 0.2.0 into|This copies the runtime|it says when it's done.|stub: imagetools create|mirrored to $NEW_IMAGE|" ]]; then pass
else fail "the copy's time isn't said between the step line and the copy, in order: $said"; fi
assert_out "0.1.10 -> 0.2.0 applied"

# 27. 0.1.10 -> an rc of 0.2.0: its steps are included, and it gets to the mirror.
case_start "0.1.10 to 0.2.0-rc.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.2.0-rc.0
assert_rc 0 "0.1.10 -> 0.2.0-rc.0 runs"
assert_out "crossing: 0.2.0$"
assert_present "$STUB_MARKER_MIRROR" "mirror"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.2.0-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"

# 28. A target before 0.2.0 isn't on registry.kindgi.com: refused at the start.
case_start "target before 0.2.0"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.1.10
assert_rc 1 "0.1.10 target refused"
assert_out "has 0.2.0 and later"
assert_out "as of the @kindgi/sdk@0.1.10 tag"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

# 29. Not logged in to registry.kindgi.com: the login line, before the mirror.
case_start "not logged in to registry.kindgi.com"
reset_env; export STUB_TAGS="0.1.10" STUB_INSPECT_ERR="ERROR: unexpected status from HEAD request: 401 Unauthorized"
run "yes"
assert_rc 1 "no login refused"
assert_out "docker login registry.kindgi.com --username kindgi, with your license key as the password"
assert_out "401 Unauthorized"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 30. 0.1.11 never had a final release (its changes ship in 0.2.0): neither it
# nor one of its rcs is a target.
case_start "0.1.11 isn't a target"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.1.11-rc.0
assert_rc 1 "a 0.1.11 target refused"
assert_out "has 0.2.0 and later"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

# 31. A deployment on a 0.1.11 rc upgrades to 0.2.0, crossing 0.2.0 alone.
case_start "0.1.11-rc.0 to 0.2.0"
reset_env; export STUB_TAGS="0.1.11-rc.0"
run "yes"
assert_rc 0 "0.1.11-rc.0 -> 0.2.0 runs"
assert_out "crossing: 0.2.0$"
assert_out "0.1.11-rc.0 -> 0.2.0 applied"

# 32. A dry run: the reads and the read-only checks, every change a real run
# would make with the names it would use, the steps to confirm by hand, and a
# read-only plan for the new image. Nothing is mirrored, granted, exported,
# built or applied, and no job is run; the var-file and docker's config are
# untouched; the plan takes no state lock and no state is written.
case_start "dry run"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
run "yes" --pack-dir "$PACK_DIR" --dry-run
assert_rc 0 "a dry run exits 0"
assert_out "DRY RUN. It reads only"
assert_file_has "$STUB_CALLS_LOG" "docker buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0 " "the release digest is read"
assert_file_has "$OUT" "2. add gcloud as the credential helper for northamerica-northeast2-docker.pkg.dev in your docker config" "the docker config"
assert_file_has "$OUT" "add the image tag $REPO/runtime:0.2.0 to Artifact Registry" "the mirror"
assert_file_has "$OUT" "   (both platforms, through this machine; on a slow uplink it can take most of an hour)" "the mirror's time"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-pk  (check provider-keys)" "the provider-keys job"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-ss  (check secret-scopes)" "the secret-scopes job"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-mhc  (check mcp-header-credentials)" "the mcp-header-credentials job"
assert_file_has "$OUT" "grant serviceAccount:p-sql@demo-proj.iam.gserviceaccount.com roles/storage.objectAdmin on gs://backups " "the grant"
assert_file_has "$OUT" "export the \"kindgi\" database to gs://backups/dev/kindgi-kindgi-0.1.10-<YYYYMMDDTHHMMSSZ>.sql.gz" "the export"
assert_file_has "$OUT" "rebuild and push the pack from $PACK_DIR " "the pack build"
assert_file_has "$OUT" "copy $VAR_FILE to $VAR_FILE.pre-upgrade-<YYYYMMDDTHHMMSSZ>" "the var-file copy"
assert_file_has "$OUT" "set server_image = \"$NEW_IMAGE\" in $VAR_FILE" "the new image"
assert_file_has "$OUT" "add database_url_secret_version = \"4\" to $VAR_FILE (the version of kindgi-database-url the server reads today)" "the database URL's pin"
assert_file_has "$OUT" "pack_image is unchanged in this plan" "the pack image's limit"
assert_file_has "$OUT" "wait for the new revision of kindgi-server" "the wait"
assert_out "key as the password; this script copies it from there."
assert_out "dry run done. Nothing was changed"
if grep -q "Apply this plan" "$OUT"; then fail "a dry run asked for yes"; else pass; fi
assert_file_has "$STUB_CALLS_LOG" "terraform plan -var-file=$VAR_FILE -var server_image=$NEW_IMAGE -var database_url_secret_version=4 -lock=false" "the plan is given the new image and the pin"
assert_out "plan check: it changes the image(s)"
assert_file_has "$OUT" "apply exactly that plan, kept as $VAR_FILE.upgrade-<YYYYMMDDTHHMMSSZ>.tfplan" "the kept plan's name"
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a dry run left a plan"; else pass; fi
assert_reads_only
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged
if ls "$CASE_DIR"/dev.tfvars.pre-upgrade-* >/dev/null 2>&1; then fail "a dry run left a .pre-upgrade copy"; else pass; fi
assert_docker_config_unchanged

# 33. A dry run stops where a real run would: a failed precondition exits 1,
# says it was a dry run, and lists nothing.
case_start "dry run, a precondition fails"
reset_env; export STUB_TAGS="0.1.10" STUB_INSPECT_ERR="ERROR: unexpected status from HEAD request: 401 Unauthorized"
run "yes" --dry-run
assert_rc 1 "a failed check stops the dry run"
assert_out "upgrade (dry run): a precondition failed"
if grep -q "What a real run would change" "$OUT"; then fail "the changes were listed after a failed check"; else pass; fi
assert_absent "$STUB_PLAN_SAW" "a plan"
assert_reads_only
assert_varfile_unchanged
assert_docker_config_unchanged

# 34. A dry run whose plan fails exits 1, and still changes nothing.
case_start "dry run, the plan fails"
reset_env; export STUB_TAGS="0.1.10" STUB_PLAN_RC=1
run "yes" --dry-run
assert_rc 1 "a failed plan fails the dry run"
assert_out "4. nothing: no pack service"
assert_out "upgrade (dry run): terraform plan failed"
assert_reads_only
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 35. A dry run with a pack service and no --pack-dir: the pack stays as it is.
case_start "dry run, a pack service without --pack-dir"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
run "yes" --dry-run
assert_rc 0 "a dry run exits 0"
assert_out "4. nothing: without --pack-dir the pack image stays as it is"
if grep -q "pack_image is unchanged in this plan" "$OUT"; then fail "a pack note without --pack-dir"; else pass; fi
assert_reads_only
assert_varfile_unchanged

# 36. A dry run stops where a real run would stop at the backup: the SQL
# instance has no service account to grant. It lists nothing.
case_start "dry run, no SQL service account"
reset_env; export STUB_TAGS="0.1.10" STUB_SQL_SA=""
run "yes" --dry-run
assert_rc 1 "no service account stops the dry run"
assert_out "upgrade (dry run): couldn't read instance kindgi's service account"
if grep -q "What a real run would change" "$OUT"; then fail "the changes were listed without a service account"; else pass; fi
assert_absent "$STUB_PLAN_SAW" "a plan"
assert_reads_only
assert_varfile_unchanged

# 37. A server-only release, X.Y.Z.N, is a server fix for X.Y.Z with no SDK
# release of its own. From X.Y.Z it crosses no release and has no steps to
# confirm by hand; its image comes from its own tag on registry.kindgi.com.
case_start "0.2.0 to a server-only release, 0.2.0.1"
reset_env; export STUB_TAGS="0.2.0"
run "yes" --to 0.2.0.1
assert_rc 0 "0.2.0 -> 0.2.0.1 runs"
assert_out "upgrading 0.2.0 -> 0.2.0.1, a server fix for 0.2.0: no release crossed"
assert_out "none: 0.2.0.1 is a server fix for 0.2.0."
if grep -q "now comes from registry.kindgi.com" "$OUT"; then fail "0.2.0's steps shown for 0.2.0 -> 0.2.0.1"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0.1 " "the server fix's own tag is read"
assert_file_has "$STUB_DOCKER_LOG" "--tag $REPO/runtime:0.2.0.1 registry.kindgi.com/kindgi/runtime:0.2.0.1@$NEW_DIGEST" "the mirror tags it 0.2.0.1"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.2.0 -> 0.2.0.1 applied"

# 38. From before X.Y.Z, a server-only release crosses X.Y.Z: its steps print.
case_start "0.1.10 to 0.2.0.1"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.2.0.1
assert_rc 0 "0.1.10 -> 0.2.0.1 runs"
assert_out "crossing: 0.2.0$"
assert_out "now comes from registry.kindgi.com"
if grep -q "none: " "$OUT"; then fail "a crossing upgrade said there are no steps"; else pass; fi
assert_out "0.1.10 -> 0.2.0.1 applied"

# 39. From an rc of X.Y.Z, too: the rc is below its final.
case_start "0.2.0-rc.0 to 0.2.0.1"
reset_env; export STUB_TAGS="0.2.0-rc.0"
run "yes" --to 0.2.0.1
assert_rc 0 "0.2.0-rc.0 -> 0.2.0.1 runs"
assert_out "crossing: 0.2.0$"
assert_out "0.2.0-rc.0 -> 0.2.0.1 applied"

# 40. From one server fix to the next: the running X.Y.Z.N is read from its
# mirrored tag, and names the export.
case_start "0.2.0.1 to 0.2.0.2"
reset_env; export STUB_TAGS="0.2.0.1"
run "yes" --to 0.2.0.2
assert_rc 0 "0.2.0.1 -> 0.2.0.2 runs"
assert_out "read 0.2.0.1 from the mirrored image's tag"
assert_out "a server fix for 0.2.0: no release crossed"
assert_out "backup complete: gs://backups/dev/kindgi-kindgi-0.2.0.1-"
assert_out "0.2.0.1 -> 0.2.0.2 applied"

# 41. A later server fix is past an earlier one, and past its release: going
# back down is refused before anything is read from the registry.
case_start "0.2.0.2 to 0.2.0.1 is refused"
reset_env; export STUB_TAGS="0.2.0.2"
run "yes" --to 0.2.0.1
assert_rc 1 "going down refused"
assert_out "already on 0.2.0.2, at or past the target 0.2.0.1\."
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_varfile_unchanged

case_start "0.2.0.1 to 0.2.0 is refused"
reset_env; export STUB_TAGS="0.2.0.1"
run "yes"
assert_rc 1 "a server fix to its release refused"
assert_out "already on 0.2.0.1, at or past the target 0.2.0\."
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_varfile_unchanged

# 42. A server fix of a release past the newest this script knows: the refusal
# names its release's SDK tag, since a server-only release has none.
case_start "server fix past the newest known release"
reset_env; export STUB_TAGS="0.2.0"
run "yes" --to 0.4.0.1
assert_rc 1 "a later server fix refused"
assert_out "knows the steps up to 0.3.0. 0.4.0.1 is a server fix for 0.4.0, which comes out after its final: use this script as of the @kindgi/sdk@0.4.0 tag."
if grep -q "@kindgi/sdk@0.4.0.1" "$OUT"; then fail "the refusal names an SDK tag a server-only release doesn't have"; else pass; fi
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

# 43. A server-only release has no rc, and its N starts at 1 with no leading
# zero, as the runtime's releases are numbered: anything else isn't a target.
for bad in 0.2.0.1-rc.0 0.2.0.0 0.2.0.01 0.2.0.1.1; do
  case_start "--to $bad isn't a version"
  reset_env; export STUB_TAGS="0.2.0"
  run "yes" --to "$bad"
  assert_rc 1 "$bad refused"
  assert_out "--to \"$bad\" isn't a version like 0.2.0, 0.2.0-rc.0 or 0.2.0.1"
  assert_absent "$STUB_DOCKER_LOG" "a registry read"
done

# 44. --from takes a server-only release; and with no version tag to read, the
# refusal says --from takes one.
case_start "--from a server-only release"
reset_env
run "yes" --from 0.2.0.1 --to 0.2.0.2
assert_rc 0 "--from 0.2.0.1 runs"
assert_out "using --from 0.2.0.1"
assert_out "0.2.0.1 -> 0.2.0.2 applied"

case_start "--from an rc of a server fix isn't a version"
reset_env
run "yes" --from 0.2.0.1-rc.0 --to 0.2.0.2
assert_rc 1 "--from 0.2.0.1-rc.0 refused"
assert_out "--from \"0.2.0.1-rc.0\" isn't a version like 0.1.10, 0.2.0.1 or 0.3.0-preview.2"

case_start "no version tag, no --from"
reset_env
run "yes" --to 0.2.0.1
assert_rc 1 "no version refused"
assert_out "Re-run with --from <the version it runs, such as 0.1.10, 0.2.0.1 or 0.3.0-preview.2>"
assert_absent "$STUB_DOCKER_LOG" "a registry read"

# 45. A dry run lists a server-only release like any other target: its own
# tag read and mirrored, no steps by hand, and nothing changed.
case_start "dry run to a server-only release"
reset_env; export STUB_TAGS="0.2.0"
run "yes" --to 0.2.0.1 --dry-run
assert_rc 0 "a dry run to 0.2.0.1 exits 0"
assert_file_has "$STUB_CALLS_LOG" "docker buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0.1 " "the server fix's digest is read"
assert_file_has "$OUT" "2. add the image tag $REPO/runtime:0.2.0.1 to Artifact Registry" "the mirror"
assert_file_has "$OUT" "(a copy of registry.kindgi.com/kindgi/runtime:0.2.0.1@$NEW_DIGEST;" "the mirror's source"
assert_file_has "$OUT" "export the \"kindgi\" database to gs://backups/dev/kindgi-kindgi-0.2.0-<YYYYMMDDTHHMMSSZ>.sql.gz" "the export"
assert_out "none: 0.2.0.1 is a server fix for 0.2.0."
assert_out "dry run done. Nothing was changed"
assert_reads_only
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 46. The same script with releases it doesn't ship yet (0.2.1, and 0.4.0
# past a 0.3.0 it doesn't list), for what today's list can't reach: a server
# fix sorts below the next release's rc, and a server fix of a release the
# script doesn't list is refused.
GAP_SCRIPT="$TMP/upgrade-gap.sh"
sed 's/^readonly KNOWN_RELEASES=.*/readonly KNOWN_RELEASES=("0.1.9" "0.1.10" "0.2.0" "0.2.1" "0.4.0")/' "$SCRIPT" >"$GAP_SCRIPT"
chmod +x "$GAP_SCRIPT"
if grep -qx 'readonly KNOWN_RELEASES=("0.1.9" "0.1.10" "0.2.0" "0.2.1" "0.4.0")' "$GAP_SCRIPT"; then pass; else fail "the copy's KNOWN_RELEASES wasn't set"; fi
REAL_SCRIPT="$SCRIPT"; SCRIPT="$GAP_SCRIPT"

case_start "0.2.0.3 to the next release's rc"
reset_env; export STUB_TAGS="0.2.0.3"
run "yes" --to 0.2.1-rc.0
assert_rc 0 "0.2.0.3 -> 0.2.1-rc.0 runs"
assert_out "crossing: 0.2.1$"
assert_out "0.2.0.3 -> 0.2.1-rc.0 applied"

case_start "the next release's rc to 0.2.0.3 is refused"
reset_env; export STUB_TAGS="0.2.1-rc.0"
run "yes" --to 0.2.0.3
assert_rc 1 "an rc to an earlier release's server fix refused"
assert_out "already on 0.2.1-rc.0, at or past the target 0.2.0.3\."

case_start "server fix of a release the script doesn't list"
reset_env; export STUB_TAGS="0.2.1"
run "yes" --to 0.3.0.1
assert_rc 1 "0.3.0.1 refused"
assert_out "--to 0.3.0.1: a server fix for 0.3.0, which isn't a release this script knows (0.1.9 0.1.10 0.2.0 0.2.1 0.4.0)."
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_varfile_unchanged

SCRIPT="$REAL_SCRIPT"

# 47. A real run with a pack service and no --pack-dir leaves the pack image,
# and its warning names no release: the steps to confirm by hand say which
# release needs a rebuild.
case_start "a pack service without --pack-dir"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
run "yes"
assert_rc 0 "0.1.10 -> 0.2.0 runs without --pack-dir"
assert_out "no --pack-dir was given: the pack image is left unchanged"
assert_out "If a release crossed needs the pack rebuilt (its steps to confirm by hand, above, say so)"
if grep -q "If 0.1.10 needs" "$OUT"; then fail "the warning names a release"; else pass; fi
assert_out "0.1.10 -> 0.2.0 applied"

# 48. With no --to, the target is the newest release the script knows, 0.3.0.
# Its steps print, and its plan may turn on the instance's deletion
# protection, in place, as they say.
INSTANCE_PROTECTED="$(jq -cn '[{address: "google_sql_database_instance.kindgi[0]", mode: "managed",
  type: "google_sql_database_instance", name: "kindgi", index: 0,
  change: {actions: ["update"],
    before: {name: "kindgi", settings: [{tier: "db-custom-1-3840", deletion_protection_enabled: false}]},
    after: {name: "kindgi", settings: [{tier: "db-custom-1-3840", deletion_protection_enabled: true}]},
    after_unknown: {}}}]')"
case_start "the default target, 0.3.0"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED"
ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev")
run "yes"
assert_rc 0 "0.2.0 -> 0.3.0 runs"
assert_out "crossing: 0.3.0$"
assert_out "turns on Google's deletion protection (deletion_protection_enabled)"
assert_out "If a plan says the instance must be replaced, answer no: a"
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.3.0 " "0.3.0's tag is read"
assert_out "plan check: it changes the image(s)"
assert_out "0.2.0 -> 0.3.0 applied"

# 49. The same change on a server fix for 0.2.0 crosses no release, but the
# module here is 0.3.0's, and the plan makes its change all the same: it's
# allowed, listed as the module's, and the run says the module goes ahead of
# the runtime.
case_start "0.3.0's module change, on a server fix for 0.2.0"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED"
run "yes" --to 0.2.0.1
assert_rc 0 "the module's own change passes"
assert_out "the module here is this copy's, as of 0.3.0: the plan also makes its changes for the releases after 0.2.0"
assert_out "To keep the module at 0.2.0, use this script as of the @kindgi/sdk@0.2.0 tag or, before that release is out, its newest @kindgi/sdk@0.2.0-rc.N tag."
assert_out "none: 0.2.0.1 is a server fix for 0.2.0."
assert_out "0.3.0 (this module's changes only; the runtime goes to 0.2.0.1):"
assert_out "turns on Google's deletion protection (deletion_protection_enabled)"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

# 49b. A change no release names (the instance's tier, a variable changed by
# hand): the plan check names it and stops before it asks, and nothing is
# applied.
INSTANCE_TIER="$(jq -cn '[{address: "google_sql_database_instance.kindgi[0]", mode: "managed",
  type: "google_sql_database_instance", name: "kindgi", index: 0,
  change: {actions: ["update"],
    before: {name: "kindgi", settings: [{tier: "db-custom-1-3840", deletion_protection_enabled: true}]},
    after: {name: "kindgi", settings: [{tier: "db-custom-2-7680", deletion_protection_enabled: true}]},
    after_unknown: {}}}]')"
case_start "a change no release names"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_TIER"
run "yes" --to 0.3.0
assert_rc 1 "an unnamed change stops it"
assert_out "PLAN CHECK: the plan changes more than this upgrade does"
assert_file_has "$OUT" "    google_sql_database_instance.kindgi[0]: changes settings.tier" "the change, by its path"
if grep -q "db-custom" "$OUT"; then fail "a value was printed"; else pass; fi
assert_out "the plan check failed (above), so nothing was applied"
if grep -q "Apply this plan" "$OUT"; then fail "it asked for yes after the check stopped it"; else pass; fi
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a stopped plan was kept"; else pass; fi

# 50. A pack env left off the command: the plan drops the pack's env vars, and
# the check names each one it drops, never a value. A var it keeps, moved in
# the list, isn't named.
PACK_ENV_DROPPED="$(jq -cn --arg img "$OLD_PACK" '
  {name: "KINDGI_PACK_SERVICE_TOKEN", value: "", value_source: [{secret_key_ref: [{secret: "kindgi-pack-token", version: "latest"}]}]} as $token
  | [{address: "google_cloud_run_v2_service.pack[0]", mode: "managed", type: "google_cloud_run_v2_service", name: "pack", index: 0,
     change: {actions: ["update"],
       before: {template: [{containers: [{image: $img, env: [
         {name: "SHOP_URL", value: "https://shop.acme.example", value_source: []},
         $token,
         {name: "SHOP_API_KEY", value: "", value_source: [{secret_key_ref: [{secret: "acme-shop-key", version: "2"}]}]}]}]}]},
       after: {template: [{containers: [{image: $img, env: [$token]}]}]},
       after_unknown: {}}}]')"
case_start "the plan drops the pack's env"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_ENV_DROPPED"; V_PACK="$OLD_PACK"
run "yes"
assert_rc 1 "a plan that drops the pack's env stops"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.env.SHOP_URL" "SHOP_URL named"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.env.SHOP_API_KEY" "SHOP_API_KEY named"
if [[ "$(grep -c "env.SHOP_URL" "$OUT")" == 1 ]]; then pass; else fail "SHOP_URL should be named once"; fi
if grep -q "KINDGI_PACK_SERVICE_TOKEN" "$OUT"; then fail "a var the plan keeps was named"; else pass; fi
if grep -q -e "shop.acme.example" -e "acme-shop-key" "$OUT"; then fail "a value was printed"; else pass; fi
assert_out "give each file the deployment uses its own --var-file"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 51. The same in a dry run: it says a real run would stop there.
case_start "dry run, the plan drops the pack's env"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_ENV_DROPPED"; V_PACK="$OLD_PACK"
run "yes" --dry-run
assert_rc 1 "a dry run whose plan drops the pack's env fails"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.env.SHOP_URL" "SHOP_URL named"
assert_out "upgrade (dry run): a real run would stop at this plan (above). Nothing was changed."
assert_reads_only
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_varfile_unchanged

# 52. The pack's env in a file of its own, given with a second --var-file:
# terraform reads both, in order, the run lists both and says which one the
# image goes in, only that one changes, and the go-back applies with both.
case_start "two var files"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1; V_PACK="$OLD_PACK"
PACK_ENV_FILE="$CASE_DIR/dev.pack-env.tfvars.json"
jq -n '{pack_env: {SHOP_URL: "https://shop.acme.example"}, pack_secret_env: {}}' >"$PACK_ENV_FILE"
cp "$PACK_ENV_FILE" "$CASE_DIR/original-pack-env.json"
run "yes" --var-file "$PACK_ENV_FILE"
assert_rc 1 "the apply fails, after both files were read"
assert_file_has "$STUB_CALLS_LOG" "terraform console -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE" "console reads both"
assert_file_has "$STUB_CALLS_LOG" "terraform plan -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE -out=" "the plan reads both"
assert_file_has "$OUT" "var file        $VAR_FILE (the new image goes in here)" "the image's file listed"
assert_file_has "$OUT" "var file        $PACK_ENV_FILE" "the pack env's file listed"
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the go-back doesn't plan with both var files"; fi
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"" "the image went into the file that sets it"
if cmp -s "$PACK_ENV_FILE" "$CASE_DIR/original-pack-env.json"; then pass; else fail "the pack env's file changed"; fi

# 53. Two var files that set server_image: refused before anything is read.
case_start "two var files set server_image"
reset_env; export STUB_TAGS="0.1.10"
OTHER="$CASE_DIR/other.tfvars"; printf 'server_image = "%s"\n' "$RUNNING_IMAGE" >"$OTHER"
run "yes" --var-file "$OTHER"
assert_rc 1 "two server_image files refused"
assert_file_has "$OUT" "both $VAR_FILE and $OTHER set server_image." "both named"
assert_absent "$STUB_CALLS_LOG" "a call"
assert_varfile_unchanged

# 54. A pack rebuild writes pack_image beside server_image: a second file that
# sets it too is refused before anything is mirrored.
case_start "a second var file sets pack_image, with a pack rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
OTHER="$CASE_DIR/pack.tfvars"; printf 'pack_image = "%s"\n' "$OLD_PACK" >"$OTHER"
run "yes" --var-file "$OTHER" --pack-dir "$PACK_DIR"
assert_rc 1 "a second pack_image refused"
assert_file_has "$OUT" "$OTHER sets pack_image too" "the second file named"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

# 55. What Terraform loads on its own is listed: terraform.tfvars, an
# .auto.tfvars.json beside it, and TF_VAR_ names, never their values.
case_start "what Terraform loads on its own"
reset_env; export STUB_TAGS="0.1.10"
printf 'region = "northamerica-northeast2"\n' >"$CASE_DIR/terraform.tfvars"
printf '{}\n' >"$CASE_DIR/dev.pack-env.auto.tfvars.json"
export TF_VAR_pack_secret_env='{"SHOP_API_KEY":"acme-shop-key"}'
run "yes" --dry-run
unset TF_VAR_pack_secret_env
assert_rc 0 "a dry run exits 0"
assert_out "also loaded    terraform.tfvars (Terraform loads it from this directory on its own)"
assert_out "also loaded    dev.pack-env.auto.tfvars.json (Terraform loads it"
assert_out "also set       TF_VAR_pack_secret_env (in the environment)"
if grep -q "acme-shop-key" "$OUT"; then fail "a TF_VAR_ value was printed"; else pass; fi

# 56. connector, a private-IP database: the jobs go through the connector to
# private ranges, mount no socket, and get the instance's CAs, trimmed and
# joined as the module joins them. The go-back keeps the URL's host.
case_start "connector, a private-IP database"
reset_env; export STUB_TAGS="0.1.10" STUB_DB_PUBLIC=false STUB_APPLY_RC=1
V_NET="connector"; V_CONNECTOR="projects/demo-proj/locations/northamerica-northeast2/connectors/acme"
V_DB_PRIVATE="projects/demo-proj/global/networks/acme"
run "yes"
assert_rc 1 "the apply fails, after the checks ran"
assert_out "on instance kindgi (private IP)"
assert_file_has "$STUB_JOBS_LOG" "--vpc-connector=$V_CONNECTOR --vpc-egress=private-ranges-only" "the jobs go through the connector"
if grep -q -e "--set-cloudsql-instances" -e "--network=" "$STUB_JOBS_LOG"; then fail "a private-IP job got the socket or a subnet"; else pass; fi
assert_file_has "$STUB_JOBS_LOG" "--env-vars-file=" "the jobs get an env file"
if [[ "$(jq -r .KINDGI_DATABASE_SERVER_CA "$STUB_JOB_ENV_SAW" 2>/dev/null)" == $'CA-ONE\nCA-TWO' ]]; then pass
else fail "the jobs' CAs aren't the instance's, trimmed and joined: $(cat "$STUB_JOB_ENV_SAW" 2>/dev/null)"; fi
assert_out "and the host, port and sslmode=require of its current version"
if grep -q "host=/cloudsql" "$OUT"; then fail "the go-back names the socket for a private-IP database"; else pass; fi

# 57. connector, the database on its public IP: the server has no VPC access
# then, so neither do the jobs; they mount the socket.
case_start "connector, a public-IP database"
reset_env; export STUB_TAGS="0.1.10"
V_NET="connector"; V_CONNECTOR="projects/demo-proj/locations/northamerica-northeast2/connectors/acme"
run "yes"
assert_rc 0 "connector runs"
assert_file_has "$STUB_JOBS_LOG" "--set-cloudsql-instances=demo-proj:northamerica-northeast2:kindgi" "the jobs mount the socket"
if grep -q -e "--vpc-connector" -e "--network=" -e "--env-vars-file" "$STUB_JOBS_LOG"; then fail "a public-IP job in connector mode got VPC access or the CAs"; else pass; fi

# 58. direct, a private-IP database whose CAs can't be read: it stops before
# anything is mirrored.
case_start "a private-IP database lists no CA"
reset_env; export STUB_TAGS="0.1.10" STUB_DB_PUBLIC=false STUB_DB_CA="[]"
V_NET="direct"; V_DB_PRIVATE="projects/demo-proj/global/networks/acme"
run "yes"
assert_rc 1 "no CA stops it"
assert_out "couldn't read instance kindgi's server CAs"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 59. 0.2.0's own in-place changes to the pack pass the check when the run
# crosses 0.2.0, and stop it when it doesn't.
PACK_020="$(jq -cn --arg img "$OLD_PACK" '
  def pack($idle; $boost; $p; $t; $f):
    {template: [{containers: [{image: $img,
      resources: [{cpu_idle: $idle, startup_cpu_boost: $boost, limits: {cpu: "1", memory: "1Gi"}}],
      startup_probe: [{period_seconds: $p, timeout_seconds: $t, failure_threshold: $f, http_get: [{path: "/readyz", port: 8080}]}]}]}]};
  [{address: "google_cloud_run_v2_service.pack[0]", mode: "managed", type: "google_cloud_run_v2_service", name: "pack", index: 0,
    change: {actions: ["update"], before: pack(null; false; 5; 3; 24), after: pack(true; true; 2; 1; 60), after_unknown: {}}}]')"
case_start "0.2.0's in-place changes to the pack, crossing 0.2.0"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_020"; V_PACK="$OLD_PACK"
run "yes"
assert_rc 0 "0.2.0's pack changes pass"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

case_start "0.2.0's in-place changes to the pack, on a server fix"
reset_env "$OLD_PACK"; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$PACK_020"; V_PACK="$OLD_PACK"
run "yes" --to 0.2.0.1
assert_rc 1 "the same changes stop a server fix"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.resources.cpu_idle" "cpu_idle named"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.startup_probe.period_seconds" "the probe named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 60. A replace stops it, whatever the releases crossed.
case_start "the plan replaces the instance"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES='[{"address":"google_sql_database_instance.kindgi[0]","mode":"managed","type":"google_sql_database_instance","name":"kindgi","index":0,"change":{"actions":["delete","create"],"before":{"name":"kindgi"},"after":{"name":"kindgi"},"after_unknown":{}}}]'
run "yes" --to 0.3.0
assert_rc 1 "a replace stops it"
assert_file_has "$OUT" "    google_sql_database_instance.kindgi[0]: replaced: deleted and created again" "the replace named"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 61. A value known only after the apply counts as a change.
case_start "a value known only after the apply"
reset_env; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES='[{"address":"google_service_account.server","mode":"managed","type":"google_service_account","name":"server","change":{"actions":["update"],"before":{"email":"kindgi-server@demo-proj.iam.gserviceaccount.com"},"after":{},"after_unknown":{"email":true}}}]'
run "yes"
assert_rc 1 "an unknown value stops it"
assert_file_has "$OUT" "    google_service_account.server: changes email" "the unknown named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 62. A plan that leaves the server on its image (a value set after the
# var-file, say) stops it.
case_start "the plan keeps the server's image"
reset_env; export STUB_TAGS="0.1.10" STUB_PLAN_KEEP_IMAGE=1
run "yes"
assert_rc 1 "a plan without the new image stops it"
assert_file_has "$OUT" "PLAN CHECK: the plan doesn't point the server at $NEW_IMAGE (it has $RUNNING_IMAGE)." "the image named"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 63. A file Terraform loads on its own that sets server_image, beside the
# var-file: a later apply without that --var-file would put its image back,
# so it stops before anything is mirrored.
case_start "an auto-loaded file sets server_image"
reset_env; export STUB_TAGS="0.1.10"
printf 'server_image = "%s"\n' "$RUNNING_IMAGE" >"$CASE_DIR/terraform.tfvars"
run "yes"
assert_rc 1 "an auto-loaded server_image stops it"
assert_out "terraform.tfvars sets server_image, and Terraform loads it from this directory on its own"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 64. The same for pack_image, with a pack rebuild; without one, the pack's
# image isn't written, so the file may set it.
case_start "an auto-loaded file sets pack_image, with a pack rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
printf '{"pack_image": "%s"}\n' "$OLD_PACK" >"$CASE_DIR/dev.pack.auto.tfvars.json"
run "yes" --pack-dir "$PACK_DIR"
assert_rc 1 "an auto-loaded pack_image stops a rebuild"
assert_out "dev.pack.auto.tfvars.json sets pack_image, and Terraform loads it from this directory on its own"
assert_absent "$STUB_MARKER_MIRROR" "mirror"

case_start "an auto-loaded file sets pack_image, no rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
printf '{"pack_image": "%s"}\n' "$OLD_PACK" >"$CASE_DIR/dev.pack.auto.tfvars.json"
run "yes"
assert_rc 0 "without a rebuild it runs"
assert_out "also loaded    dev.pack.auto.tfvars.json"

# 65. An env var known only after the apply is named by its name, as a
# changed one is, never by the attribute that's unknown.
PACK_ENV_UNKNOWN="$(jq -cn --arg img "$OLD_PACK" '
  [{address: "google_cloud_run_v2_service.pack[0]", mode: "managed", type: "google_cloud_run_v2_service", name: "pack", index: 0,
    change: {actions: ["update"],
      before: {template: [{containers: [{image: $img, env: [{name: "KINDGI_ENV", value: "dev"}, {name: "SHOP_URL", value: null}]}]}]},
      after: {template: [{containers: [{image: $img, env: [{name: "KINDGI_ENV", value: "dev"}, {name: "SHOP_URL", value: null}]}]}]},
      after_unknown: {template: [{containers: [{env: [{}, {value: true}]}]}]}}}]')"
case_start "an env var known only after the apply"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_ENV_UNKNOWN"; V_PACK="$OLD_PACK"
run "yes"
assert_rc 1 "an unknown env value stops it"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.env.SHOP_URL" "the env var named"
if grep -q "env.value" "$OUT"; then fail "the unknown attribute stood for the name"; else pass; fi

# 66. 0.1.10's change to the pack's VPC access was in none mode only: there it
# passes, and in direct mode it stops.
PACK_VPC="$(jq -cn --arg img "$OLD_PACK" '
  [{address: "google_cloud_run_v2_service.pack[0]", mode: "managed", type: "google_cloud_run_v2_service", name: "pack", index: 0,
    change: {actions: ["update"],
      before: {template: [{containers: [{image: $img}], vpc_access: [{egress: "PRIVATE_RANGES_ONLY", network_interfaces: [{network: "kindgi", subnetwork: "kindgi-run"}]}]}]},
      after: {template: [{containers: [{image: $img}], vpc_access: []}]},
      after_unknown: {}}}]')"
case_start "0.1.10's pack VPC access change, in none mode"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.9" STUB_PLAN_CHANGES="$PACK_VPC"; V_PACK="$OLD_PACK"
run "yes"
assert_rc 0 "it passes in none mode"
assert_out "plan check: it changes the image(s)"

case_start "0.1.10's pack VPC access change, in direct mode"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.9" STUB_PLAN_CHANGES="$PACK_VPC"; V_PACK="$OLD_PACK"; V_NET="direct"
run "yes"
assert_rc 1 "it stops in direct mode"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.vpc_access.egress" "the VPC access named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 67. A var file whose path has a space: the go-back's command quotes it, so
# it pastes as one argument.
case_start "a var file whose path has a space"
reset_env; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1
SPACED="$CASE_DIR/pack env.tfvars.json"; printf '{}\n' >"$SPACED"
run "yes" --var-file "$SPACED"
assert_rc 1 "the apply fails"
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$CASE_DIR/pack\\ env.tfvars.json -out=back.tfplan)" "$OUT"; then pass
else fail "the go-back doesn't quote the path: $(grep -F "terraform plan -var-file" "$OUT")"; fi

# 68. tests/scrub_plan.sh: the fixture it makes from a saved plan holds no
# values and is private, the plan check reads it as it reads the plan, and it
# won't write over a file.
case_start "a plan scrubbed into a fixture"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
SAVED="$CASE_DIR/saved.tfplan"; FIXTURE="$CASE_DIR/fixture.json"
jq -n --argjson rc "$PACK_ENV_DROPPED" \
  '{format_version: "1.2", variables: {pack_secret_env: {value: {SHOP_API_KEY: "acme-secret"}}}, prior_state: {values: "acme-state"}, resource_changes: $rc}' >"$SAVED"
( cd "$CASE_DIR" && "$HERE/scrub_plan.sh" "$SAVED" "$FIXTURE" ) >"$OUT" 2>&1; rc=$?
assert_rc 0 "it writes the fixture"
if grep -q -e "shop.acme.example" -e "acme-shop-key" -e "kindgi-pack-token" -e "acme-secret" -e "acme-state" -e "pack@sha256" "$FIXTURE"; then
  fail "a value is in the fixture"; else pass; fi
if [[ "$(ls -l "$FIXTURE" | cut -c1-10)" == "-rw-------" ]]; then pass; else fail "the fixture is readable by others: $(ls -l "$FIXTURE")"; fi
if grep -q "SHOP_" "$FIXTURE"; then fail "the deployment's env names are in the fixture"; else pass; fi
assert_file_has "$FIXTURE" '"KINDGI_PACK_SERVICE_TOKEN"' "a runtime env var keeps its name"
export STUB_PLAN_CHANGES; STUB_PLAN_CHANGES="$(jq -c .resource_changes "$FIXTURE")"
run "yes"
assert_rc 1 "the check stops at the fixture as at the plan"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.env.ENV_1" "SHOP_API_KEY named by its placeholder"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.env.ENV_2" "SHOP_URL named by its placeholder"
if grep -q "KINDGI_PACK_SERVICE_TOKEN" "$OUT"; then fail "a var the plan keeps was named"; else pass; fi
( cd "$CASE_DIR" && "$HERE/scrub_plan.sh" "$SAVED" "$FIXTURE" ) >"$OUT" 2>&1; rc=$?
assert_rc 1 "it won't write over the fixture"
assert_out "fixture.json exists"

# 69. tests/scrub_plan.sh: a for_each key is the deployment's, so the fixture
# gives it a placeholder, the same in the index and the address, and the plan
# check names the resource by it. A plan whose resources sit in a module call
# isn't this module's: nothing is written.
case_start "a plan's for_each keys scrubbed"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
SAVED="$CASE_DIR/saved.tfplan"; FIXTURE="$CASE_DIR/fixture.json"
jq -n --argjson rc "$PACK_ENV_DROPPED" '
  {format_version: "1.2", resource_changes: ($rc + [
    {address: "google_secret_manager_secret_iam_member.pack_reads_its_secrets[\"SHOP_API_KEY\"]", mode: "managed",
     type: "google_secret_manager_secret_iam_member", name: "pack_reads_its_secrets", index: "SHOP_API_KEY",
     change: {actions: ["delete"], before: {secret_id: "acme-shop-key", member: "serviceAccount:pack@acme-project.iam.gserviceaccount.com"},
              after: null, after_unknown: {}}},
    {address: "google_storage_bucket_iam_member.pack_reads[\"acme-orders\"]", mode: "managed",
     type: "google_storage_bucket_iam_member", name: "pack_reads", index: "acme-orders",
     change: {actions: ["no-op"], before: {bucket: "acme-orders"}, after: {bucket: "acme-orders"}, after_unknown: {}}}])}' >"$SAVED"
( cd "$CASE_DIR" && "$HERE/scrub_plan.sh" "$SAVED" "$FIXTURE" ) >"$OUT" 2>&1; rc=$?
assert_rc 0 "it writes the fixture"
if grep -q -e "SHOP_" -e "acme" "$FIXTURE"; then fail "a for_each key or a value is in the fixture"; else pass; fi
want='google_cloud_run_v2_service.pack[0] 0
google_secret_manager_secret_iam_member.pack_reads_its_secrets["k1"] k1
google_storage_bucket_iam_member.pack_reads["k2"] k2'
got="$(jq -r '.resource_changes[] | "\(.address) \(.index)"' "$FIXTURE")"
if [[ "$got" == "$want" ]]; then pass; else fail "the addresses and indexes: $got"; fi
export STUB_PLAN_CHANGES; STUB_PLAN_CHANGES="$(jq -c .resource_changes "$FIXTURE")"
run "yes"
assert_rc 1 "the check stops at the fixture"
assert_file_has "$OUT" "    google_secret_manager_secret_iam_member.pack_reads_its_secrets[\"k1\"]: deleted" "the resource named by its placeholder"
if grep -q "pack_reads\[" "$OUT"; then fail "a no-op was named"; else pass; fi
MODULE_SAVED="$CASE_DIR/module.tfplan"; MODULE_FIXTURE="$CASE_DIR/module-fixture.json"
jq '.resource_changes[0].module_address = "module.kindgi"' "$SAVED" >"$MODULE_SAVED"
( cd "$CASE_DIR" && "$HERE/scrub_plan.sh" "$MODULE_SAVED" "$MODULE_FIXTURE" ) >"$OUT" 2>&1; rc=$?
assert_rc 1 "a plan with a module call is refused"
assert_out "make it from this module directory"
if ls "$MODULE_FIXTURE"* >/dev/null 2>&1; then fail "a refused plan left a file"; else pass; fi

# 70. The image set in the environment: a later apply reads TF_VAR_ too, so
# it stops before anything is mirrored, as for an auto-loaded file. pack_image
# only with a rebuild.
case_start "TF_VAR_server_image set"
reset_env; export STUB_TAGS="0.1.10"
export TF_VAR_server_image="$RUNNING_IMAGE"
run "yes"
unset TF_VAR_server_image
assert_rc 1 "TF_VAR_server_image stops it"
assert_out "TF_VAR_server_image is set in the environment: a later apply without -var-file=$VAR_FILE would put its image back."
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

case_start "TF_VAR_pack_image set, with a pack rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
export TF_VAR_pack_image="$OLD_PACK"
run "yes" --pack-dir "$PACK_DIR"
unset TF_VAR_pack_image
assert_rc 1 "TF_VAR_pack_image stops a rebuild"
assert_out "TF_VAR_pack_image is set in the environment"
assert_absent "$STUB_MARKER_MIRROR" "mirror"

case_start "TF_VAR_pack_image set, no rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"; V_PACK="$OLD_PACK"
export TF_VAR_pack_image="$OLD_PACK"
run "yes"
unset TF_VAR_pack_image
assert_rc 0 "without a rebuild it runs"
assert_out "also set       TF_VAR_pack_image (in the environment)"

# --- previews ---------------------------------------------------------------
# A preview built from the runtime's main (X.Y.Z-preview.N) is a version a
# deployment can run: it's read from its tag (beside the moving "preview"
# one), ranks below its release's rcs, and upgrades to them, to the final or
# to a later release.
# It's never a target, since it has no release steps.
case_start "a preview read from its tag, to its release's final"
reset_env; export STUB_TAGS="0.2.0-preview.0;preview"
run "yes"
assert_rc 0 "preview -> final runs"
assert_out "read 0.2.0-preview.0 from the mirrored image's tag"
assert_out "upgrading 0.2.0-preview.0 -> 0.2.0, crossing: 0.2.0"
assert_out "0.2.0-preview.0 -> 0.2.0 applied"

case_start "a preview to its release's rc"
reset_env; export STUB_TAGS="0.2.0-preview.3"
run "yes" --to 0.2.0-rc.0
assert_rc 0 "preview -> rc runs"
assert_out "upgrading 0.2.0-preview.3 -> 0.2.0-rc.0, crossing: 0.2.0"

case_start "a preview to a later release"
reset_env; export STUB_TAGS="0.2.0-preview.0"
run "yes" --to 0.3.0
assert_rc 0 "preview -> a later release runs"
assert_out "upgrading 0.2.0-preview.0 -> 0.3.0, crossing: 0.2.0 0.3.0"
assert_out "0.2.0-preview.0 -> 0.3.0 applied"

case_start "--from a preview"
reset_env
run "yes" --from 0.2.0-preview.1
assert_rc 0 "--from a preview runs"
assert_out "using --from 0.2.0-preview.1"

case_start "a target older than the preview"
reset_env; export STUB_TAGS="0.3.0-preview.0"
run "yes" --to 0.2.0
assert_rc 1 "an older target refused"
assert_out "already on 0.3.0-preview.0, at or past the target 0.2.0"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

case_start "a preview as the target"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.2.0-preview.0
assert_rc 1 "a preview target refused"
assert_out "a preview has no release steps, so it's never a target"
assert_absent "$STUB_MARKER_MIRROR" "mirror"

case_start "go-back from a preview"
reset_env; export STUB_TAGS="0.2.0-preview.0" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures export --out=erasures-" "the export runs the preview's CLI line"
note="$(grep -A4 -F "memory erasures export" "$OUT" | tail -n 4)"
if [[ $note == "    This deployment runs a preview, 0.2.0-preview.0, and no CLI is published
    with a preview. Until 0.2.0 is out, npx finds no @kindgi/cli@0.2: in
    this step and in step 7, name the newest @kindgi/cli that's out
    instead (npm view @kindgi/cli versions lists them)." ]]; then pass
else fail "the preview note isn't right under the export: $note"; fi

# --- the database URL's pin -------------------------------------------------
# The server reads its database URL at one version, database_url_secret_version.
# A var-file from before it gets the line in step 5: the version latest is now,
# read as metadata, never the value. One that sets it keeps it. The checks
# read that version, and the printed way back sets it in the file that sets it.

case_start "the first upgrade pins the database URL"
reset_env; export STUB_TAGS="0.1.10"
run "yes"
assert_rc 0 "the upgrade runs"
assert_file_has "$STUB_CALLS_LOG" "gcloud secrets versions describe latest --secret=kindgi-database-url --project=demo-proj --format=json" "latest's metadata is read"
if grep -q "secrets versions access" "$STUB_CALLS_LOG"; then fail "a secret's value was read"; else pass; fi
assert_out "the server reads version 4 of kindgi-database-url (latest today): step 5 pins it in $VAR_FILE (database_url_secret_version)"
assert_file_has "$STUB_JOBS_LOG" "--set-secrets=KINDGI_DATABASE_URL=kindgi-database-url:4 " "the checks read the version the server reads"
if [[ "$(grep -c '^database_url_secret_version = "4"$' "$VAR_FILE")" == 1 ]]; then pass; else fail "the var-file doesn't pin version 4 once: $(cat "$VAR_FILE")"; fi
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"  # mirrored 0.1.8" "the image line is kept as it was, but for the image"
assert_out "now pins the new image(s) and version 4 of kindgi-database-url; the previous copy is"
if cmp -s "$(ls "$CASE_DIR"/dev.tfvars.pre-upgrade-*)" "$CASE_DIR/original.tfvars"; then pass; else fail "the .pre-upgrade copy isn't the original"; fi
assert_out "plan check: it changes the image(s), and only what the releases crossed change in place."
assert_present "$STUB_MARKER_APPLY" "apply"

case_start "the pin goes on a line of its own after a last line with no newline"
reset_env; export STUB_TAGS="0.1.10"
printf 'tenancy = "single"' >>"$VAR_FILE"
run "yes"
assert_rc 0 "the upgrade runs"
if [[ "$(tail -n 2 "$VAR_FILE")" == $'tenancy = "single"\ndatabase_url_secret_version = "4"' ]]; then pass
else fail "the pin isn't on its own line after the last one: $(tail -n 2 "$VAR_FILE")"; fi

case_start "a pinned var-file keeps its pin"
reset_env; export STUB_TAGS="0.3.0" STUB_DBURL_BEFORE="2" STUB_DBURL_LATEST="5"; V_DBURL="2"
printf 'database_url_secret_version = "2"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes" --to 0.3.0.1
assert_rc 0 "the upgrade runs"
assert_file_has "$STUB_CALLS_LOG" "gcloud secrets versions describe 2 --secret=kindgi-database-url --project=demo-proj --format=json" "the pinned version's metadata is read"
if grep -q "secrets versions describe latest" "$STUB_CALLS_LOG"; then fail "latest was read, with a pin set"; else pass; fi
assert_out "the server reads version 2 of kindgi-database-url (database_url_secret_version), enabled"
assert_file_has "$STUB_JOBS_LOG" "--set-secrets=KINDGI_DATABASE_URL=kindgi-database-url:2 " "the checks read the pinned version, not latest"
if [[ "$(grep -c 'database_url_secret_version' "$VAR_FILE")" == 1 ]] && grep -qx 'database_url_secret_version = "2"' "$VAR_FILE"; then pass
else fail "the pin moved or was added again: $(cat "$VAR_FILE")"; fi
if grep -q "plan got -var" "$STUB_PLAN_SAW"; then fail "the plan was given a -var"; else pass; fi
assert_present "$STUB_MARKER_APPLY" "apply"

# A pin moved by hand, for a server on another: this run never moves it, so
# 2a names both and stops, before the mirror, the checks and the backup.
case_start "a pin moved by hand"
reset_env; export STUB_TAGS="0.3.0" STUB_DBURL_BEFORE="2"; V_DBURL="3"
printf 'database_url_secret_version = "3"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes" --to 0.3.0.1
assert_rc 1 "a moved pin stops it"
assert_out "database_url_secret_version is \"3\" (in $VAR_FILE), but the server reads version 2 of kindgi-database-url: the upgrade's apply would move it to another URL. Set it to \"2\", or move the server to version 3 in an apply on the release it runs now, then run again."
assert_out "a precondition failed (above). Nothing was mirrored, backed up or changed."
if grep -q "secrets versions describe latest" "$STUB_CALLS_LOG"; then fail "latest was read, for a server on a pin"; else pass; fi
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# The plan is the last word: one that moves the pin anyway (here the
# var-file's line, which the stub's console reads as the server's 2) names
# the change and stops at the plan check.
case_start "a plan that moves the pin anyway"
reset_env; export STUB_TAGS="0.3.0" STUB_DBURL_BEFORE="2"; V_DBURL="2"
printf 'database_url_secret_version = "3"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes" --to 0.3.0.1
assert_rc 1 "a plan that moves the pin stops it"
assert_out "PLAN CHECK: the plan changes more than this upgrade does"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.KINDGI_DATABASE_URL" "the change, by its name"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

case_start "the pinned version isn't enabled"
reset_env; export STUB_TAGS="0.3.0" STUB_DBURL_BEFORE="2" STUB_DBURL_STATE="DISABLED"; V_DBURL="2"
printf 'database_url_secret_version = "2"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes" --to 0.3.0.1
assert_rc 1 "a disabled pin stops it"
assert_out "database_url_secret_version is \"2\" (in $VAR_FILE), but that version of kindgi-database-url is DISABLED, not enabled: the new revision couldn't read it."
assert_out "a precondition failed (above). Nothing was mirrored, backed up or changed."
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

case_start "latest isn't enabled"
reset_env; export STUB_TAGS="0.1.10" STUB_DBURL_STATE="DESTROYED"
run "yes"
assert_rc 1 "a destroyed latest stops it"
assert_out "version 4 of kindgi-database-url, the one today's server reads (latest), is DESTROYED, not enabled"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

case_start "the URL secret's version can't be read"
reset_env; export STUB_TAGS="0.1.10" STUB_DBURL_RC=1
run "yes"
assert_rc 1 "an unreadable version stops it"
assert_out "couldn't read version latest of kindgi-database-url, the database URL the server reads. ERROR: (gcloud.secrets.versions.describe) NOT_FOUND"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

case_start "a var-file sets the pin to null"
reset_env; export STUB_TAGS="0.1.10"
printf 'database_url_secret_version = null\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes"
assert_rc 1 "a null pin stops it"
assert_out "$VAR_FILE sets database_url_secret_version, but to no version."
assert_out "gcloud secrets versions describe latest --secret=kindgi-database-url --project=demo-proj --format='value(name.basename())'"
if grep -q "secrets versions describe" "$STUB_CALLS_LOG"; then fail "it read the secret before stopping"; else pass; fi
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

case_start "TF_VAR_database_url_secret_version set"
reset_env; export STUB_TAGS="0.1.10"
export TF_VAR_database_url_secret_version="4"
run "yes"
unset TF_VAR_database_url_secret_version
assert_rc 1 "TF_VAR_database_url_secret_version stops it"
assert_out "TF_VAR_database_url_secret_version is set in the environment: the way back this script prints changes the pin in a var file."
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

case_start "dry run, a pinned var-file"
reset_env; export STUB_TAGS="0.3.0" STUB_DBURL_BEFORE="2"; V_DBURL="2"
printf 'database_url_secret_version = "2"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes" --to 0.3.0.1 --dry-run
assert_rc 0 "a dry run exits 0"
if grep -q "add database_url_secret_version" "$OUT"; then fail "a pinned dry run lists adding the pin"; else pass; fi
if grep "^terraform plan" "$STUB_CALLS_LOG" | grep -q "database_url_secret_version"; then fail "the plan was given the pin, with one set"; else pass; fi
assert_reads_only
assert_varfile_unchanged

# The way back: step 4 adds a version, N; step 5 copies the var-file back and
# sets the pin to N in the file that sets it, so the old image and the fresh
# database go in together.
case_start "go-back, a var-file this run pinned"
reset_env; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
if grep -A1 -F "No revision of the new version reads it: they read version" "$OUT" | grep -qxF "    4 (database_url_secret_version), so no instance of it"; then pass
else fail "the go-back doesn't say the new version's revisions read version 4"; fi
assert_out "A revision from before the upgrade reads latest, so it may read it: that's"
if grep -qxF "    then add database_url_secret_version = \"<N>\" to $VAR_FILE: the copy, from before the upgrade, has no pin." "$OUT"; then pass
else fail "the go-back doesn't add the pin to the copy: $(grep -F 'then ' "$OUT")"; fi
step4="$(grep -n -F ' 4. Add a new version of the secret kindgi-database-url' "$OUT" | head -n 1 | cut -d: -f1)"
step5="$(grep -n -F ' 5. Put the old image(s) back and point the server at version N:' "$OUT" | head -n 1 | cut -d: -f1)"
step6="$(grep -n -F ' 6. Apply the saved plan.' "$OUT" | head -n 1 | cut -d: -f1)"
if [[ -n $step4 && -n $step5 && -n $step6 ]] && (( step4 < step5 && step5 < step6 )); then pass
else fail "the go-back's steps 4-6 aren't add a version, then image and pin, then apply ($step4 $step5 $step6)"; fi
if grep -qF "apply right after" "$OUT"; then fail "the go-back still races an instance of the new version"; else pass; fi

case_start "go-back, a pin set in the var-file"
reset_env; export STUB_TAGS="0.3.0" STUB_APPLY_RC=1 STUB_DBURL_BEFORE="2"; V_DBURL="2"
printf 'database_url_secret_version = "2"\n' >>"$VAR_FILE"
run "yes" --to 0.3.0.1
assert_rc 1 "apply failure"
if grep -qxF "    then set database_url_secret_version = \"<N>\" in $VAR_FILE: the copy has \"2\", the version the server reads now." "$OUT"; then pass
else fail "the go-back doesn't set the pin in the var-file: $(grep -F 'then ' "$OUT")"; fi
if grep -qF "reads latest" "$OUT"; then fail "a pinned deployment's go-back says a revision reads latest"; else pass; fi

# Terraform reads *.auto.tfvars and *.auto.tfvars.json in one lexical order:
# b.auto.tfvars comes after a.auto.tfvars.json, so its pin is the one read.
case_start "go-back, a pin set in an auto-loaded file"
reset_env; export STUB_TAGS="0.3.0" STUB_APPLY_RC=1 STUB_DBURL_BEFORE="2"; V_DBURL="2"
jq -n '{database_url_secret_version: "3"}' >"$CASE_DIR/a.auto.tfvars.json"
printf 'database_url_secret_version = "2"\n' >"$CASE_DIR/b.auto.tfvars"
run "yes" --to 0.3.0.1
assert_rc 1 "apply failure"
assert_out "the server reads version 2 of kindgi-database-url (database_url_secret_version), enabled"
if grep -qxF "    then set database_url_secret_version = \"<N>\" in b.auto.tfvars, which sets it (to \"2\" now)." "$OUT"; then pass
else fail "the go-back doesn't set the pin in the file Terraform reads it from: $(grep -F 'then ' "$OUT")"; fi
if grep -q "database_url_secret_version" "$VAR_FILE"; then fail "the var-file got a pin another file sets"; else pass; fi

case_start "go-back, a pin set in a second var file"
reset_env; export STUB_TAGS="0.3.0" STUB_APPLY_RC=1 STUB_DBURL_BEFORE="2"; V_DBURL="2"
DB_FILE="$CASE_DIR/db.tfvars"
printf 'database_url_secret_version = "2"\n' >"$DB_FILE"
run "yes" --to 0.3.0.1 --var-file "$DB_FILE"
assert_rc 1 "apply failure"
if grep -qxF "    then set database_url_secret_version = \"<N>\" in $DB_FILE, which sets it (to \"2\" now)." "$OUT"; then pass
else fail "the go-back doesn't set the pin in the second file: $(grep -F 'then ' "$OUT")"; fi

case_start "a .tfvars.json var-file is pinned as JSON"
reset_env; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1
VAR_FILE="$CASE_DIR/dev.tfvars.json"
jq -n --arg img "$RUNNING_IMAGE" '{project_id:"demo-proj", server_image:$img}' >"$VAR_FILE"
ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev" --to 0.2.0)
run "yes"
assert_rc 1 "apply failure"
if [[ "$(jq -r .database_url_secret_version "$VAR_FILE")" == "4" ]]; then pass; else fail "the JSON var-file isn't pinned: $(cat "$VAR_FILE")"; fi
if grep -qxF "    then add \"database_url_secret_version\": \"<N>\" to $VAR_FILE: the copy, from before the upgrade, has no pin." "$OUT"; then pass
else fail "the go-back doesn't give the JSON form: $(grep -F 'then ' "$OUT")"; fi

case_start "a restored instance's URL secret is pinned"
reset_env; export STUB_TAGS="0.1.10"; V_DBI='{"name":"kindgi-r1","url_secret":"kindgi-r1-database-url"}'
run "yes"
assert_rc 0 "the upgrade runs"
assert_file_has "$STUB_CALLS_LOG" "gcloud secrets versions describe latest --secret=kindgi-r1-database-url --project=demo-proj --format=json" "the restored URL secret's latest is read"
assert_out "the server reads version 4 of kindgi-r1-database-url (latest today)"


# A pin set by hand for a server whose module is from before it (it reads
# latest): the upgrade's apply moves the server onto the pin, so the pin
# must be latest's version now. The server's own reference says which.
case_start "a pin added by hand for a server that reads latest"
reset_env; export STUB_TAGS="0.1.10"; V_DBURL="4"
printf 'database_url_secret_version = "4"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes"
assert_rc 0 "the upgrade runs"
assert_out "the server reads latest today, the same version: step 5's apply pins it there"
assert_file_has "$STUB_CALLS_LOG" "gcloud secrets versions describe latest --secret=kindgi-database-url --project=demo-proj --format=json" "latest's metadata is read"
assert_file_has "$STUB_JOBS_LOG" "--set-secrets=KINDGI_DATABASE_URL=kindgi-database-url:4 " "the checks read the pin"
assert_out "plan check: it changes the image(s), and only what the releases crossed change in place."
if [[ "$(grep -c 'database_url_secret_version' "$VAR_FILE")" == 1 ]] && grep -qx 'database_url_secret_version = "4"' "$VAR_FILE"; then pass
else fail "the hand-set pin moved or was added again: $(cat "$VAR_FILE")"; fi
if grep -q "plan got -var" "$STUB_PLAN_SAW"; then fail "the plan was given a -var"; else pass; fi
assert_present "$STUB_MARKER_APPLY" "apply"

case_start "a pin added by hand that isn't latest's version"
reset_env; export STUB_TAGS="0.1.10" STUB_DBURL_LATEST="4"; V_DBURL="3"
printf 'database_url_secret_version = "3"\n' >>"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes"
assert_rc 1 "a hand-set pin that isn't latest's stops it"
assert_out "database_url_secret_version is \"3\" (in $VAR_FILE), but the server reads latest, version 4 of kindgi-database-url: the upgrade's apply would move it to another URL. Set it to \"4\", or remove the line and this script adds it, then run again."
assert_out "a precondition failed (above). Nothing was mirrored, backed up or changed."
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

case_start "go-back, a pin added by hand for a server that read latest"
reset_env; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1; V_DBURL="4"
printf 'database_url_secret_version = "4"\n' >>"$VAR_FILE"
run "yes"
assert_rc 1 "apply failure"
assert_out "A revision from before the upgrade reads latest, so it may read it: that's"
if grep -qxF "    then set database_url_secret_version = \"<N>\" in $VAR_FILE: the copy has \"4\", the version the server reads now." "$OUT"; then pass
else fail "the go-back doesn't set the pin in the var-file: $(grep -F 'then ' "$OUT")"; fi

# An rc of the release that adds the pin already reads one: its upgrade to
# the final keeps the pin, though latest has moved on, and its way back
# doesn't say a revision reads latest.
case_start "an rc's server on a pin, to its final, latest moved on"
reset_env; export STUB_TAGS="0.3.0-rc.0" STUB_APPLY_RC=1 STUB_DBURL_BEFORE="2" STUB_DBURL_LATEST="5"; V_DBURL="2"
printf 'database_url_secret_version = "2"\n' >>"$VAR_FILE"
run "yes" --to 0.3.0
assert_rc 1 "apply failure"
if grep -q "CHECK FAILED" "$OUT"; then fail "a check failed: $(grep 'CHECK FAILED' "$OUT")"; else pass; fi
if grep -q "secrets versions describe latest" "$STUB_CALLS_LOG"; then fail "latest was read, for a server on a pin"; else pass; fi
assert_out "the server reads version 2 of kindgi-database-url (database_url_secret_version), enabled"
if grep -qF "reads latest" "$OUT"; then fail "the go-back says a revision reads latest"; else pass; fi

case_start "a server on a pin, a var-file without one"
reset_env; export STUB_TAGS="0.3.0" STUB_DBURL_BEFORE="2" STUB_DBURL_LATEST="5"
run "yes" --to 0.3.0.1
assert_rc 1 "a missing pin for a pinned server stops it"
assert_out "the server reads version 2 of kindgi-database-url, but no var file sets database_url_secret_version. Set database_url_secret_version = \"2\" in $VAR_FILE, then run again."
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_varfile_unchanged

case_start "the server's database URL reference can't be read"
for shape in none two; do
  reset_env; export STUB_TAGS="0.1.10"
  if [[ $shape == none ]]; then export STUB_DBURL_BEFORE="-"; else export STUB_DBURL_TWICE=1; fi
  run "yes"
  assert_rc 1 "a server read with $shape KINDGI_DATABASE_URL stops it"
  assert_out "couldn't read which version of kindgi-database-url the server reads (one KINDGI_DATABASE_URL secret reference)."
  if grep -q "valueFrom\|secretKeyRef\|KINDGI_ENV" "$OUT"; then fail "the service's env was printed ($shape)"; else pass; fi
  assert_absent "$STUB_MARKER_MIRROR" "mirror"
  assert_varfile_unchanged
done

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
