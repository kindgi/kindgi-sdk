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
# The module's declarations, which the terraform stub's console checks the
# var files against.
export STUB_MODULE_DIR="$HERE/.."

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
SEED_TENANT="7f0c2a8e-1d3b-4a5c-9e6f-0123456789ab"
SERVER_URL="https://kindgi-server-xxx.a.run.app"

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
    if [[ "$*" == *"--format=json"* ]]; then printf '%s' "${STUB_SERVICE_JSON:-}"
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
# Real terraform console prints a warning on stdout, ahead of the value, for
# each variable a var file sets that its config ($2) doesn't declare. Each is
# logged to STUB_WARNED as "<$1> <name>".
warn_undeclared() {
  local read="$1" decl="$2" f n names; shift 2
  for f in "$@"; do
    if [[ $f == *.json ]]; then names="$(jq -r 'keys[]' "$f")"
    else names="$(sed -nE 's/^([A-Za-z_][A-Za-z0-9_-]*)[[:space:]]*=.*/\1/p' "$f")"; fi
    for n in $names; do
      if grep -qE "^variable \"$n\" " "$decl"/*.tf; then continue; fi
      printf '%s %s\n' "$read" "$n" >>"${STUB_WARNED:-/dev/null}"
      printf '\nWarning: Value for undeclared variable\n\nThe root module does not declare a variable named "%s" but a value was\nfound in file "%s". If you meant to use this value, add a "variable" block\nto the configuration.\n\nTo silence these warnings, use TF_VAR_... environment variables to provide\ncertain "global" settings to all configurations in your organization. To\nreduce the verbosity of these warnings, use the -compact-warnings option.\n' "$n" "$f"
    done
  done
}
case "${1:-}" in
  output) printf '%s' "${STUB_TF_OUTPUTS:-}"; exit 0 ;;
  console)
    # From the module's directory: the files Terraform loads on its own, then
    # each -var-file.
    shift; cat >/dev/null
    files=()
    for f in terraform.tfvars terraform.tfvars.json *.auto.tfvars *.auto.tfvars.json; do
      if [[ -f $f ]]; then files+=("$f"); fi
    done
    for a in "$@"; do files+=("${a#-var-file=}"); done
    warn_undeclared console "$STUB_MODULE_DIR" ${files[@]+"${files[@]}"}
    printf '%s\n' "${STUB_TF_VARS_RAW:-}"; exit 0 ;;
  -chdir=*)
    # The variables 0.4.0 took out, read in a config of their own that only
    # declares them: from the files given, by absolute path (the config is
    # elsewhere), a later file over an earlier one and TF_VAR_pack_image under
    # both, as terraform reads them. pack_env's names only; .tfvars files
    # give pack_image alone.
    dir="${1#-chdir=}"; shift
    printf '%s\n' "$*" >>"${STUB_REMOVED_SAW:-/dev/null}"
    [[ ${1:-} == console ]] || exit 1
    shift; cat >/dev/null
    if [[ -n ${STUB_REMOVED_RC:-} ]]; then echo "Error: stub refused" >&2; exit "$STUB_REMOVED_RC"; fi
    grep -q '^variable "pack_secret_env"' "$dir/variables.tf" || { echo "no declarations in $dir" >&2; exit 1; }
    vals='{"pack_image":"","pack_min_instances":1,"pack_env_names":[],"pack_secret_env":{}}'
    if [[ -n ${TF_VAR_pack_image:-} ]]; then vals="$(jq -c --arg p "$TF_VAR_pack_image" '.pack_image = $p' <<<"$vals")"; fi
    for a in "$@"; do
      f="${a#-var-file=}"
      [[ $f == /* ]] || { echo "Error: $f isn't an absolute path" >&2; exit 1; }
      if [[ $f == *.json ]]; then
        vals="$(jq -c --slurpfile v "$f" '$v[0] as $f | . + ({pack_image: $f.pack_image,
          pack_min_instances: $f.pack_min_instances,
          pack_env_names: ($f.pack_env | if . == null then null else keys end),
          pack_secret_env: ($f.pack_secret_env | if . == null then null else map_values({secret, version, project: (.project // null)}) end)}
          | with_entries(select(.value != null)))' <<<"$vals")"
      else
        p="$(sed -nE 's/^[[:space:]]*pack_image[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f")"
        if [[ -n $p ]]; then vals="$(jq -c --arg p "$p" '.pack_image = $p' <<<"$vals")"; fi
      fi
    done
    warn_undeclared removed "$dir" "${@#-var-file=}"
    jq -n --argjson v "$vals" '$v | tojson'
    exit 0 ;;
  plan)
    # The plan file is the plan as `terraform show -json` gives it: the server
    # (and the pack, with STUB_PACK_BEFORE) at the image the var files set, a
    # later file over an earlier one and -var over both, as terraform reads
    # them; STUB_PLAN_CHANGES adds resource changes; STUB_SERVER_ENV
    # ({before, after, after_unknown}) adds env entries to the server's own
    # change; STUB_PLAN_KEEP_IMAGE leaves the server's image as it is.
    out="" prev="" img="" pack=""
    for a in "$@"; do
      case "$a" in
        -out=*) out="${a#-out=}" ;;
        -var-file=*)
          f="${a#-var-file=}"
          cat "$f" >>"${STUB_PLAN_SAW:-/dev/null}"
          if [[ $f == *.json ]]; then
            v="$(jq -r '.server_image // empty' "$f")"; p="$(jq -r '.pack_image // empty' "$f")"
          else
            v="$(sed -nE 's/^[[:space:]]*server_image[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f")"
            p="$(sed -nE 's/^[[:space:]]*pack_image[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f")"
          fi
          img="${v:-$img}"; pack="${p:-$pack}" ;;
        -var) printf 'plan got -var\n' >>"${STUB_PLAN_SAW:-/dev/null}" ;;
        server_image=*) if [[ $prev == -var ]]; then img="${a#server_image=}"; fi ;;
      esac
      prev="$a"
    done
    if [[ -n ${STUB_PLAN_KEEP_IMAGE:-} ]]; then img="$STUB_RUNNING_IMAGE"; fi
    if [[ -n $out ]]; then
      jq -n --arg old "$STUB_RUNNING_IMAGE" --arg new "${img:-$STUB_RUNNING_IMAGE}" \
        --arg pold "${STUB_PACK_BEFORE:-}" --arg pnew "${pack:-${STUB_PACK_BEFORE:-}}" \
        --argjson extra "${STUB_PLAN_CHANGES:-[]}" --argjson senv "${STUB_SERVER_ENV:-null}" '
        def svc($n; $addr; $b; $a; $env):
          {name: "KINDGI_ENV", value: "dev", value_source: []} as $base
          | {address: $addr, mode: "managed", type: "google_cloud_run_v2_service", name: $n,
           change: {actions: (if $b == $a and $env == null then ["no-op"] else ["update"] end),
             before: {name: ("kindgi-" + $n), template: [{containers: [{image: $b, env: ([$base] + ($env.before // []))}]}]},
             after: {name: ("kindgi-" + $n), template: [{containers: [{image: $a, env: ([$base] + ($env.after // []))}]}]},
             after_unknown: {template: [{containers: [{env: ([{}] + ($env.after_unknown // []))}]}]}}};
        {format_version: "1.2",
         resource_changes: ([svc("server"; "google_cloud_run_v2_service.server"; $old; $new; $senv)]
           + (if $pold == "" then [] else [svc("pack"; "google_cloud_run_v2_service.pack[0]"; $pold; $pnew; null)] end)
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
    --arg tenancy "${V_TENANCY:-single}" --arg aad "${V_AAD-1}" \
    --arg prefix "${V_PREFIX:-kindgi}" --argjson dbi "${V_DBI:-null}" \
    --arg connector "${V_CONNECTOR:-}" --arg private "${V_DB_PRIVATE:-}" \
    --arg secrets "${V_SECRETS:-postgres}" --arg okv "${V_OKV:-}" --arg hosts "${V_HOSTS:-}" \
    --argjson senv "${V_SENV:-[]}" --argjson ssenv "${V_SSENV:-[]}" '{
    project_id:"demo-proj", region:"northamerica-northeast2", name_prefix:$prefix,
    network_mode:$net, vpc_connector:$connector, database_private_network:$private,
    database_host_instance:(if $host == "" then null else $host end),
    database_name:"kindgi", secrets_backend:$secrets,
    secrets_aad_key_version:(if $aad == "" then null else $aad end),
    tenancy:$tenancy, seed_tenant_id:(if $tenancy == "single" then $seed else null end),
    server_image:$img, database_instance:$dbi,
    orchestrator_key_version:(if $okv == "" then null else $okv end),
    server_env_names:$senv, server_secret_env_names:$ssenv, pack_endpoint_hosts:$hosts}' --arg seed "$SEED_TENANT"
}

SERVICE_READY='{"status":{"conditions":[{"type":"Ready","status":"True"}],"latestReadyRevisionName":"kindgi-server-00002","latestCreatedRevisionName":"kindgi-server-00002"}}'
SERVICE_STUCK='{"status":{"conditions":[{"type":"Ready","status":"Unknown"}],"latestReadyRevisionName":"kindgi-server-00001","latestCreatedRevisionName":"kindgi-server-00002"}}'

# --- harness ----------------------------------------------------------------

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$*"; }

# A fresh case directory, var-file and markers. $1 = a pack_image line to add:
# the one pack service of the releases before 0.4.0, which the variables'
# second read (the -chdir stub) finds in the var-file.
reset_env() {
  unset STUB_TAGS STUB_DB_VERSION STUB_DB_PUBLIC STUB_JOB_CREATE_RC STUB_CHECK_RC \
        STUB_EXPORT_RC STUB_EXPORT_412 STUB_PLAN_RC STUB_APPLY_RC STUB_MIRROR_RC STUB_INSPECT_ERR STUB_SQL_SA \
        STUB_DB_CA STUB_PACK_BEFORE STUB_PLAN_CHANGES STUB_SERVER_ENV STUB_PLAN_KEEP_IMAGE STUB_SHOW_RC \
        STUB_REMOVED_RC \
        V_NET V_HOST V_TENANCY V_AAD V_PREFIX V_DBI V_CONNECTOR V_DB_PRIVATE V_SECRETS V_OKV V_HOSTS V_SENV V_SSENV
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
  export STUB_WARNED="$CASE_DIR/warned"
  export STUB_REMOVED_SAW="$CASE_DIR/removed-saw"
  export DOCKER_CONFIG="$CASE_DIR/docker"
  mkdir -p "$DOCKER_CONFIG"
  printf '{"auths":{"registry.kindgi.com":{}}}\n' >"$DOCKER_CONFIG/config.json"
  cp "$DOCKER_CONFIG/config.json" "$CASE_DIR/original-docker-config.json"
  # 0.4.0, the newest release the script knows and its module's: the default,
  # which a case of its own takes without --to.
  ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev" --to 0.4.0)
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
# module's outputs and variables, a plan with no state lock, and that plan read
# back. So nothing writes the state, and nothing else changes. (The real
# terraform console takes the state lock briefly; the stub doesn't model it.)
assert_reads_only() {
  local other
  other="$(grep -vE '^(gcloud (run services describe|artifacts docker images list|sql instances describe|sql ssl server-ca-certs list) |docker buildx imagetools inspect |terraform output -json$|terraform console( -var-file=[^ ]+)+$|terraform -chdir=[^ ]+ console( -var-file=[^ ]+)+$|terraform plan( -var-file=[^ ]+)+ -var server_image=[^ ]+ -lock=false -out=[^ ]+$|terraform show -json [^ ]+$)' "$STUB_CALLS_LOG")"
  if [[ -z $other ]]; then pass; else fail "made a call that isn't a read: $other"; fi
}

# 1. Happy path: 0.1.8 -> 0.4.0, own instance, no pack, confirm yes.
case_start "happy path"
reset_env; export STUB_TAGS="0.1.8"
run "yes"
assert_rc 0 "happy path exits 0"
assert_present "$STUB_MARKER_MIRROR" "mirror"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.1.8 -> 0.4.0 applied"
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"  # mirrored 0.1.8" "var-file pins the new image, comment kept"
assert_file_has "$STUB_PLAN_SAW" "$NEW_IMAGE" "the plan read the new image from the var-file"
if grep -q "plan got -var" "$STUB_PLAN_SAW"; then fail "plan was given -var"; else pass; fi
assert_file_has "$OUT" "plan check: it changes the image(s), and only what the releases crossed change." "the plan check's line"
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
reset_env; export STUB_TAGS="0.4.0"
run "yes"
assert_rc 1 "already at target"
assert_out "already on 0.4.0"
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
# From 0.4.0 to a server fix of it: the module stays the release's, so the
# go-back plans with it. (A run from before 0.4.0 has a go-back of its own.)
case_start "apply fails"
reset_env; export STUB_TAGS="0.4.0" STUB_APPLY_RC=1
run "yes" --to 0.4.0.1
assert_rc 1 "apply failure"
assert_out "To go back"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.4 memory erasures export --out=erasures-" "the export runs 0.4.0's CLI line"
assert_out "import sql"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.4 memory erasures replay erasures-" "the replay runs 0.4.0's CLI line"
if grep -q -e "@kindgi/sdk@" -e "pack-service-token" "$OUT"; then fail "a go-back with no switch names an older module or the pack token"; else pass; fi
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
# fix for 0.4.0 is on the 0.4 line.
case_start "go-back from a server fix"
reset_env; export STUB_SERVICE_JSON="$SERVICE_STUCK"
run "yes" --from 0.4.0.1 --to 0.4.0.2
assert_rc 1 "unhealthy start"
assert_out "did not become ready"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.4 memory erasures export --out=erasures-" "the export runs 0.4.0.1's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.4 memory erasures replay erasures-" "the replay runs 0.4.0.1's CLI line"
if grep -qF "@kindgi/cli@0.3" "$OUT"; then fail "the go-back from 0.4.0.1 names the 0.3 CLI"; else pass; fi
if grep -qF "pre-release" "$OUT"; then fail "a server fix's go-back has the pre-release note"; else pass; fi

# 7b. From an rc, the 0.4 line finds no CLI until 0.4.0 is out: a note right
# under the export says so.
case_start "go-back from an rc"
reset_env; export STUB_TAGS="0.4.0-rc.0" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.4 memory erasures export --out=erasures-" "the export runs the rc's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.4 memory erasures replay erasures-" "the replay runs the rc's CLI line"
note="$(grep -A4 -F "memory erasures export" "$OUT" | tail -n 4)"
if [[ $note == "    This deployment runs a pre-release, 0.4.0-rc.0. Until 0.4.0 is out,
    npx finds no @kindgi/cli@0.4: in this step and in step 7, name the
    CLI's own pre-release instead, as @kindgi/cli@0.4.0-rc.N
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

# 9. An rc goes to its final. From 0.4.0's rc the module has its packs
# already: no switch, and the orchestrator's Job takes the new image beside
# the server.
JOB_IMAGE="$(jq -cn --arg old "$RUNNING_IMAGE" --arg new "$NEW_IMAGE" '[{address: "google_cloud_run_v2_job.orchestrator[0]", mode: "managed",
  type: "google_cloud_run_v2_job", name: "orchestrator", index: 0,
  change: {actions: ["update"],
    before: {name: "kindgi-pack-orchestrator", template: [{template: [{containers: [{image: $old}]}]}]},
    after: {name: "kindgi-pack-orchestrator", template: [{template: [{containers: [{image: $new}]}]}]},
    after_unknown: {}}}]')"
case_start "rc to its final"
reset_env; export STUB_TAGS="0.4.0-rc.0" STUB_PLAN_CHANGES="$JOB_IMAGE"; V_OKV="1"
run "yes"
assert_rc 0 "rc -> final runs"
assert_out "From a 0.4.0 pre-release, the module has 0.4.0's packs already"
assert_out "plan check: it changes the image(s)"
if grep -q -e "Steps that finish the switch" -e "pack-route-missing" -e "pack_service_token" "$OUT"; then fail "a run from 0.4.0's rc made the switch"; else pass; fi
assert_out "0.4.0-rc.0 -> 0.4.0 applied"

# 10. To an rc: its release's steps are included.
case_start "0.1.8 to an rc"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.4.0-rc.0
assert_rc 0 "to an rc runs"
assert_out "crossing: 0.1.9 0.1.10 0.2.0 0.3.0 0.3.1 0.4.0$"
assert_out "STEPS-PENDING"
assert_out "autoCloseAfterInactiveSeconds"

# 11. An rc promoted to its final carries both tags: the final is the version.
case_start "rc and final tags on one digest"
reset_env; export STUB_TAGS="0.4.0-rc.0;0.4.0"
run "yes"
assert_rc 1 "final read from the two tags"
assert_out "already on 0.4.0,"

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

# 17. --pack-dir is refused before anything is read: from 0.4.0 the pack
# orchestrator makes each deployment's pack service, from its deploy's image.
case_start "--pack-dir is refused"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.8"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
run "yes" --pack-dir "$PACK_DIR"
assert_rc 1 "--pack-dir refused"
assert_out "--pack-dir: from 0.4.0 each deployment has a pack service of its own"
assert_out "Deploy each pack with kindgi deploy"
assert_absent "$STUB_CALLS_LOG" "a call"
assert_varfile_unchanged

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
# read, mirrored or backed up, though 0.1.9 to 0.4.0 lie on the way.
case_start "target past the newest known release"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.5.0
assert_rc 1 "a later target refused"
assert_out "knows the steps up to 0.4.0"
assert_out "as of the @kindgi/sdk@0.5.0 tag"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 25. An rc of a later release counts as that release.
case_start "rc of a later release"
reset_env; export STUB_TAGS="0.1.9"
run "yes" --to 0.5.0-rc.1
assert_rc 1 "a later rc refused"
assert_out "knows the steps up to 0.4.0"
assert_out "as of the @kindgi/sdk@0.5.0 tag or, before that release is out, its newest @kindgi/sdk@0.5.0-rc.N tag."
assert_absent "$STUB_MARKER_MIRROR" "mirror"

# 26. 0.1.10 -> 0.4.0: crosses 0.2.0 and on, copies 0.4.0 from
# registry.kindgi.com.
case_start "0.1.10 to 0.4.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes"
assert_rc 0 "0.1.10 -> 0.4.0 runs"
assert_out "crossing: 0.2.0 0.3.0 0.3.1 0.4.0$"
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
assert_out "it (below), so this plan doesn't change it."
assert_out "its next build takes what they say"
if grep -q "autoCloseAfterInactiveSeconds" "$OUT"; then fail "0.1.10's steps shown for 0.1.10 -> 0.4.0"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.4.0 " "the release tag is read on registry.kindgi.com"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.4.0@$NEW_DIGEST" "the mirror copies from registry.kindgi.com"
if grep -q "quay.io" "$STUB_DOCKER_LOG"; then fail "an image was read from quay.io"; else pass; fi
assert_file_has "$OUT" "This copies the runtime through this machine, down from registry.kindgi.com and up to Artifact Registry. It takes both platforms (linux/amd64 and linux/arm64), so your copy keeps the release digest." "what the copy is"
assert_file_has "$OUT" "On a slow uplink it can take most of an hour; it says when it's done." "how long the copy can take"
said="$(grep -o -F -e "Mirroring runtime 0.4.0 into" -e "This copies the runtime" -e "it says when it's done." -e "stub: imagetools create" -e "mirrored to $NEW_IMAGE" "$OUT" | tr '\n' '|')"
if [[ $said == "Mirroring runtime 0.4.0 into|This copies the runtime|it says when it's done.|stub: imagetools create|mirrored to $NEW_IMAGE|" ]]; then pass
else fail "the copy's time isn't said between the step line and the copy, in order: $said"; fi
assert_out "0.1.10 -> 0.4.0 applied"

# 27. 0.1.10 -> an rc of 0.4.0: its steps are included, and it gets to the mirror.
case_start "0.1.10 to 0.4.0-rc.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.4.0-rc.0
assert_rc 0 "0.1.10 -> 0.4.0-rc.0 runs"
assert_out "crossing: 0.2.0 0.3.0 0.3.1 0.4.0$"
assert_present "$STUB_MARKER_MIRROR" "mirror"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.4.0-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"

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

# 31. A deployment on a 0.1.11 rc upgrades to 0.4.0, crossing 0.2.0 and on.
case_start "0.1.11-rc.0 to 0.4.0"
reset_env; export STUB_TAGS="0.1.11-rc.0"
run "yes"
assert_rc 0 "0.1.11-rc.0 -> 0.4.0 runs"
assert_out "crossing: 0.2.0 0.3.0 0.3.1 0.4.0$"
assert_out "0.1.11-rc.0 -> 0.4.0 applied"

# 32. A dry run: the reads and the read-only checks, every change a real run
# would make with the names it would use, the steps to confirm by hand (the
# switch's after the apply too), and a read-only plan for the new image.
# Nothing is mirrored, granted, exported or applied, and no job is run; the
# var-file and docker's config are untouched; the plan takes no state lock and
# no state is written.
case_start "dry run"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
run "yes" --dry-run
assert_rc 0 "a dry run exits 0"
assert_out "DRY RUN. It reads only"
assert_file_has "$STUB_CALLS_LOG" "docker buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.4.0 " "the release digest is read"
assert_file_has "$OUT" "2. add gcloud as the credential helper for northamerica-northeast2-docker.pkg.dev in your docker config" "the docker config"
assert_file_has "$OUT" "add the image tag $REPO/runtime:0.4.0 to Artifact Registry" "the mirror"
assert_file_has "$OUT" "   (both platforms, through this machine; on a slow uplink it can take most of an hour)" "the mirror's time"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-pk  (check provider-keys)" "the provider-keys job"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-ss  (check secret-scopes)" "the secret-scopes job"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-mhc  (check mcp-header-credentials)" "the mcp-header-credentials job"
assert_file_has "$OUT" "grant serviceAccount:p-sql@demo-proj.iam.gserviceaccount.com roles/storage.objectAdmin on gs://backups " "the grant"
assert_file_has "$OUT" "export the \"kindgi\" database to gs://backups/dev/kindgi-kindgi-0.1.10-<YYYYMMDDTHHMMSSZ>.sql.gz" "the export"
assert_file_has "$OUT" "4. nothing to build: the apply deletes the one pack service, and the pack orchestrator makes each deployment's own" "the pack service's step"
assert_file_has "$OUT" "copy $VAR_FILE to $VAR_FILE.pre-upgrade-<YYYYMMDDTHHMMSSZ>" "the var-file copy"
assert_file_has "$OUT" "set server_image = \"$NEW_IMAGE\" in $VAR_FILE" "the new image"
if grep -q "pack_image is unchanged" "$OUT"; then fail "a dry run spoke of a pack rebuild"; else pass; fi
assert_file_has "$OUT" "wait for the new revision of kindgi-server" "the wait"
assert_file_has "$OUT" "   then print the steps that finish the switch to 0.4.0's packs (below)" "the switch's steps, in order"
assert_out "== Steps that finish the switch to 0.4.0's packs, by hand =="
assert_out "key as the password; this script copies it from there."
assert_out "dry run done. Nothing was changed"
if grep -q "Apply this plan" "$OUT"; then fail "a dry run asked for yes"; else pass; fi
assert_file_has "$STUB_CALLS_LOG" "terraform plan -var-file=$VAR_FILE -var server_image=$NEW_IMAGE -lock=false" "the plan is given the new image"
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
assert_out "4. nothing to build: the pack orchestrator makes each deployment's pack service"
assert_out "upgrade (dry run): terraform plan failed"
assert_reads_only
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 35. A dry run from 0.4.0's rc: the module has its packs already, so no
# switch, and a pack_image still in the var file is no pack service.
case_start "dry run from 0.4.0's rc"
reset_env "$OLD_PACK"; export STUB_TAGS="0.4.0-rc.0"; V_OKV="1"
run "yes" --dry-run
assert_rc 0 "a dry run exits 0"
assert_out "4. nothing to build: the pack orchestrator makes each deployment's pack service"
assert_out "From a 0.4.0 pre-release, the module has 0.4.0's packs already"
if grep -q -e "Steps that finish the switch" -e "pack-route-missing" "$OUT"; then fail "a dry run from 0.4.0's rc lists the switch"; else pass; fi
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
case_start "0.4.0 to a server-only release, 0.4.0.1"
reset_env; export STUB_TAGS="0.4.0"; V_OKV="1"
run "yes" --to 0.4.0.1
assert_rc 0 "0.4.0 -> 0.4.0.1 runs"
assert_out "upgrading 0.4.0 -> 0.4.0.1, a server fix for 0.4.0: no release crossed"
assert_out "none: 0.4.0.1 is a server fix for 0.4.0."
if grep -q -e "STEPS-PENDING" -e "Steps that finish the switch" "$OUT"; then fail "0.4.0's steps shown for 0.4.0 -> 0.4.0.1"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.4.0.1 " "the server fix's own tag is read"
assert_file_has "$STUB_DOCKER_LOG" "--tag $REPO/runtime:0.4.0.1 registry.kindgi.com/kindgi/runtime:0.4.0.1@$NEW_DIGEST" "the mirror tags it 0.4.0.1"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.4.0 -> 0.4.0.1 applied"

# 38. From before X.Y.Z, a server-only release crosses X.Y.Z: its steps print,
# and from 0.3.1 it makes the switch.
case_start "0.3.1 to 0.4.0.1"
reset_env; export STUB_TAGS="0.3.1"
run "yes" --to 0.4.0.1
assert_rc 0 "0.3.1 -> 0.4.0.1 runs"
assert_out "crossing: 0.4.0$"
assert_out "STEPS-PENDING"
if grep -q "none: " "$OUT"; then fail "a crossing upgrade said there are no steps"; else pass; fi
assert_out "Steps that finish the switch to 0.4.0's packs"
assert_out "0.3.1 -> 0.4.0.1 applied"

# 39. From an rc of X.Y.Z, too: the rc is below its final.
case_start "0.4.0-rc.0 to 0.4.0.1"
reset_env; export STUB_TAGS="0.4.0-rc.0"; V_OKV="1"
run "yes" --to 0.4.0.1
assert_rc 0 "0.4.0-rc.0 -> 0.4.0.1 runs"
assert_out "crossing: 0.4.0$"
assert_out "0.4.0-rc.0 -> 0.4.0.1 applied"

# 40. From one server fix to the next: the running X.Y.Z.N is read from its
# mirrored tag, and names the export.
case_start "0.4.0.1 to 0.4.0.2"
reset_env; export STUB_TAGS="0.4.0.1"; V_OKV="1"
run "yes" --to 0.4.0.2
assert_rc 0 "0.4.0.1 -> 0.4.0.2 runs"
assert_out "read 0.4.0.1 from the mirrored image's tag"
assert_out "a server fix for 0.4.0: no release crossed"
assert_out "backup complete: gs://backups/dev/kindgi-kindgi-0.4.0.1-"
assert_out "0.4.0.1 -> 0.4.0.2 applied"

# 41. A later server fix is past an earlier one, and past its release: going
# back down is refused before anything is read from the registry.
case_start "0.4.0.2 to 0.4.0.1 is refused"
reset_env; export STUB_TAGS="0.4.0.2"
run "yes" --to 0.4.0.1
assert_rc 1 "going down refused"
assert_out "already on 0.4.0.2, at or past the target 0.4.0.1\."
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_varfile_unchanged

case_start "0.4.0.1 to 0.4.0 is refused"
reset_env; export STUB_TAGS="0.4.0.1"
run "yes"
assert_rc 1 "a server fix to its release refused"
assert_out "already on 0.4.0.1, at or past the target 0.4.0\."
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_varfile_unchanged

# 42. A server fix of a release past the newest this script knows: the refusal
# names its release's SDK tag, since a server-only release has none.
case_start "server fix past the newest known release"
reset_env; export STUB_TAGS="0.4.0"
run "yes" --to 0.5.0.1
assert_rc 1 "a later server fix refused"
assert_out "knows the steps up to 0.4.0. 0.5.0.1 is a server fix for 0.5.0, which comes out after its final: use this script as of the @kindgi/sdk@0.5.0 tag."
if grep -q "@kindgi/sdk@0.5.0.1" "$OUT"; then fail "the refusal names an SDK tag a server-only release doesn't have"; else pass; fi
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
reset_env; V_OKV="1"
run "yes" --from 0.4.0.1 --to 0.4.0.2
assert_rc 0 "--from 0.4.0.1 runs"
assert_out "using --from 0.4.0.1"
assert_out "0.4.0.1 -> 0.4.0.2 applied"

case_start "--from an rc of a server fix isn't a version"
reset_env
run "yes" --from 0.2.0.1-rc.0 --to 0.4.0.2
assert_rc 1 "--from 0.2.0.1-rc.0 refused"
assert_out "--from \"0.2.0.1-rc.0\" isn't a version like 0.1.10 or 0.2.0.1"

case_start "no version tag, no --from"
reset_env
run "yes" --to 0.4.0.1
assert_rc 1 "no version refused"
assert_out "Re-run with --from <the version it runs, such as 0.1.10 or 0.2.0.1>"
assert_absent "$STUB_DOCKER_LOG" "a registry read"

# 45. A dry run lists a server-only release like any other target: its own
# tag read and mirrored, no steps by hand, and nothing changed.
case_start "dry run to a server-only release"
reset_env; export STUB_TAGS="0.4.0"; V_OKV="1"
run "yes" --to 0.4.0.1 --dry-run
assert_rc 0 "a dry run to 0.4.0.1 exits 0"
assert_file_has "$STUB_CALLS_LOG" "docker buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.4.0.1 " "the server fix's digest is read"
assert_file_has "$OUT" "2. add the image tag $REPO/runtime:0.4.0.1 to Artifact Registry" "the mirror"
assert_file_has "$OUT" "(a copy of registry.kindgi.com/kindgi/runtime:0.4.0.1@$NEW_DIGEST;" "the mirror's source"
assert_file_has "$OUT" "export the \"kindgi\" database to gs://backups/dev/kindgi-kindgi-0.4.0-<YYYYMMDDTHHMMSSZ>.sql.gz" "the export"
assert_out "none: 0.4.0.1 is a server fix for 0.4.0."
assert_out "dry run done. Nothing was changed"
assert_reads_only
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 46. The same script with releases it doesn't ship yet (0.4.1, and 0.6.0
# past a 0.5.0 it doesn't list), for what today's list can't reach: a server
# fix sorts below the next release's rc, and a server fix of a release the
# script doesn't list is refused.
GAP_SCRIPT="$TMP/upgrade-gap.sh"
sed 's/^readonly KNOWN_RELEASES=.*/readonly KNOWN_RELEASES=("0.1.9" "0.1.10" "0.2.0" "0.3.0" "0.3.1" "0.4.0" "0.4.1" "0.6.0")/' "$SCRIPT" >"$GAP_SCRIPT"
chmod +x "$GAP_SCRIPT"
if grep -qx 'readonly KNOWN_RELEASES=("0.1.9" "0.1.10" "0.2.0" "0.3.0" "0.3.1" "0.4.0" "0.4.1" "0.6.0")' "$GAP_SCRIPT"; then pass; else fail "the copy's KNOWN_RELEASES wasn't set"; fi
REAL_SCRIPT="$SCRIPT"; SCRIPT="$GAP_SCRIPT"

case_start "0.4.0.3 to the next release's rc"
reset_env; export STUB_TAGS="0.4.0.3"; V_OKV="1"
run "yes" --to 0.4.1-rc.0
assert_rc 0 "0.4.0.3 -> 0.4.1-rc.0 runs"
assert_out "crossing: 0.4.1$"
assert_out "0.4.0.3 -> 0.4.1-rc.0 applied"

case_start "the next release's rc to 0.4.0.3 is refused"
reset_env; export STUB_TAGS="0.4.1-rc.0"
run "yes" --to 0.4.0.3
assert_rc 1 "an rc to an earlier release's server fix refused"
assert_out "already on 0.4.1-rc.0, at or past the target 0.4.0.3\."

case_start "server fix of a release the script doesn't list"
reset_env; export STUB_TAGS="0.4.1"
run "yes" --to 0.5.0.1
assert_rc 1 "0.5.0.1 refused"
assert_out "--to 0.5.0.1: a server fix for 0.5.0, which isn't a release this script knows (0.1.9 0.1.10 0.2.0 0.3.0 0.3.1 0.4.0 0.4.1 0.6.0)."
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_varfile_unchanged

SCRIPT="$REAL_SCRIPT"

# 47. 0.3.1 -> 0.4.0 with the one pack service, its env in a file of its own:
# the switch to a pack service per deployment. The plan deletes the pack
# service, its token's secret and their grants, makes the orchestrator's
# things, renames the pack account and swaps the server's pack settings; the
# check allows each of those. The window is said before the question. After
# the apply come the steps that finish the switch: the key, the var file
# without the four variables 0.4.0 took out and with the readers of the
# pack's secrets, the pack's env by name (never a value), and a deploy of
# each pack.
SWITCH_PLAN="$(jq -cn '
  def rc($type; $name; $i; $a):
    {address: ($type + "." + $name + (if $i == null then "" elif ($i | type) == "string" then "[\($i | tojson)]" else "[\($i)]" end)),
     mode: "managed", type: $type, name: $name,
     change: {actions: $a, before: (if $a == ["create"] then null else {} end),
              after: (if $a == ["delete"] then null else {} end), after_unknown: {}}}
    + (if $i == null then {} else {index: $i} end);
  [rc("google_cloud_run_v2_service"; "pack"; 0; ["delete"]),
   rc("google_cloud_run_v2_service_iam_member"; "server_invokes_pack"; 0; ["delete"]),
   rc("google_secret_manager_secret"; "shared"; "pack_service_token"; ["delete"]),
   rc("google_secret_manager_secret_iam_member"; "pack_reads_token"; 0; ["delete"]),
   rc("google_secret_manager_secret_iam_member"; "pack_reads_its_secrets"; "SHOP_API_KEY"; ["delete"]),
   rc("google_secret_manager_secret_iam_member"; "server_reads"; "pack_service_token"; ["delete"]),
   rc("google_service_account"; "orchestrator"; null; ["create"]),
   rc("google_project_iam_member"; "orchestrator_runs_services"; null; ["create"]),
   rc("google_service_account_iam_member"; "orchestrator_acts_as_pack"; null; ["create"]),
   rc("google_artifact_registry_repository_iam_member"; "orchestrator_reads_images"; null; ["create"]),
   rc("google_project_iam_custom_role"; "pack_secrets"; null; ["create"]),
   rc("google_project_iam_member"; "orchestrator_pack_secrets"; null; ["create"]),
   rc("google_project_iam_custom_role"; "secret_create_list"; null; ["create"]),
   rc("google_project_iam_member"; "orchestrator_creates_lists_secrets"; null; ["create"]),
   rc("google_project_iam_member"; "pack_reads_pack_secrets"; null; ["create"]),
   rc("google_secret_manager_secret"; "orchestrator_key"; null; ["create"]),
   rc("google_secret_manager_secret_iam_member"; "orchestrator_reads_key"; null; ["create"]),
   rc("google_project_iam_member"; "server_invokes_packs"; null; ["create"]),
   rc("google_project_service"; "apis"; "cloudscheduler.googleapis.com"; ["create"]),
   rc("google_cloud_run_v2_service_iam_member"; "orchestrator_invokes_server"; 0; ["create"]),
   {address: "google_service_account.pack", previous_address: "google_service_account.pack[0]",
    mode: "managed", type: "google_service_account", name: "pack",
    change: {actions: ["update"], before: {account_id: "kindgi-pack", display_name: "Kindgi pack service"},
             after: {account_id: "kindgi-pack", display_name: "Kindgi pack services"}, after_unknown: {}}}]')"
SWITCH_SERVER_ENV="$(jq -cn '{
  before: [{name: "KINDGI_PACK_SERVICE_URL", value: "https://kindgi-pack-xxx.a.run.app", value_source: []},
           {name: "KINDGI_PACK_SERVICE_TOKEN", value: "", value_source: [{secret_key_ref: [{secret: "kindgi-pack-service-token", version: "latest"}]}]},
           {name: "KINDGI_PACK_SERVICE_AUTH", value: "id-token", value_source: []}],
  after: [{name: "KINDGI_PACK_ROUTING", value: "per-deployment", value_source: []},
          {name: "KINDGI_PACK_ENDPOINT_HOSTS", value: "*-123456789012.northamerica-northeast2.run.app", value_source: []},
          {name: "KINDGI_PACK_ENDPOINT_KMS_KEY", value: "projects/demo-proj/locations/northamerica-northeast2/keyRings/kindgi/cryptoKeys/secrets", value_source: []},
          {name: "KINDGI_ENV_CLOUD_SECRETS", value: "on", value_source: []}]}')"
case_start "0.3.1 -> 0.4.0: the switch to a pack service per deployment"
reset_env "$OLD_PACK"; unset STUB_PACK_BEFORE
export STUB_TAGS="0.3.1" STUB_PLAN_CHANGES="$SWITCH_PLAN" STUB_SERVER_ENV="$SWITCH_SERVER_ENV"
PACK_ENV_FILE="$CASE_DIR/dev.pack-env.tfvars.json"
jq -n '{pack_min_instances: 2,
  pack_env: {SHOP_URL: "https://shop.acme.example", SHOP_REGION: "acme-north-7"},
  pack_secret_env: {SHOP_API_KEY: {secret: "acme-shop-key", version: "2"},
                    SHOP_HOOK_KEY: {secret: "acme-hook-key", version: "5", project: "acme-shared"}}}' >"$PACK_ENV_FILE"
run "yes" --var-file "$PACK_ENV_FILE"
assert_rc 0 "0.3.1 -> 0.4.0 runs"
assert_out "crossing: 0.4.0$"
assert_out "STEPS-PENDING: this copy doesn't have 0.4.0's runtime steps yet"
assert_out "The plan moves the deployment from the one pack service to a pack service"
if grep -qxF "console -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE" "$STUB_REMOVED_SAW"; then pass
else fail "the variables 0.4.0 took out weren't read from both files: $(cat "$STUB_REMOVED_SAW")"; fi
assert_out "nothing to build: the apply deletes the one pack service, and the pack orchestrator makes each deployment's own"
assert_out "plan check: it changes the image(s), and only what the releases crossed change."
w="$(grep -n "This plan moves the deployment to a pack service for each deployment" "$OUT" | head -1 | cut -d: -f1)"
y="$(grep -n "Apply this plan" "$OUT" | head -1 | cut -d: -f1)"
if [[ -n $w && -n $y && $w -lt $y ]]; then pass; else fail "the window isn't said before the question (at ${w:-none}, question at ${y:-none})"; fi
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.3.1 -> 0.4.0 applied"
assert_out "Steps that finish the switch to 0.4.0's packs, by hand"
assert_file_has "$OUT" "      terraform output -raw orchestrator_key_steps" "the key's steps"
assert_file_has "$OUT" "    kindgi-orchestrator-key, as step 1 of this says" "the key's secret"
assert_file_has "$OUT" "      pack_secret_readers = [" "the readers"
assert_file_has "$OUT" '        { secret = "acme-shop-key" },' "a reader in the project"
assert_file_has "$OUT" '        { secret = "acme-hook-key", project = "acme-shared" },' "a reader in another project"
assert_out "pack_min_instances was 2."
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE -out=switch.tfplan)" "$OUT"; then pass
else fail "the second apply doesn't plan with both var files: $(grep -F "switch.tfplan" "$OUT")"; fi
assert_file_has "$OUT" " 3. Set the pack's env in Kindgi" "the env step"
for n in SHOP_REGION SHOP_URL; do
  assert_file_has "$OUT" "      KINDGI_API_TOKEN=<api token> kindgi env set $n <its value> --url $SERVER_URL --scope=tenant --env=<env>" "$n set by name"
done
assert_file_has "$OUT" "      KINDGI_API_TOKEN=<that key> kindgi env set SHOP_API_KEY --cloud-secret projects/demo-proj/secrets/acme-shop-key/versions/2 --tenant=$SEED_TENANT --url $SERVER_URL --scope=tenant --env=<env>" "a cloud secret in the project"
assert_file_has "$OUT" "      KINDGI_API_TOKEN=<that key> kindgi env set SHOP_HOOK_KEY --cloud-secret projects/acme-shared/secrets/acme-hook-key/versions/5 --tenant=$SEED_TENANT --url $SERVER_URL --scope=tenant --env=<env>" "a cloud secret in another project"
assert_file_has "$OUT" " 4. Deploy each pack again" "the deploy step"
assert_file_has "$OUT" "      kindgi deploy --env <env> --endpoint $SERVER_URL --token <api token> --idempotency-key <new value>" "the deploy"
if grep -q -e "shop.acme.example" -e "acme-north-7" "$OUT"; then fail "a pack env value was printed"; else pass; fi
if grep -q "tenancy = \"multi\"" "$OUT"; then fail "a single-tenant run printed the multi steps"; else pass; fi

# 48. With no --to, the target is the newest release the script knows, 0.4.0.
# From 0.2.0 it crosses 0.3.0, 0.3.1 and 0.4.0: their steps print, 0.4.0's
# marker among them, and the plan may turn on the instance's deletion
# protection, in place, as 0.3.0's say. With no pack service, the steps after
# the apply have no pack env to set.
INSTANCE_PROTECTED="$(jq -cn '[{address: "google_sql_database_instance.kindgi[0]", mode: "managed",
  type: "google_sql_database_instance", name: "kindgi", index: 0,
  change: {actions: ["update"],
    before: {name: "kindgi", settings: [{tier: "db-custom-1-3840", deletion_protection_enabled: false}]},
    after: {name: "kindgi", settings: [{tier: "db-custom-1-3840", deletion_protection_enabled: true}]},
    after_unknown: {}}}]')"
case_start "the default target, 0.4.0"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED"
ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev")
run "yes"
assert_rc 0 "0.2.0 -> 0.4.0 runs"
assert_out "crossing: 0.3.0 0.3.1 0.4.0$"
assert_out "turns on Google's deletion protection (deletion_protection_enabled)"
assert_out "If a plan says the instance must be replaced, answer no: a"
assert_out "First start runs six additive migrations"
assert_out "If seed_user_id has an upper-case letter, 0.3.0 and later read it in"
assert_out "kindgi-runtime tenants repair --tenant <id in lower case>"
assert_out "keeps kernel_runs, kernel_triggers and kernel_trigger_fires locked while"
assert_out "upgrade at a quiet time"
assert_out "gcloud storage rm --recursive --all-versions"
assert_out "With openfga_api_url set, once the new runtime serves all the traffic,"
assert_out "run this once, with the new runtime's kindgi-runtime:"
if grep -q "0.3.0's kindgi-runtime" "$OUT"; then fail "a run to 0.4.0 named 0.3.0's runtime"; else pass; fi
assert_out "First start runs no migrations. The steps are the packs'"
assert_out "kindgi guardrails unregister <id>"
assert_out "0.3.1 doesn't change the module."
assert_out "STEPS-PENDING: this copy doesn't have 0.4.0's runtime steps yet"
assert_out "The plan moves the deployment from the one pack service to a pack service"
if grep -q "the module here is this copy's" "$OUT"; then fail "the newest release warned of a module past it"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.4.0 " "0.4.0's tag is read"
assert_out "nothing to build: the pack orchestrator makes each deployment's pack service, from the image its deploy names"
assert_out "plan check: it changes the image(s)"
assert_out "0.2.0 -> 0.4.0 applied"
assert_file_has "$OUT" " 3. Deploy each pack again" "the deploy, third"
if grep -q -e "Set the pack's env in Kindgi" -e "pack_secret_readers = " -e "pack_min_instances was" "$OUT"; then fail "steps for a pack env that isn't there"; else pass; fi

# 48b. 0.3.1 -> 0.4.0's candidate, as most deployments go: it crosses 0.4.0
# alone, an rc counting as its release, and makes the switch.
case_start "0.3.1 to 0.4.0-rc.0"
reset_env; export STUB_TAGS="0.3.1"
run "yes" --to 0.4.0-rc.0
assert_rc 0 "0.3.1 -> 0.4.0-rc.0 runs"
assert_out "crossing: 0.4.0$"
assert_out "STEPS-PENDING: this copy doesn't have 0.4.0's runtime steps yet"
if grep -q "kindgi guardrails unregister <id>" "$OUT"; then fail "0.3.1's steps printed for a run from 0.3.1"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.4.0-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"
assert_out "plan check: it changes the image(s)"
assert_out "0.3.1 -> 0.4.0-rc.0 applied"
assert_out "Steps that finish the switch to 0.4.0's packs, by hand"

# 49. The module here is 0.4.0's, whose plan needs the 0.4.0 runtime: a --to
# below 0.4.0, a release or a server fix, is refused before anything is
# called, naming the tag whose script keeps the module at that release.
for pair in "0.3.1 0.3.1" "0.2.0.1 0.2.0"; do
  read -r to tag <<<"$pair"
  case_start "--to $to, below the module's runtime"
  reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED"
  run "yes" --to "$to"
  assert_rc 1 "--to $to refused"
  assert_file_has "$OUT" "--to $to: the module here is 0.4.0's, which needs the 0.4.0 runtime or later. Use this script as of the @kindgi/sdk@$tag tag or, before that release is out, its newest @kindgi/sdk@$tag-rc.N tag." "the refusal and its tag"
  assert_absent "$STUB_CALLS_LOG" "a call"
  assert_varfile_unchanged
done

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
run "yes"
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

# 49c. A private-IP database: with the instance changing, the module reads its
# CAs during the apply, so the plan has the server's KINDGI_DATABASE_SERVER_CA
# known only after it. 0.3.0's change allows that beside the instance's, and
# the run goes ahead.
SERVER_CA_AFTER_APPLY="$(jq -cn '{
  before: [{name: "KINDGI_DATABASE_SERVER_CA", value: "CA-ONE\nCA-TWO", value_source: []}],
  after: [{name: "KINDGI_DATABASE_SERVER_CA", value_source: []}],
  after_unknown: [{value: true}]}')"
private_ip() {
  V_NET="connector"; V_CONNECTOR="projects/demo-proj/locations/northamerica-northeast2/connectors/acme"
  V_DB_PRIVATE="projects/demo-proj/global/networks/acme"; export STUB_DB_PUBLIC=false
}
case_start "0.2.0 -> 0.4.0, a private-IP database: the server's CA known after the apply"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED" STUB_SERVER_ENV="$SERVER_CA_AFTER_APPLY"; private_ip
run "yes"
assert_rc 0 "the CA known after the apply passes"
assert_out "crossing: 0.3.0 0.3.1 0.4.0$"
assert_out "on instance kindgi (private IP)"
assert_out "the plan shows the server's KINDGI_DATABASE_SERVER_CA as known after"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

# 49d. The same plan with one more server env change, a name that starts with
# the CA's: the check names it and stops, and doesn't name the CA.
SERVER_CA_AND_PATH="$(jq -cn --argjson ca "$SERVER_CA_AFTER_APPLY" '{
  before: $ca.before,
  after: ($ca.after + [{name: "KINDGI_DATABASE_SERVER_CA_PATH", value_source: []}]),
  after_unknown: ($ca.after_unknown + [{value: true}])}')"
case_start "the same plan with another server env change"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED" STUB_SERVER_ENV="$SERVER_CA_AND_PATH"; private_ip
run "yes"
assert_rc 1 "another env change stops it"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.KINDGI_DATABASE_SERVER_CA_PATH" "the other env var named"
if grep -qx "    google_cloud_run_v2_service.server: changes template.containers.env.KINDGI_DATABASE_SERVER_CA" "$OUT"; then fail "the CA was named"; else pass; fi
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 49e. The CA known after the apply in a plan that doesn't change the
# instance (database_deletion_protection = false, say): nothing explains it,
# so the check names it and stops.
case_start "the server's CA known after the apply, the instance unchanged"
reset_env; export STUB_TAGS="0.2.0" STUB_SERVER_ENV="$SERVER_CA_AFTER_APPLY"; private_ip
run "yes"
assert_rc 1 "the CA on its own stops it"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.KINDGI_DATABASE_SERVER_CA" "the CA named"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 49f. Without a private IP, the module doesn't set the CA, and a plan that
# changes it stops.
case_start "the server's CA known after the apply, no private IP"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED" STUB_SERVER_ENV="$SERVER_CA_AFTER_APPLY"
run "yes"
assert_rc 1 "it stops"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.KINDGI_DATABASE_SERVER_CA" "the CA named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 49g. 0.4.0's candidate goes the same way from 0.2.0, in one run: the plan
# makes 0.3.0's change on the way, and the CA comes with it.
case_start "0.2.0 -> 0.4.0-rc.0, a private-IP database: the server's CA known after the apply"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$INSTANCE_PROTECTED" STUB_SERVER_ENV="$SERVER_CA_AFTER_APPLY"; private_ip
run "yes" --to 0.4.0-rc.0
assert_rc 0 "0.2.0 -> 0.4.0-rc.0 passes"
assert_out "crossing: 0.3.0 0.3.1 0.4.0$"
assert_out "the plan shows the server's KINDGI_DATABASE_SERVER_CA as known after"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

# 50. A var file left off the command: the plan drops the server's own env
# (server_env, server_secret_env), and the check names each one it drops,
# never a value. A var it keeps, moved in the list, isn't named. (The pack's
# env of the releases before 0.4.0, below, is the scrubbed fixtures' plan.)
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
SERVER_ENV_DROPPED="$(jq -cn '
  {name: "ACME_REGION", value: "acme-north-7", value_source: []} as $kept
  | {before: [{name: "ACME_URL", value: "https://shop.acme.example", value_source: []}, $kept,
              {name: "ACME_KEY", value: "", value_source: [{secret_key_ref: [{secret: "acme-shop-key", version: "2"}]}]}],
     after: [$kept]}')"
case_start "the plan drops the server's env"
reset_env; export STUB_TAGS="0.3.1" STUB_SERVER_ENV="$SERVER_ENV_DROPPED"
run "yes"
assert_rc 1 "a plan that drops the server's env stops"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.ACME_URL" "ACME_URL named"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.ACME_KEY" "ACME_KEY named"
if [[ "$(grep -c "env.ACME_URL" "$OUT")" == 1 ]]; then pass; else fail "ACME_URL should be named once"; fi
if grep -q "ACME_REGION" "$OUT"; then fail "a var the plan keeps was named"; else pass; fi
if grep -q -e "shop.acme.example" -e "acme-shop-key" -e "acme-north-7" "$OUT"; then fail "a value was printed"; else pass; fi
assert_out "give each file the deployment uses its own --var-file"
assert_present "$STUB_MARKER_EXPORT" "backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 51. The same in a dry run: it says a real run would stop there.
case_start "dry run, the plan drops the server's env"
reset_env; export STUB_TAGS="0.3.1" STUB_SERVER_ENV="$SERVER_ENV_DROPPED"
run "yes" --dry-run
assert_rc 1 "a dry run whose plan drops the server's env fails"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.ACME_URL" "ACME_URL named"
assert_out "upgrade (dry run): a real run would stop at this plan (above). Nothing was changed."
assert_reads_only
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_varfile_unchanged

# 52. The pack's env in a file of its own, given with a second --var-file:
# terraform reads both, in order (the variables 0.4.0 took out too, by
# absolute path), the run lists both and says which one the image goes in,
# only that one changes, and the go-back plans with both. From 0.1.10 it's a
# switch with the one pack service: the go-back's steps a to d.
case_start "two var files"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1
PACK_ENV_FILE="$CASE_DIR/dev.pack-env.tfvars.json"
jq -n '{pack_env: {SHOP_URL: "https://shop.acme.example"}, pack_secret_env: {}}' >"$PACK_ENV_FILE"
cp "$PACK_ENV_FILE" "$CASE_DIR/original-pack-env.json"
run "yes" --var-file "$PACK_ENV_FILE"
assert_rc 1 "the apply fails, after both files were read"
assert_file_has "$STUB_CALLS_LOG" "terraform console -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE" "console reads both"
assert_file_has "$STUB_CALLS_LOG" "terraform plan -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE -out=" "the plan reads both"
assert_file_has "$OUT" "var file        $VAR_FILE (the new image goes in here)" "the image's file listed"
assert_file_has "$OUT" "var file        $PACK_ENV_FILE" "the pack env's file listed"
if grep -qxF "console -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE" "$STUB_REMOVED_SAW"; then pass
else fail "the variables 0.4.0 took out weren't read from both files: $(cat "$STUB_REMOVED_SAW")"; fi
if grep -qxF "         (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the go-back doesn't plan with both var files"; fi
assert_file_has "$OUT" "    c. If terraform state list lists no google_secret_manager_secret.shared," "the pack token's step, third"
assert_file_has "$OUT" "    d. Plan:" "the plan, fourth"
if grep -q "Take the KMS key" "$OUT"; then fail "a postgres go-back takes the KMS key out"; else pass; fi
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

# 54. pack_image in a second var file: the variables 0.4.0 took out are read
# from it too, so the run knows the one pack service is there.
case_start "a second var file sets pack_image"
reset_env; export STUB_TAGS="0.3.1"
OTHER="$CASE_DIR/pack.tfvars"; printf 'pack_image = "%s"\n' "$OLD_PACK" >"$OTHER"
run "yes" --var-file "$OTHER" --dry-run
assert_rc 0 "a dry run exits 0"
assert_out "4. nothing to build: the apply deletes the one pack service"
if grep -qxF "console -var-file=$VAR_FILE -var-file=$OTHER" "$STUB_REMOVED_SAW"; then pass
else fail "the variables 0.4.0 took out weren't read from both files: $(cat "$STUB_REMOVED_SAW")"; fi
assert_reads_only
assert_varfile_unchanged

# 55. What Terraform loads on its own is listed: terraform.tfvars, an
# .auto.tfvars.json beside it, and TF_VAR_ names, never their values. The
# variables 0.4.0 took out are read from those files in Terraform's order,
# before the --var-file.
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
if grep -qxF "console -var-file=$CASE_DIR/terraform.tfvars -var-file=$CASE_DIR/dev.pack-env.auto.tfvars.json -var-file=$VAR_FILE" "$STUB_REMOVED_SAW"; then pass
else fail "the variables 0.4.0 took out weren't read in Terraform's order: $(cat "$STUB_REMOVED_SAW")"; fi
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
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_020"
run "yes"
assert_rc 0 "0.2.0's pack changes pass"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

case_start "0.2.0's in-place changes to the pack, on a server fix"
reset_env; export STUB_TAGS="0.4.0" STUB_PLAN_CHANGES="$PACK_020"
run "yes" --to 0.4.0.1
assert_rc 1 "the same changes stop a server fix"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.resources.cpu_idle" "cpu_idle named"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: changes template.containers.startup_probe.period_seconds" "the probe named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 60. A replace stops it, whatever the releases crossed.
case_start "the plan replaces the instance"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES='[{"address":"google_sql_database_instance.kindgi[0]","mode":"managed","type":"google_sql_database_instance","name":"kindgi","index":0,"change":{"actions":["delete","create"],"before":{"name":"kindgi"},"after":{"name":"kindgi"},"after_unknown":{}}}]'
run "yes"
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

# 64. pack_image in a file Terraform loads on its own is fine: from 0.4.0 the
# run writes no pack image, and the file is read for the variables 0.4.0
# took out.
case_start "an auto-loaded file sets pack_image"
reset_env; export STUB_TAGS="0.3.1"
printf '{"pack_image": "%s"}\n' "$OLD_PACK" >"$CASE_DIR/dev.pack.auto.tfvars.json"
run "yes"
assert_rc 0 "it runs"
assert_out "also loaded    dev.pack.auto.tfvars.json"
assert_out "nothing to build: the apply deletes the one pack service"

# 65. An env var known only after the apply is named by its name, as a
# changed one is, never by the attribute that's unknown.
SERVER_ENV_UNKNOWN="$(jq -cn '{before: [{name: "ACME_URL", value: null}], after: [{name: "ACME_URL", value: null}], after_unknown: [{value: true}]}')"
case_start "an env var known only after the apply"
reset_env; export STUB_TAGS="0.3.1" STUB_SERVER_ENV="$SERVER_ENV_UNKNOWN"
run "yes"
assert_rc 1 "an unknown env value stops it"
assert_file_has "$OUT" "    google_cloud_run_v2_service.server: changes template.containers.env.ACME_URL" "the env var named"
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
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.9" STUB_PLAN_CHANGES="$PACK_VPC"
run "yes"
assert_rc 0 "it passes in none mode"
assert_out "plan check: it changes the image(s)"

case_start "0.1.10's pack VPC access change, in direct mode"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.9" STUB_PLAN_CHANGES="$PACK_VPC"; V_NET="direct"
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
if grep -qxF "         (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$CASE_DIR/pack\\ env.tfvars.json -out=back.tfplan)" "$OUT"; then pass
else fail "the go-back doesn't quote the path: $(grep -F "terraform plan -var-file" "$OUT")"; fi

# 68. tests/scrub_plan.sh: the fixture it makes from a saved plan holds no
# values and is private, the plan check reads it as it reads the plan, and it
# won't write over a file.
case_start "a plan scrubbed into a fixture"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
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
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
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
# On a server fix for 0.4.0, which deletes none of the one pack service's
# grants (a switch does).
export STUB_TAGS="0.4.0" STUB_PLAN_CHANGES; STUB_PLAN_CHANGES="$(jq -c .resource_changes "$FIXTURE")"
run "yes" --to 0.4.0.1
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
# it stops before anything is mirrored, as for an auto-loaded file.
# TF_VAR_pack_image is read for the variables 0.4.0 took out, as a file's is.
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

case_start "TF_VAR_pack_image set"
reset_env; export STUB_TAGS="0.3.1"
export TF_VAR_pack_image="$OLD_PACK"
run "yes"
unset TF_VAR_pack_image
assert_rc 0 "it runs"
assert_out "also set       TF_VAR_pack_image (in the environment)"
assert_out "nothing to build: the apply deletes the one pack service"

# 71. Each variable the script reads with terraform console is one the module
# declares: the real console refuses an undeclared one, and the stub doesn't.
# The four 0.4.0 took out are declared nowhere in the module, so the script
# reads them in a config of their own.
case_start "VARS_EXPR reads only variables the module declares"
expr="$(sed -n "s/^VARS_EXPR='\(.*\)'\$/\1/p" "$HERE/../upgrade.sh")"
names="$(grep -oE 'var\.[a-z_][a-z0-9_]*' <<<"$expr" | sed 's/^var\.//' | sort -u)"
if grep -qx "project_id" <<<"$names" && grep -qx "orchestrator_key_version" <<<"$names"; then pass; else fail "VARS_EXPR wasn't read: $expr"; fi
for n in $names; do
  if grep -qE "^variable \"$n\" " "$HERE"/../*.tf; then pass; else fail "VARS_EXPR reads var.$n, which the module doesn't declare"; fi
done
for n in pack_image pack_min_instances pack_env pack_secret_env; do
  if grep -qE "^variable \"$n\" " "$HERE"/../*.tf; then fail "the module declares $n, which 0.4.0 took out"; else pass; fi
done

# 72. A switch's plan that creates or deletes anything else stops it: a
# resource no release names, and another of the server's secret grants.
SWITCH_PLAN_MORE="$(jq -cn --argjson p "$SWITCH_PLAN" '$p + [
  {address: "google_compute_network.acme", mode: "managed", type: "google_compute_network", name: "acme",
   change: {actions: ["create"], before: null, after: {}, after_unknown: {}}},
  {address: "google_secret_manager_secret_iam_member.server_reads[\"database_url\"]", mode: "managed",
   type: "google_secret_manager_secret_iam_member", name: "server_reads", index: "database_url",
   change: {actions: ["delete"], before: {}, after: null, after_unknown: {}}}]')"
case_start "a switch's plan that creates or deletes more"
reset_env "$OLD_PACK"; unset STUB_PACK_BEFORE; export STUB_TAGS="0.3.1" STUB_PLAN_CHANGES="$SWITCH_PLAN_MORE"
run "yes"
assert_rc 1 "more than the switch stops it"
assert_file_has "$OUT" "    google_compute_network.acme: created" "the unnamed create"
assert_file_has "$OUT" "    google_secret_manager_secret_iam_member.server_reads[\"database_url\"]: deleted" "the other grant's delete"
if grep -qF 'server_reads["pack_service_token"]' "$OUT"; then fail "the switch's own delete was named"; else pass; fi
if grep -q "google_service_account.orchestrator" "$OUT"; then fail "the switch's own create was named"; else pass; fi
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 73. From 0.4.0's rc there's no switch: the same plan stops it, and no steps
# for a switch print.
case_start "the switch's changes from 0.4.0's rc"
reset_env; export STUB_TAGS="0.4.0-rc.0" STUB_PLAN_CHANGES="$SWITCH_PLAN"
run "yes"
assert_rc 1 "the switch's changes stop a run from 0.4.0's rc"
assert_out "From a 0.4.0 pre-release, the module has 0.4.0's packs already"
assert_file_has "$OUT" "    google_cloud_run_v2_service.pack[0]: deleted" "the pack's delete"
assert_file_has "$OUT" "    google_service_account.orchestrator: created" "the orchestrator's create"
assert_file_has "$OUT" "    google_service_account.pack: changes display_name" "the rename"
if grep -q -e "Steps that finish the switch" -e "This plan moves the deployment" "$OUT"; then fail "a run from the rc spoke of a switch"; else pass; fi
assert_absent "$STUB_MARKER_APPLY" "apply"

# 74. With secrets_backend "none", the switch makes the KMS key the pack
# services' tokens are sealed under, and the API it needs; with "postgres",
# which has the key already, the same creates stop it.
KMS_CREATED="$(jq -cn '[
  {t: "google_project_service", n: "apis", i: "cloudkms.googleapis.com"},
  {t: "google_kms_key_ring", n: "kindgi"}, {t: "google_kms_crypto_key", n: "secrets"},
  {t: "google_kms_crypto_key_iam_member", n: "server_wraps"}, {t: "google_kms_crypto_key_iam_member", n: "server_reads_key"}]
  | map({address: (.t + "." + .n + (if .i then "[\(.i | tojson)]" else "" end)), mode: "managed", type: .t, name: .n}
        + (if .i then {index: .i} else {} end)
        + {change: {actions: ["create"], before: null, after: {}, after_unknown: {}}})')"
case_start "secrets_backend none: the switch makes the KMS key"
reset_env; export STUB_TAGS="0.3.1" STUB_PLAN_CHANGES="$KMS_CREATED"; V_SECRETS="none"; V_AAD=""
run "yes"
assert_rc 0 "the KMS key's creates pass"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

case_start "secrets_backend postgres: the KMS key's creates stop it"
reset_env; export STUB_TAGS="0.3.1" STUB_PLAN_CHANGES="$KMS_CREATED"
run "yes"
assert_rc 1 "a postgres plan that makes the KMS key stops"
assert_file_has "$OUT" "    google_kms_key_ring.kindgi: created" "the key ring named"
assert_file_has "$OUT" "    google_project_service.apis[\"cloudkms.googleapis.com\"]: created" "the API named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 75. tenancy = "multi": the user's own orchestrator stops before the apply,
# said in the module's changes and before the question; there's no one pack
# service, a cloud secret goes to each tenant by its id, and each tenant
# deploys again, then deletes its old services.
case_start "multi: the switch"
reset_env; export STUB_TAGS="0.3.1"; V_TENANCY="multi"
PACK_ENV_FILE="$CASE_DIR/dev.pack-env.tfvars.json"
jq -n '{pack_secret_env: {SHOP_API_KEY: {secret: "acme-shop-key", version: "2"}}}' >"$PACK_ENV_FILE"
run "yes" --var-file "$PACK_ENV_FILE"
assert_rc 0 "multi runs"
assert_file_has "$OUT" "   - With tenancy = \"multi\", stop your own orchestrator before the apply" "the module's change says so"
w="$(grep -n "stop your own orchestrator before you answer yes" "$OUT" | head -1 | cut -d: -f1)"
y="$(grep -n "Apply this plan" "$OUT" | head -1 | cut -d: -f1)"
if [[ -n $w && -n $y && $w -lt $y ]]; then pass; else fail "the orchestrator's stop isn't said before the question (at ${w:-none}, question at ${y:-none})"; fi
assert_out "nothing to build: the pack orchestrator makes each deployment's pack service"
assert_file_has "$OUT" "kindgi env set SHOP_API_KEY --cloud-secret projects/demo-proj/secrets/acme-shop-key/versions/2 --tenant=<tenant id> " "the tenant by its id"
assert_file_has "$OUT" " 4. Deploy each pack again" "the deploy, fourth"
assert_file_has "$OUT" " 5. With tenancy = \"multi\", each tenant deploys its packs again" "each tenant's step, fifth"
if grep -qF "$SEED_TENANT" "$OUT"; then fail "a multi run named the seed tenant"; else pass; fi

# 76. What 0.4.0's module refuses is refused before anything is read, backed
# up or changed: a name_prefix of kp or kp-..., the server env it sets
# itself, and an orchestrator_key_version before its secret exists. A prefix
# that only starts with kp passes.
for prefix in kp kp-acme; do
  case_start "name_prefix $prefix refused"
  reset_env; export STUB_TAGS="0.3.1"; V_PREFIX="$prefix"
  run "yes"
  assert_rc 1 "$prefix refused"
  assert_file_has "$OUT" "name_prefix is \"$prefix\": from 0.4.0 the pack orchestrator owns the services and secrets named kp-..." "the prefix named"
  assert_out "Serving from a restored instance"
  assert_absent "$STUB_MARKER_MIRROR" "mirror"
  assert_absent "$STUB_MARKER_EXPORT" "backup"
done
case_start "name_prefix kpacme passes"
reset_env; export STUB_TAGS="0.3.1"; V_PREFIX="kpacme"
run "yes" --dry-run
assert_rc 0 "kpacme passes"

for name in KINDGI_PACK_ROUTING KINDGI_PACK_ENDPOINT_KMS_KEY KINDGI_ENV_CLOUD_SECRETS; do
  case_start "server_env sets $name"
  reset_env; export STUB_TAGS="0.3.1"; V_SENV="[\"$name\"]"
  run "yes"
  assert_rc 1 "$name refused"
  assert_file_has "$OUT" "server_env or server_secret_env sets $name, which 0.4.0's module sets itself, and its plan refuses it there." "$name named"
  assert_absent "$STUB_MARKER_MIRROR" "mirror"
  assert_absent "$STUB_MARKER_EXPORT" "backup"
done
case_start "server_secret_env sets KINDGI_PACK_ROUTING"
reset_env; export STUB_TAGS="0.3.1"; V_SSENV='["KINDGI_PACK_ROUTING"]'
run "yes"
assert_rc 1 "a secret one refused too"
assert_file_has "$OUT" "server_env or server_secret_env sets KINDGI_PACK_ROUTING, which 0.4.0's module sets itself" "named"
assert_absent "$STUB_MARKER_EXPORT" "backup"

case_start "server_env sets KINDGI_PACK_ENDPOINT_HOSTS"
reset_env; export STUB_TAGS="0.3.1"; V_SENV='["ACME_URL", "KINDGI_PACK_ENDPOINT_HOSTS"]'; V_HOSTS="*.run.app"
run "yes"
assert_rc 1 "the hosts refused"
assert_file_has "$OUT" "server_env or server_secret_env sets KINDGI_PACK_ENDPOINT_HOSTS (*.run.app), which 0.4.0's module sets itself, to *-<project number>.northamerica-northeast2.run.app: this project's services in northamerica-northeast2." "its value and the module's"
assert_absent "$STUB_MARKER_EXPORT" "backup"

case_start "orchestrator_key_version set on a switch"
reset_env; export STUB_TAGS="0.3.1"; V_OKV="1"
run "yes"
assert_rc 1 "the key's version refused"
assert_file_has "$OUT" "orchestrator_key_version is set (\"1\"), but kindgi-orchestrator-key, the secret it names a version of, is made by this run's apply" "the key's secret named"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 77. Each pack_secret_env entry becomes a cloud secret of the pack's env, so
# one that can't be is named, with why, before anything is changed: a name,
# a secret path or a kp- secret, a project, "latest", a version that isn't a
# number. A right one isn't named.
case_start "pack_secret_env entries that can't be cloud secrets"
reset_env; export STUB_TAGS="0.3.1"
PACK_ENV_FILE="$CASE_DIR/dev.pack-env.tfvars.json"
jq -n '{pack_secret_env: {
  shop_key: {secret: "acme-a", version: "1"},
  KINDGI_SHOP_KEY: {secret: "acme-b", version: "1"},
  SHOP_PATH: {secret: "projects/acme-shared/secrets/acme-c", version: "1"},
  SHOP_KP: {secret: "kp-acme-d", version: "1"},
  SHOP_PROJECT: {secret: "acme-e", version: "1", project: "Acme_Shared"},
  SHOP_LATEST: {secret: "acme-f", version: "latest"},
  SHOP_ZERO: {secret: "acme-g", version: "0"},
  SHOP_OK: {secret: "acme-h", version: "3", project: "123456789012"}}}' >"$PACK_ENV_FILE"
run "yes" --var-file "$PACK_ENV_FILE"
assert_rc 1 "they stop it"
for line in \
  "    shop_key: a pack env name is upper-case letters, digits and _, and not KINDGI_..." \
  "    KINDGI_SHOP_KEY: a pack env name is upper-case letters, digits and _, and not KINDGI_..." \
  "    SHOP_PATH: secret is a secret id of letters, digits, _ and -, with the project in project, not a path" \
  "    SHOP_KP: secret kp-acme-d starts with kp-, which the pack services own" \
  "    SHOP_PROJECT: project is a project id or number" \
  "    SHOP_LATEST: version is \"latest\": pick its number (gcloud secrets versions list acme-f), and set that" \
  "    SHOP_ZERO: version is a version number"; do
  assert_file_has "$OUT" "$line" "an entry named"
done
if grep -q "SHOP_OK" "$OUT"; then fail "a right entry was named"; else pass; fi
assert_out "fix them in the var file, then run again. Nothing was changed."
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"
assert_varfile_unchanged

# 78. The way back from a switch: the module of the release it came from, the
# var file, then by the deployment's shape the KMS key out of the state
# (secrets_backend "none"), the one pack service's token made again and
# imported (it had one), and server_env's routing given back (multi), each
# its own letter, then the plan. Without a switch, the old step 2.
case_start "the way back from a switch, secrets none, the one pack service"
reset_env "$OLD_PACK"; export STUB_TAGS="0.3.1" STUB_APPLY_RC=1; V_SECRETS="none"; V_AAD=""
run "yes"
assert_rc 1 "the apply fails"
assert_file_has "$OUT" "    a. In this directory, put the module's .tf files as of the" "a. the module"
assert_file_has "$OUT" "       @kindgi/sdk@0.3.1 tag (deploy/gcp-cloud-run) in place of these." "the release it came from"
assert_file_has "$OUT" "    b. Put the var-file back:" "b. the var file"
assert_file_has "$OUT" "    c. Take the KMS key 0.4.0's module made out of the state" "c. the KMS key"
assert_file_has "$OUT" "         terraform state rm google_kms_crypto_key_iam_member.server_wraps google_kms_crypto_key_iam_member.server_reads_key google_kms_crypto_key.secrets google_kms_key_ring.kindgi" "the state rm"
assert_file_has "$OUT" "    d. If terraform state list lists no google_secret_manager_secret.shared," "d. the pack token"
assert_file_has "$OUT" "         gcloud secrets create kindgi-pack-service-token --replication-policy=user-managed --locations=northamerica-northeast2 --project=demo-proj" "the token's secret"
assert_file_has "$OUT" "         terraform import -var-file=$VAR_FILE 'google_secret_manager_secret.shared[\"pack_service_token\"]' projects/demo-proj/secrets/kindgi-pack-service-token" "its import"
assert_file_has "$OUT" "    e. Plan:" "e. the plan"
if grep -qxF "         (umask 077 && terraform plan -var-file=$VAR_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the go-back's plan line"; fi
assert_out "It makes the one pack service again"
if grep -q "give server_env back" "$OUT"; then fail "a single-tenant go-back gives server_env back"; else pass; fi
if grep -q "Steps that finish the switch" "$OUT"; then fail "a failed apply printed the switch's steps"; else pass; fi

case_start "the way back from a switch, postgres, multi"
reset_env; export STUB_TAGS="0.3.1" STUB_APPLY_RC=1; V_TENANCY="multi"
run "yes"
assert_rc 1 "the apply fails"
assert_file_has "$OUT" "    a. In this directory, put the module's .tf files as of the" "a. the module"
assert_file_has "$OUT" "    b. Put the var-file back:" "b. the var file"
assert_file_has "$OUT" "       Then give server_env back the KINDGI_PACK_ROUTING (\"per-deployment\")" "the routing given back"
assert_file_has "$OUT" "    c. Plan:" "c. the plan"
if grep -q -e "^    d\. " -e "Take the KMS key" -e "pack-service-token" -e "It makes the one pack service again" "$OUT"; then fail "steps for a shape this isn't"; else pass; fi

case_start "the way back without a switch"
reset_env; export STUB_TAGS="0.4.0" STUB_APPLY_RC=1
run "yes" --to 0.4.0.1
assert_rc 1 "the apply fails"
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the go-back's plan line"; fi
if grep -q -e "put back the module of" -e "^    a\. " "$OUT"; then fail "a server fix's go-back puts a module back"; else pass; fi

# 79. The variables 0.4.0 took out can't be read: it stops, with terraform's
# error, before anything is mirrored or backed up.
case_start "the variables 0.4.0 took out can't be read"
reset_env; export STUB_TAGS="0.3.1" STUB_REMOVED_RC=1
run "yes"
assert_rc 1 "it stops"
assert_file_has "$OUT" "couldn't read the variables 0.4.0 took out (pack_image, pack_min_instances, pack_env, pack_secret_env) with 'terraform console'. Error: stub refused" "the error"
assert_absent "$STUB_MARKER_MIRROR" "mirror"
assert_absent "$STUB_MARKER_EXPORT" "backup"

# 80. A relative --var-file: the config of the removed variables is elsewhere,
# so it gets the file's absolute path.
case_start "a relative --var-file"
reset_env; export STUB_TAGS="0.3.1"
ARGS=(--var-file dev.tfvars --runtime-digest "$NEW_DIGEST" --backup-bucket "gs://backups/dev" --to 0.4.0)
run "yes" --dry-run
assert_rc 0 "a dry run exits 0"
if grep -qxF "console -var-file=$CASE_DIR/dev.tfvars" "$STUB_REMOVED_SAW"; then pass
else fail "the removed variables' read didn't get an absolute path: $(cat "$STUB_REMOVED_SAW")"; fi

# 81. Real terraform console prints a warning on stdout, ahead of the value,
# for each variable a var file sets that its config doesn't declare: on a
# switch, the module's read warns for pack_image, and the removed variables'
# read for the module's own. The value is console's last line, so the switch
# reaches its plan.
case_start "a switch whose var file still sets pack_image, past console's warnings"
reset_env "$OLD_PACK"; unset STUB_PACK_BEFORE
export STUB_TAGS="0.3.1" STUB_PLAN_CHANGES="$SWITCH_PLAN" STUB_SERVER_ENV="$SWITCH_SERVER_ENV"
run "yes"
assert_rc 0 "it runs"
assert_file_has "$STUB_WARNED" "console pack_image" "the module's read warned"
assert_file_has "$STUB_WARNED" "removed project_id" "the removed variables' read warned"
assert_file_has "$STUB_WARNED" "removed server_image" "the removed variables' read warned"
if grep -q "^removed pack_image" "$STUB_WARNED"; then fail "the removed variables' read warned for pack_image"; else pass; fi
assert_file_has "$STUB_PLAN_SAW" "$NEW_IMAGE" "the plan read the new image"
assert_out "nothing to build: the apply deletes the one pack service"
assert_out "plan check: it changes the image(s), and only what the releases crossed change."

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
