#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Decision-path tests for upgrade.sh, with az / terraform / docker / kindgi /
# sleep stubbed on PATH (jq is real), and npx, npm, openssl, gcloud and
# kubectl stubbed to fail: the script prints the way back's commands and
# never runs one. No cloud calls, no credentials. Run it:
#
#     deploy/azure-container-apps/tests/upgrade_test.sh
#
# Before it runs the script, each time, it checks that every command the
# script can call, besides jq and the shell's own tools (cat, cp, date, sed,
# grep, awk and the like), resolves to a stub here, and it stops if one
# doesn't: the script never reaches a real az, terraform or docker.
#
# The stubs answer only for the shapes the real tools return, and only for
# the names the deployment has: the app read has the image and revisions
# under properties, as Resource Manager returns them, the server read has
# az's flattened backup fields, and a job's run answers only to the
# execution name its start returned. Each case asserts the exit code, key
# output, and what was (or wasn't) copied, run, backed up, applied, deleted
# and written to the var-file. Every stubbed call is logged, so a dry run
# can be held to reads; docker's config is a file of the case's own.

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
REPO="kindgiab12.azurecr.io"
# What the az stub's `acr login --expose-token` prints: it must reach docker
# login's stdin and no command's arguments.
export STUB_ACR_TOKEN="stub-acr-token-$(printf '%032d' 7)"
RUNNING_IMAGE="$REPO/runtime@$OLD_DIGEST"
NEW_IMAGE="$REPO/runtime@$NEW_DIGEST"
OLD_PACK="$REPO/pack@sha256:$(printf '%064d' 2)"
SUB="00000000-0000-0000-0000-0000000000aa"
RG="kindgi-dev"
DB_SERVER="kindgi-pg-ab12"
VAULT="kindgi-ab12"
WORKSPACE="11111111-2222-3333-4444-555555555555"
IDS="/subscriptions/$SUB/resourceGroups/$RG/providers"
IDENTITY="$IDS/Microsoft.ManagedIdentity/userAssignedIdentities/kindgi-server"
ENV_ID="$IDS/Microsoft.App/managedEnvironments/kindgi-env"
DB_SUBNET="$IDS/Microsoft.Network/virtualNetworks/kindgi-vnet/subnets/database"
DB_ZONE="$IDS/Microsoft.Network/privateDnsZones/kindgi.private.postgres.database.azure.com"
TENANT="0b6f2a8e-5c1d-4e7f-9a3b-2d4c6e8f0a1b"

# --- stubs ------------------------------------------------------------------

cat >"$BIN/az" <<'STUB'
#!/usr/bin/env bash
printf 'az %s\n' "$*" >>"${STUB_CALLS_LOG:-/dev/null}"
# The value given after a flag, as az reads it.
arg() {
  local want="$1"; shift
  while [[ $# -gt 0 ]]; do
    if [[ $1 == "$want" ]]; then printf '%s' "${2:-}"; return 0; fi
    shift
  done
}
not_found() { printf "ERROR: (ResourceNotFound) %s\n" "$1" >&2; exit 3; }
case "$*" in
  "account show"*)
    jq -n --arg id "${STUB_SUBSCRIPTION-$STUB_SUB}" '{id: $id, name: "dev", state: "Enabled", isDefault: true}'
    exit 0 ;;
  "acr login"*)
    # Only the token form answers: a plain `az acr login` hands the token to
    # `docker login --password`, in docker's arguments. This one prints the
    # token, for docker login's stdin, and warns as the real one does.
    if [[ " $* " != *" --expose-token "* || $(arg --query "$@") != accessToken || $(arg -o "$@") != tsv ]]; then
      printf 'az %s\n' "$*" >>"$STUB_UNKNOWN_LOG"; exit 97
    fi
    if [[ -n ${STUB_ACR_LOGIN_ERR:-} ]]; then printf '%s\n' "$STUB_ACR_LOGIN_ERR" >&2; exit 1; fi
    printf "WARNING: You can perform manual login using the provided access token below, for example: 'docker login loginServer -u 00000000-0000-0000-0000-000000000000 -p accessToken'\n" >&2
    printf '%s\n' "$STUB_ACR_TOKEN"
    exit 0 ;;
  "acr manifest list-metadata"*)
    # The registry's manifests, each with its digest and tags; the running
    # digest carries STUB_TAGS (;-separated).
    [[ $(arg -r "$@") == kindgiab12 && $(arg -n "$@") == runtime ]] || not_found "registry or repository"
    jq -n --arg d "$STUB_RUNNING_DIGEST" --arg t "${STUB_TAGS:-}" '[
      {digest: "sha256:\("9" * 64)", tags: ["0.1.7"]},
      {digest: $d, tags: ($t | split(";") | map(select(length > 0)))}]'
    exit 0 ;;
  "containerapp show"*)
    [[ $(arg -n "$@") == "$STUB_SERVER_APP" && $(arg -g "$@") == "$STUB_RG" ]] || not_found "container app $(arg -n "$@")"
    if [[ -e $STUB_MARKER_APPLY ]]; then printf '%s' "$STUB_APP_AFTER"; else printf '%s' "$STUB_APP_BEFORE"; fi
    exit 0 ;;
  "postgres flexible-server show"*)
    [[ $(arg -n "$@") == "$STUB_DB_SERVER" && $(arg -g "$@") == "$STUB_RG" ]] || not_found "server $(arg -n "$@")"
    if [[ -n ${STUB_PG_ERR:-} ]]; then printf '%s\n' "$STUB_PG_ERR" >&2; exit 1; fi
    # az prints the server's properties at the top level; with STUB_PG_NESTED,
    # under properties, as Resource Manager returns them.
    jq -n --arg n "$STUB_DB_SERVER" --arg s "${STUB_PG_STATE-Ready}" --arg days "${STUB_PG_RETENTION-7}" \
      --arg e "${STUB_PG_EARLIEST-2026-01-05T08:12:45.123456+00:00}" --arg tier "${STUB_PG_TIER-Burstable}" \
      --arg nested "${STUB_PG_NESTED:-}" '
      {state: $s, version: "16", fullyQualifiedDomainName: ($n + ".postgres.database.azure.com"),
       backup: {backupRetentionDays: ($days | tonumber), geoRedundantBackup: "Disabled", earliestRestoreDate: $e}} as $p
      | {name: $n, sku: {name: "Standard_B1ms", tier: $tier}}
        + (if $nested == "" then $p else {properties: $p} end)'
    exit 0 ;;
  "keyvault secret list-versions"*)
    # database-url's versions, out of order, each with its attributes and
    # tags and no value; the newest is disabled. STUB_URL_RESTORED tags the
    # newest enabled one as a way back's, STUB_URL_RESTORED_OLDER an older one.
    [[ $(arg --vault-name "$@") == "$STUB_VAULT" && $(arg -n "$@") == database-url ]] \
      || not_found "secret $(arg -n "$@") in $(arg --vault-name "$@")"
    if [[ -n ${STUB_KV_VERSIONS_ERR:-} ]]; then printf '%s\n' "$STUB_KV_VERSIONS_ERR" >&2; exit 1; fi
    jq -n --arg v "https://$STUB_VAULT.vault.azure.net/secrets/database-url/" \
      --arg newest "${STUB_URL_RESTORED:-}" --arg older "${STUB_URL_RESTORED_OLDER:-}" '
      def tag($r): if $r == "" then null else {"kindgi-restored-server": $r} end;
      [{id: ($v + ("a" * 32)), attributes: {enabled: true, created: "2026-09-01T10:00:00+00:00"}, tags: tag($older)},
       {id: ($v + ("c" * 32)), attributes: {enabled: false, created: "2026-10-28T09:00:00+00:00"}, tags: null},
       {id: ($v + ("b" * 32)), attributes: {enabled: true, created: "2026-10-01T10:00:00+00:00"}, tags: tag($newest)}]'
    exit 0 ;;
  "keyvault secret list"*)
    # A listing names each secret and holds no value.
    [[ $(arg --vault-name "$@") == "$STUB_VAULT" ]] || not_found "vault $(arg --vault-name "$@")"
    jq -n --arg v "https://$STUB_VAULT.vault.azure.net" --arg url "${STUB_URL_SECRET-enabled}" '
      [{id: ($v + "/secrets/api-token"), name: "api-token", attributes: {enabled: true}}]
      + (if $url == "missing" then [] else
          [{id: ($v + "/secrets/database-url"), name: "database-url", attributes: {enabled: ($url == "enabled")}}] end)'
    exit 0 ;;
  "resource create"*)
    # A check job, made from its whole resource: the case reads the resource
    # and its mode, kept under the job's name.
    printf '%s\n' "$*" >>"$STUB_JOBS_LOG"
    spec="$(arg --properties "$@")"; spec="${spec#@}"
    job="$(arg --id "$@")"; job="${job##*/}"
    if [[ -f $spec ]]; then
      cp "$spec" "$STUB_SPECS_DIR/$job.json"
      ls -l "$spec" | cut -c1-10 >"$STUB_SPECS_DIR/$job.mode"
    fi
    if [[ -n ${STUB_JOB_CREATE_ERR:-} ]]; then printf '%s\n' "$STUB_JOB_CREATE_ERR" >&2; exit 1; fi
    exit 0 ;;
  "containerapp job start"*)
    if [[ -n ${STUB_JOB_START_ERR:-} ]]; then printf '%s\n' "$STUB_JOB_START_ERR" >&2; exit 1; fi
    jq -n --arg n "$(arg -n "$@")-x1y2z3" --arg rg "$STUB_RG" \
      '{id: ("/subscriptions/x/resourceGroups/" + $rg + "/providers/Microsoft.App/jobs/execution/" + $n), name: $n}'
    exit 0 ;;
  "containerapp job execution show"*)
    job="$(arg -n "$@")"; exe="$(arg --job-execution-name "$@")"
    [[ $exe == "$job-x1y2z3" ]] || not_found "execution $exe of $job"
    # STUB_EXEC_STATUS for every job's run, or only for the job whose name
    # ends in STUB_EXEC_ONLY; the others succeed. STUB_EXEC_SEQUENCE, |-separated,
    # answers the first polls, counted over the whole run; an empty one
    # answers nothing, as a read that fails does.
    n=$(( $(cat "$STUB_EXEC_POLLS" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$STUB_EXEC_POLLS"
    status="${STUB_EXEC_STATUS:-Succeeded}"
    if [[ -n ${STUB_EXEC_ONLY:-} && $job != *"$STUB_EXEC_ONLY" ]]; then status="Succeeded"; fi
    if [[ -n ${STUB_EXEC_SEQUENCE:-} ]]; then
      IFS='|' read -r -a seq <<<"$STUB_EXEC_SEQUENCE"
      if ((n <= ${#seq[@]})); then status="${seq[n - 1]}"; fi
    fi
    [[ -n $status ]] || exit 1
    # Under properties, as Resource Manager returns it; with STUB_EXEC_FLAT,
    # at the top level.
    jq -n --arg n "$exe" --arg s "$status" --arg flat "${STUB_EXEC_FLAT:-}" '
      {status: $s, startTime: "2026-10-28T10:00:00+00:00"} as $p
      | {name: $n} + (if $flat == "" then {properties: $p} else $p end)'
    exit 0 ;;
  "containerapp job delete"*)
    printf '%s\n' "$(arg -n "$@")" >>"$STUB_DELETED_LOG"
    exit "${STUB_JOB_DELETE_RC:-0}" ;;
  "containerapp job show"*) exit "${STUB_JOB_SHOW_RC:-3}" ;;
  "postgres flexible-server backup create"*)
    printf '%s\n' "$*" >>"$STUB_BACKUP_LOG"
    if [[ -n ${STUB_BACKUP_ERR:-} ]]; then printf '%s\n' "$STUB_BACKUP_ERR" >&2; exit 1; fi
    exit 0 ;;
  *)
    # The way back's commands (the app's stop and start, restore, secret set...)
    # are printed, never run: any other call is a bug.
    printf 'az %s\n' "$*" >>"$STUB_UNKNOWN_LOG"
    exit 97 ;;
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
  plan)
    # The plan file is the plan as `terraform show -json` gives it: the server
    # and the pack at the images the var files set, a later file over an
    # earlier one and -var over both, as terraform reads them, and the
    # license renewal job at the server's, with STUB_LICENSE_JOB;
    # STUB_PLAN_CHANGES adds resource changes; STUB_PLAN_KEEP_IMAGE leaves the
    # server's image as it is.
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
        --arg pold "$STUB_PACK_BEFORE" --arg pnew "${pack:-$STUB_PACK_BEFORE}" \
        --arg license "${STUB_LICENSE_JOB:-}" --argjson extra "${STUB_PLAN_CHANGES:-[]}" '
        def envs: [{name: "KINDGI_ENV", value: "dev", secret_name: null}];
        def app($type; $n; $addr; $b; $a):
          {address: $addr, mode: "managed", type: $type, name: $n,
           change: {actions: (if $b == $a then ["no-op"] else ["update"] end),
             before: {name: ("kindgi-" + $n), template: [{container: [{name: $n, image: $b, env: envs}]}]},
             after: {name: ("kindgi-" + $n), template: [{container: [{name: $n, image: $a, env: envs}]}]},
             after_unknown: {}}};
        {format_version: "1.2",
         resource_changes: ([app("azurerm_container_app"; "server"; "azurerm_container_app.server"; $old; $new),
                             app("azurerm_container_app"; "pack"; "azurerm_container_app.pack"; $pold; $pnew)]
           + (if $license == "" then [] else
               [app("azurerm_container_app_job"; "license_renewal"; "azurerm_container_app_job.license_renewal[0]"; $old; $new) + {index: 0}] end)
           + $extra)}' >"$out"
    fi
    exit "${STUB_PLAN_RC:-0}" ;;
  show) cat "${3:-}"; exit "${STUB_SHOW_RC:-0}" ;;
  apply) : >"$STUB_MARKER_APPLY"; exit "${STUB_APPLY_RC:-0}" ;;
  *) printf 'terraform %s\n' "$*" >>"$STUB_UNKNOWN_LOG"; exit 97 ;;
esac
STUB

cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${STUB_CALLS_LOG:-/dev/null}"
case "$*" in
  "buildx imagetools inspect"*)
    printf '%s\n' "$*" >>"$STUB_DOCKER_LOG"
    if [[ -n ${STUB_INSPECT_ERR:-} ]]; then printf '%s\n' "$STUB_INSPECT_ERR" >&2; exit 1; fi
    printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":1609}\n' "${STUB_RELEASE_DIGEST:-}"; exit 0 ;;
  "buildx imagetools create"*)
    printf '%s\n' "$*" >>"$STUB_DOCKER_LOG"
    printf 'stub: imagetools create\n' >&2
    : >"$STUB_MARKER_COPY"; exit "${STUB_COPY_RC:-0}" ;;
  "login "*)
    # Only `docker login <server> --username <name> --password-stdin`: the
    # password never in the arguments. As the real one does, it reads all of
    # stdin, drops one trailing newline, and keeps the login in docker's config.
    if [[ $# -ne 5 || $3 != --username || $5 != --password-stdin ]]; then
      printf 'docker %s\n' "$*" >>"$STUB_UNKNOWN_LOG"; exit 97
    fi
    cat >"$STUB_LOGIN_STDIN"
    if [[ -n ${STUB_DOCKER_LOGIN_ERR:-} ]]; then printf '%s\n' "$STUB_DOCKER_LOGIN_ERR" >&2; exit 1; fi
    if [[ ! -s $STUB_LOGIN_STDIN ]]; then
      printf 'Error: Cannot perform an interactive login from a non TTY device\n' >&2; exit 1
    fi
    printf '{"auths":{"%s":{"auth":"stub"}}}\n' "$2" >"$DOCKER_CONFIG/config.json"
    printf 'Login Succeeded\n'; exit 0 ;;
  *) printf 'docker %s\n' "$*" >>"$STUB_UNKNOWN_LOG"; exit 97 ;;
esac
STUB

printf '#!/usr/bin/env bash\nprintf "kindgi %%s\\n" "$*" >>"${STUB_CALLS_LOG:-/dev/null}"\nexit 0\n' >"$BIN/kindgi"
printf '#!/usr/bin/env bash\nprintf "sleep %%s\\n" "$*" >>"${STUB_CALLS_LOG:-/dev/null}"\nexit 0\n' >"$BIN/sleep"
# Printed in the way back, or another cloud's: never to be run.
for c in npx npm openssl gcloud kubectl; do
  printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >>"${STUB_UNKNOWN_LOG:-/dev/null}"\nexit 99\n' "$c" >"$BIN/$c"
done
chmod +x "$BIN"/*

export PATH="$BIN:$PATH"

# Every command the script can call but jq and the shell's own tools.
STUBBED=(az terraform docker kindgi sleep npx npm openssl gcloud kubectl)
# Stops the whole run, before the script is called, unless each of them
# resolves to its stub here.
require_stubs() {
  local c at
  for c in "${STUBBED[@]}"; do
    at="$(command -v "$c" 2>/dev/null || true)"
    if [[ $at != "$BIN/$c" ]]; then
      printf 'refusing to run: %s resolves to %s, not the stub %s\n' "$c" "${at:-nothing}" "$BIN/$c" >&2
      exit 1
    fi
  done
}
require_stubs

# --- fixtures ---------------------------------------------------------------

TF_OUTPUTS=$(cat <<JSON
{"image_registry":{"value":"$REPO"},
 "server_url":{"value":"https://kindgi-server.example.canadacentral.azurecontainerapps.io"},
 "database_server_name":{"value":"$DB_SERVER"},
 "key_vault_name":{"value":"$VAULT"}}
JSON
)

# A vars object, HCL-quoted the way `terraform console` renders jsonencode().
vars_raw() { jq -n --arg s "$1" '$s'; }

# What the script's terraform console expression reads; V_* override it.
mkvars() {
  jq -cn --arg img "$RUNNING_IMAGE" --arg pack "${V_PACK-$OLD_PACK}" --arg prefix "${V_PREFIX:-kindgi}" \
    --arg urlv "${V_DB_URL_VERSION:-}" --arg sub "$SUB" --arg rg "$RG" --arg identity "$IDENTITY" \
    --arg env "$ENV_ID" --arg ws "$WORKSPACE" --arg subnet "$DB_SUBNET" --arg zone "$DB_ZONE" '{
    subscription_id:$sub, resource_group_name:$rg, name_prefix:$prefix, database_name:"kindgi",
    database_url_version:$urlv, server_image:$img, pack_image:$pack,
    vault_uri:"https://kindgi-ab12.vault.azure.net/", server_identity:$identity,
    environment_id:$env, workspace_id:$ws, database_subnet_id:$subnet, database_dns_zone_id:$zone}'
}

# The server app as `az containerapp show` returns it. $1 image, $2 the
# latest revision, $3 the latest ready one, $4 the provisioning state.
app_json() {
  jq -cn --arg i "$1" --arg l "$2" --arg r "$3" --arg s "${4:-Succeeded}" '{
    name: "kindgi-server", type: "Microsoft.App/containerApps", location: "canadacentral",
    properties: {provisioningState: $s, latestRevisionName: $l, latestReadyRevisionName: $r,
      configuration: {activeRevisionsMode: "Single"},
      template: {containers: [{name: "server", image: $i}]}}}'
}
APP_BEFORE="$(app_json "$RUNNING_IMAGE" kindgi-server--0000001 kindgi-server--0000001)"
APP_READY="$(app_json "$NEW_IMAGE" kindgi-server--0000002 kindgi-server--0000002)"
APP_STUCK="$(app_json "$NEW_IMAGE" kindgi-server--0000002 kindgi-server--0000001 Failed)"
# The new image, but no new revision: the old one is still the latest.
APP_SAME_REVISION="$(app_json "$NEW_IMAGE" kindgi-server--0000001 kindgi-server--0000001)"

# --- harness ----------------------------------------------------------------

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$*"; }

# A fresh case directory, var-file and markers. $1 = a pack_image line to add.
reset_env() {
  unset STUB_TAGS STUB_SUBSCRIPTION STUB_ACR_LOGIN_ERR STUB_DOCKER_LOGIN_ERR STUB_PG_ERR STUB_PG_STATE STUB_PG_RETENTION \
        STUB_PG_EARLIEST STUB_PG_TIER STUB_PG_NESTED STUB_URL_SECRET STUB_JOB_CREATE_ERR STUB_JOB_START_ERR \
        STUB_EXEC_STATUS STUB_EXEC_ONLY STUB_EXEC_SEQUENCE STUB_JOB_DELETE_RC STUB_JOB_SHOW_RC STUB_BACKUP_ERR \
        STUB_PLAN_RC STUB_APPLY_RC STUB_COPY_RC STUB_INSPECT_ERR STUB_PLAN_CHANGES STUB_PLAN_KEEP_IMAGE \
        STUB_SHOW_RC STUB_LICENSE_JOB STUB_URL_RESTORED STUB_URL_RESTORED_OLDER STUB_KV_VERSIONS_ERR \
        STUB_EXEC_FLAT V_PACK V_PREFIX V_DB_URL_VERSION
  CASE_DIR="$(mktemp -d "$TMP/case.XXXXXX")"
  OUT="$CASE_DIR/out.txt"
  VAR_FILE="$CASE_DIR/dev.tfvars"
  {
    printf 'subscription_id = "%s"\n' "$SUB"
    printf '# the runtime, pinned by digest\n'
    printf 'server_image = "%s"  # copied 0.1.8\n' "$RUNNING_IMAGE"
    if [[ -n ${1:-} ]]; then printf 'pack_image   = "%s"\n' "$1"; fi
  } >"$VAR_FILE"
  cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
  export STUB_PACK_BEFORE="${1:-$OLD_PACK}"
  export STUB_SUB="$SUB" STUB_RG="$RG" STUB_DB_SERVER="$DB_SERVER" STUB_VAULT="$VAULT"
  export STUB_TF_OUTPUTS="$TF_OUTPUTS"
  export STUB_RUNNING_IMAGE="$RUNNING_IMAGE"
  export STUB_RUNNING_DIGEST="$OLD_DIGEST"
  export STUB_APP_BEFORE="$APP_BEFORE"
  export STUB_APP_AFTER="$APP_READY"
  export STUB_RELEASE_DIGEST="$NEW_DIGEST"
  export STUB_DOCKER_LOG="$CASE_DIR/docker.log"
  export STUB_LOGIN_STDIN="$CASE_DIR/login-stdin"
  export STUB_MARKER_APPLY="$CASE_DIR/applied"
  export STUB_MARKER_COPY="$CASE_DIR/copied"
  export STUB_PLAN_SAW="$CASE_DIR/plan-saw"
  export STUB_JOBS_LOG="$CASE_DIR/jobs.log"
  export STUB_SPECS_DIR="$CASE_DIR/specs"
  export STUB_DELETED_LOG="$CASE_DIR/deleted.log"
  export STUB_BACKUP_LOG="$CASE_DIR/backup.log"
  export STUB_EXEC_POLLS="$CASE_DIR/exec-polls"
  export STUB_CALLS_LOG="$CASE_DIR/calls.log"
  export STUB_WARNED="$CASE_DIR/warned"
  export STUB_UNKNOWN_LOG="$CASE_DIR/unknown.log"
  export AZURE_CONFIG_DIR="$CASE_DIR/azure"
  export DOCKER_CONFIG="$CASE_DIR/docker"
  mkdir -p "$DOCKER_CONFIG" "$AZURE_CONFIG_DIR" "$STUB_SPECS_DIR"
  printf '{"auths":{"registry.kindgi.com":{}}}\n' >"$DOCKER_CONFIG/config.json"
  cp "$DOCKER_CONFIG/config.json" "$CASE_DIR/original-docker-config.json"
  # 0.2.0 unless a case says otherwise; the default, the newest release the
  # script knows, has a case of its own.
  ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST" --to 0.2.0)
}

run() { # $1 = stdin (the plan confirmation); rest = extra script args
  local confirm="$1"; shift
  export STUB_TF_VARS_RAW; STUB_TF_VARS_RAW="$(vars_raw "$(mkvars)")"
  export STUB_SERVER_APP="${V_PREFIX:-kindgi}-server"
  require_stubs
  # From the case's directory, as from the module's: what Terraform loads on
  # its own is looked for there.
  ( cd "$CASE_DIR" && "$SCRIPT" "${ARGS[@]}" "$@" ) >"$OUT" 2>&1 <<<"$confirm"
  rc=$?
  # A call no stub answers is one the script must never make.
  if [[ -s $STUB_UNKNOWN_LOG ]]; then fail "made a call it never should: $(tr '\n' ';' <"$STUB_UNKNOWN_LOG")"; fi
}

case_start() { printf '• %s\n' "$1"; }
assert_rc()      { if [[ $rc -eq $1 ]]; then pass; else fail "$2 (rc=$rc, wanted $1)"; fi; }
assert_out()     { if grep -qi -- "$1" "$OUT"; then pass; else fail "output missing /$1/"; fi; }
assert_absent()  { if [[ ! -e $1 ]]; then pass; else fail "$2 happened but shouldn't have"; fi; }
assert_present() { if [[ -e $1 ]]; then pass; else fail "$2 should have happened"; fi; }
assert_file_has() { if grep -qF -- "$2" "$1" 2>/dev/null; then pass; else fail "$3: $1 lacks \"$2\""; fi; }
assert_file_lacks() { if grep -qF -- "$2" "$1" 2>/dev/null; then fail "$3: $1 has \"$2\""; else pass; fi; }
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
  other="$(grep -vE '^(az (account show|containerapp show|acr manifest list-metadata|postgres flexible-server show|keyvault secret list|keyvault secret list-versions) |docker buildx imagetools inspect |terraform output -json$|terraform console( -var-file=[^ ]+)+$|terraform plan( -var-file=[^ ]+)+ -var server_image=[^ ]+ -lock=false -out=[^ ]+$|terraform show -json [^ ]+$)' "$STUB_CALLS_LOG")"
  if [[ -z $other ]]; then pass; else fail "made a call that isn't a read: $other"; fi
}
# No call reached Azure: a refusal before anything is read from it.
assert_no_az() {
  if grep -q '^az ' "$STUB_CALLS_LOG" 2>/dev/null; then fail "$1: it called az: $(grep '^az ' "$STUB_CALLS_LOG" | head -n 1)"; else pass; fi
}
# The check jobs the run created, by name, in the order it created them.
jobs_made() { sed -nE 's|^resource create --id [^ ]*/Microsoft\.App/jobs/([^ ]+) .*|\1|p' "$STUB_JOBS_LOG" 2>/dev/null; }
# Every check job the run created was deleted, however the run ended.
assert_jobs_deleted() {
  local made gone
  made="$(jobs_made | sort)"
  gone="$(sort "$STUB_DELETED_LOG" 2>/dev/null)"
  if [[ -n $made && $made == "$gone" ]]; then pass; else fail "$1: the jobs made ($(tr '\n' ' ' <<<"$made")) aren't the ones deleted ($(tr '\n' ' ' <<<"$gone"))"; fi
}
# Each check job's name was printed, with how to delete it, when it was made.
assert_jobs_named() {
  local job missing=""
  for job in $(jobs_made); do
    grep -qF "creating the check job $job (deleted when this run ends; if the run is killed first: az containerapp job delete -n $job -g $RG --yes)" "$OUT" \
      || missing+=" $job"
  done
  if [[ -z $missing && -s $STUB_JOBS_LOG ]]; then pass; else fail "a check job's name wasn't printed as it was made:${missing:- (no job made)}"; fi
}
# The first line of $1 with the fixed string $2, or nothing.
first_line() { grep -nF -- "$2" "$1" 2>/dev/null | head -n 1 | cut -d: -f1; }
assert_before() { # file, earlier, later, what
  local a b
  a="$(first_line "$1" "$2")"; b="$(first_line "$1" "$3")"
  if [[ -n $a && -n $b && $a -lt $b ]]; then pass; else fail "$4: \"$2\" (line ${a:-none}) isn't before \"$3\" (line ${b:-none})"; fi
}
sleeps() { grep -c '^sleep ' "$STUB_CALLS_LOG" 2>/dev/null; }
# The command a stopped check prints to read its run's logs.
logs_command() {
  printf '%s' "az monitor log-analytics query -w $WORKSPACE --analytics-query \"ContainerAppConsoleLogs_CL | where ContainerJobName_s == '$1' and ContainerGroupName_s startswith '$1-x1y2z3' | order by _timestamp_d asc\" --query \"[].Log_s\" -o tsv"
}

# 0. The stub check: with a command that isn't the stub first on PATH, the
# harness refuses before it calls the script.
case_start "the harness refuses a PATH that reaches a real command"
mkdir -p "$TMP/elsewhere"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP/elsewhere/az"; chmod +x "$TMP/elsewhere/az"
( PATH="$TMP/elsewhere:$PATH"; require_stubs ) 2>"$TMP/refused.txt"; rc=$?
assert_rc 1 "a PATH whose az isn't the stub is refused"
assert_file_has "$TMP/refused.txt" "refusing to run: az resolves to $TMP/elsewhere/az, not the stub $BIN/az" "the refusal names the command"
( PATH="${PATH#"$BIN:"}"; require_stubs ) 2>"$TMP/refused.txt"; rc=$?
assert_rc 1 "a PATH without the stubs is refused"

# 1. Happy path: 0.1.8 -> 0.2.0, confirm yes.
case_start "happy path"
reset_env; export STUB_TAGS="0.1.8"
run "yes"
assert_rc 0 "happy path exits 0"
assert_present "$STUB_MARKER_COPY" "copy"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.1.8 -> 0.2.0 applied"
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"  # copied 0.1.8" "var-file pins the new image, comment kept"
assert_file_has "$STUB_PLAN_SAW" "$NEW_IMAGE" "the plan read the new image from the var-file"
if grep -q "plan got -var" "$STUB_PLAN_SAW"; then fail "plan was given -var"; else pass; fi
assert_out "plan check: it changes the image(s), and only what the releases crossed change."
# The plan applied is kept next to the var-file's copy, readable by its owner
# alone, and the run says where; the apply is given that file.
kept="$(ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan 2>/dev/null)"
if [[ -n $kept && -f $kept ]]; then pass; else fail "the plan applied wasn't kept next to the var-file"; fi
assert_file_has "$OUT" "yes applies exactly this plan, and keeps it as $kept." "the prompt says where the plan goes"
assert_file_has "$OUT" "the plan applied at $kept." "the end says where the plan is"
assert_file_has "$STUB_CALLS_LOG" "terraform apply $kept" "yes applies the kept plan"
if [[ "$(ls -l "$kept" | cut -c1-10)" == "-rw-------" ]]; then pass; else fail "the kept plan is readable by others: $(ls -l "$kept")"; fi
if cmp -s "$(ls "$CASE_DIR"/dev.tfvars.pre-upgrade-*)" "$CASE_DIR/original.tfvars"; then pass; else fail "no .pre-upgrade copy of the original"; fi
if cmp -s "$DOCKER_CONFIG/config.json" "$CASE_DIR/original-docker-config.json"; then fail "docker wasn't logged in to the module's registry"; else pass; fi
assert_file_has "$STUB_CALLS_LOG" "az acr login -n kindgiab12 --expose-token --query accessToken -o tsv" "a token for the registry, by its name"
assert_file_has "$STUB_CALLS_LOG" "docker login $REPO --username 00000000-0000-0000-0000-000000000000 --password-stdin" "docker logged in to the registry with the token's username"
# The token goes from az's stdout to docker login's stdin, and nowhere else.
if [[ "$(cat "$STUB_LOGIN_STDIN" 2>/dev/null)" == "$STUB_ACR_TOKEN" ]]; then pass; else fail "docker login didn't get az's token on its stdin"; fi
assert_file_lacks "$STUB_CALLS_LOG" "$STUB_ACR_TOKEN" "the token is in no command's arguments"
assert_file_lacks "$OUT" "$STUB_ACR_TOKEN" "the token isn't printed"
# The image is copied before any check job is made: the jobs pull it.
assert_before "$STUB_CALLS_LOG" "docker login" "docker buildx imagetools create" "the login comes before the copy"
assert_before "$STUB_CALLS_LOG" "docker buildx imagetools create" "az resource create" "the copy comes before the checks"
# The subscription az is set to is checked before anything else is read.
assert_before "$STUB_CALLS_LOG" "az account show" "az containerapp show" "the subscription is checked first"
assert_out "subscription    $SUB"
assert_out "resource group  $RG"
assert_out "read 0.1.8 from the copied image's tag"
# Three jobs, one per check, each named, each run with the new image and
# deleted at the end.
if [[ "$(jobs_made | wc -l | tr -d ' ')" == 3 ]]; then pass; else fail "wanted 3 check jobs, got $(jobs_made | wc -l | tr -d ' ')"; fi
assert_jobs_named
assert_jobs_deleted "after a run that succeeds"
assert_out "check provider-keys: ok"
assert_out "check secret-scopes: ok"
assert_out "check mcp-header-credentials: ok"
assert_out "all automated checks passed."
# The backup: the module's default tier is Burstable, which takes no
# on-demand backup; the restore point is printed.
assert_absent "$STUB_BACKUP_LOG" "an on-demand backup on Burstable"
assert_out "No on-demand backup: the Burstable tier takes none."
assert_out "Azure keeps 7 days of backups of $DB_SERVER; the earliest point it restores to is 2026-01-05T08:12:45.123456+00:00."
T="$(sed -nE 's/^  restore point: ([^ ]+) \(UTC\), on kindgi-pg-ab12\. The way back restores to it\.$/\1/p' "$OUT")"
if [[ $T =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then pass; else fail "the restore point isn't printed as a UTC time: \"$T\""; fi
assert_out "Restore point $T on $DB_SERVER; the previous var-file at"
assert_out "revision kindgi-server--0000002 is serving."
# No tenant is listed or touched, and nothing of the way back is run.
if grep -q "tenants" "$STUB_CALLS_LOG"; then fail "a tenants command ran"; else pass; fi

# 1a. Each check job: in the module's environment, a manual trigger, one
# replica, no retry, the job's timeout; the new image pulled with the
# server's identity; the database URL by Key Vault reference, versionless,
# as the server reads it; that URL its one env var; and the check as its args.
# Each is made whole through Resource Manager, from a resource only this
# user can read, in the server's region.
case_start "what each check job is made with"
for job in $(jobs_made); do
  line="$(grep -F -- "/Microsoft.App/jobs/$job " "$STUB_JOBS_LOG")"
  case "$job" in
    *-pk) check="provider-keys" ;; *-ss) check="secret-scopes" ;; *-mhc) check="mcp-header-credentials" ;; *) check="?" ;;
  esac
  want="resource create --id $IDS/Microsoft.App/jobs/$job --api-version 2025-01-01 --is-full-object --properties @"
  if [[ $line == "$want"*"/$job.json -o none" ]]; then pass; else fail "the job $job is made with: $line"; fi
  want="$(jq -S -c -n --arg job "$job" --arg check "$check" --arg id "$IDENTITY" --arg env "$ENV_ID" \
    --arg repo "$REPO" --arg image "$NEW_IMAGE" --arg url "https://$VAULT.vault.azure.net/secrets/database-url" '{
    location: "canadacentral",
    identity: {type: "UserAssigned", userAssignedIdentities: {($id): {}}},
    properties: {environmentId: $env, workloadProfileName: "Consumption",
      configuration: {triggerType: "Manual", replicaTimeout: 600, replicaRetryLimit: 0,
        manualTriggerConfig: {parallelism: 1, replicaCompletionCount: 1},
        secrets: [{name: "database-url", keyVaultUrl: $url, identity: $id}],
        registries: [{server: $repo, identity: $id}]},
      template: {containers: [{name: $job, image: $image, args: ["check", $check],
        env: [{name: "KINDGI_DATABASE_URL", secretRef: "database-url"}]}]}}}')"
  got="$(jq -S -c . "$STUB_SPECS_DIR/$job.json" 2>/dev/null)"
  if [[ -n $got && $got == "$want" ]]; then pass; else fail "the job $job is made from: ${got:-(no resource)}"; fi
  if [[ "$(cat "$STUB_SPECS_DIR/$job.mode" 2>/dev/null)" == "-rw-------" ]]; then pass; else fail "the job $job's resource is readable by others"; fi
done
if [[ "$(jobs_made | wc -l | tr -d ' ')" == 3 ]]; then pass; else fail "the run didn't make 3 check jobs: $(jobs_made | tr '\n' ' ')"; fi

# 1b. --check-tenant goes to each job as two arguments of its own, which
# az containerapp's --args would read as its own option.
case_start "--check-tenant"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --check-tenant "$TENANT"
assert_rc 0 "--check-tenant runs"
n=0
for job in $(jobs_made); do
  jq -e --arg t "$TENANT" '.properties.template.containers[0].args | length == 4 and .[0] == "check" and .[2:] == ["--tenant", $t]' \
    "$STUB_SPECS_DIR/$job.json" >/dev/null 2>&1 && n=$((n + 1))
done
if [[ $n == 3 ]]; then pass; else fail "each job doesn't get --tenant: $(cat "$STUB_SPECS_DIR"/*.json 2>/dev/null)"; fi

case_start "--check-tenant that isn't a uuid"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --check-tenant "acme; rm x"
assert_rc 1 "a tenant that isn't a uuid is refused"
assert_out "--check-tenant \"acme; rm x\" isn't a tenant id (a uuid)."
assert_absent "$STUB_CALLS_LOG" "a call"

# 2. Below the floor: 0.1.7 is refused, nothing copied or run.
case_start "below floor"
reset_env; export STUB_TAGS="0.1.7"
run "yes"
assert_rc 1 "floor refused"
assert_out "upgrades from 0.1.8"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_varfile_unchanged

# 3. Already at the target.
case_start "already at target"
reset_env; export STUB_TAGS="0.2.0"
run "yes"
assert_rc 1 "already at target"
assert_out "already on 0.2.0"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 4. A check's run ends Failed: stop before the plan, say which, and how to
# read its logs after the job is gone; every job is deleted.
case_start "a check fails"
reset_env; export STUB_TAGS="0.1.8" STUB_EXEC_STATUS="Failed" STUB_EXEC_ONLY="-ss"
run "yes"
assert_rc 1 "check failure stops it"
assert_out "check provider-keys: ok"
assert_out "CHECK FAILED: the runtime check \"secret-scopes\" ended Failed, not Succeeded"
ss_job="$(jobs_made | grep -- '-ss$')"
assert_file_has "$OUT" "Its run is $ss_job-x1y2z3; its logs, which reach Log Analytics a few minutes after it ends, and stay there after this run deletes the job: $(logs_command "$ss_job")" "the logs command"
assert_out "one or more checks failed (above). Nothing was backed up or changed."
assert_absent "$STUB_PLAN_SAW" "a plan"
assert_absent "$STUB_BACKUP_LOG" "a backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_jobs_deleted "after a check fails"
assert_varfile_unchanged

# 4a. Only Succeeded passes: any other end stops it, each with its logs command.
for status in Stopped Degraded Unknown Cancelled; do
  case_start "a check's run ends $status"
  reset_env; export STUB_TAGS="0.1.8" STUB_EXEC_STATUS="$status" STUB_EXEC_ONLY="-pk"
  run "yes"
  assert_rc 1 "$status stops it"
  pk_job="$(jobs_made | grep -- '-pk$')"
  assert_out "the runtime check \"provider-keys\" ended $status, not Succeeded"
  assert_file_has "$OUT" "$(logs_command "$pk_job")" "the logs command for $status"
  assert_out "checks failed"
  assert_absent "$STUB_PLAN_SAW" "a plan"
  assert_jobs_deleted "after a run ends $status"
done

# 4b. A run still going, or not readable yet, is asked again until it ends.
case_start "a check's run is followed until it ends"
reset_env; export STUB_TAGS="0.1.8" STUB_EXEC_SEQUENCE="|Processing|Running"
run "yes"
assert_rc 0 "a run that ends Succeeded passes"
assert_out "check provider-keys: ok"
if [[ "$(sleeps)" == 3 ]]; then pass; else fail "wanted 3 waits between polls, got $(sleeps)"; fi
assert_file_has "$STUB_CALLS_LOG" "sleep 10" "it waits 10s between polls"

# 4c. A run that never ends: it stops at the job's timeout and the start's
# margin, 720s, says what the run was, and how to read its logs.
case_start "a check's run past the bound"
reset_env; export STUB_TAGS="0.1.8" STUB_EXEC_STATUS="Running" STUB_EXEC_ONLY="-pk"
run "yes"
assert_rc 1 "a run past the bound stops it"
pk_job="$(jobs_made | grep -- '-pk$')"
assert_out "the runtime check \"provider-keys\" didn't end within 720s (the job's 600s timeout, and 120s to start): it was Running."
assert_file_has "$OUT" "$(logs_command "$pk_job")" "the logs command"
if [[ "$(sleeps)" == 72 ]]; then pass; else fail "wanted 72 waits of 10s before it stops, got $(sleeps)"; fi
assert_out "check secret-scopes: ok"
assert_absent "$STUB_PLAN_SAW" "a plan"
assert_jobs_deleted "after a run past the bound"

# 4d. A job that can't be made, or can't start: the check fails, and the job
# is deleted all the same (its create may have got far enough to make it).
case_start "a check job can't be made"
reset_env; export STUB_TAGS="0.1.8" STUB_JOB_CREATE_ERR="ERROR: (InvalidParameterValueInContainerTemplate) acme"
run "yes"
assert_rc 1 "a job that can't be made stops it"
assert_out "couldn't create the check job"
assert_out "InvalidParameterValueInContainerTemplate"
assert_jobs_named
assert_jobs_deleted "after a create fails"
assert_absent "$STUB_PLAN_SAW" "a plan"

case_start "a check job can't start"
reset_env; export STUB_TAGS="0.1.8" STUB_JOB_START_ERR="ERROR: (JobExecutionFailed) acme"
run "yes"
assert_rc 1 "a job that can't start stops it"
assert_out "couldn't start the check job"
assert_jobs_deleted "after a start fails"

# 4e. A job the cleanup can't delete, still there: the run says so, with the
# command that deletes it.
case_start "a check job the cleanup can't delete"
reset_env; export STUB_TAGS="0.1.8" STUB_JOB_DELETE_RC=1 STUB_JOB_SHOW_RC=0
run "yes"
assert_rc 0 "the run itself succeeds"
for job in $(jobs_made); do
  assert_file_has "$OUT" "couldn't delete the check job $job. Delete it with: az containerapp job delete -n $job -g $RG --yes" "the leftover named"
done

# 5. Plan refused: nothing backed up or applied, the var-file put back.
case_start "plan refused"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_TIER="GeneralPurpose"
run "no"
assert_rc 1 "refusal stops it"
assert_out "not confirmed"
assert_out "put back"
assert_absent "$STUB_BACKUP_LOG" "an on-demand backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_jobs_deleted "after the plan is refused"
assert_varfile_unchanged
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a plan not confirmed was kept"; else pass; fi

# 6. Apply fails: the way back is printed, the var-file keeps the new image.
case_start "apply fails"
reset_env; export STUB_TAGS="0.1.8" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_out "To go back"
assert_jobs_deleted "after the apply fails"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.1 memory erasures export --out=erasures-" "the export runs 0.1.8's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.1 memory erasures replay erasures-" "the replay runs 0.1.8's CLI line"
if grep -qF "pre-release" "$OUT"; then fail "a final's way back has the pre-release note"; else pass; fi
# Stop the server's app through Container Apps' REST API, then a check that
# it's stopped, before anything changes.
APP_URL="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/containerApps/kindgi-server"
assert_file_has "$OUT" "      az rest --method post --url \"$APP_URL/stop?api-version=2025-01-01\"" "the app stopped"
assert_file_has "$OUT" "      az rest --method get --url \"$APP_URL?api-version=2025-01-01\" --query properties.runningStatus -o tsv" "its running status read"
assert_out "Go on only once this prints Stopped"
assert_file_lacks "$OUT" "management.azure.com" "az rest adds the cloud's own endpoint"
# Restore to the restore point this run printed, into the module's network.
T="$(sed -nE 's/^  restore point: ([^ ]+) \(UTC\).*/\1/p' "$OUT")"
restored="$DB_SERVER-r$(date -u +%Y%m%d)"
assert_file_has "$OUT" "      az postgres flexible-server restore -g $RG --name $restored \\" "the restore makes a new server"
assert_file_has "$OUT" "        --source-server $DB_SERVER --restore-time $T \\" "the restore goes to the restore point printed"
assert_file_has "$OUT" "        --subnet $DB_SUBNET \\" "the restore is in the database subnet"
assert_file_has "$OUT" "        --private-dns-zone $DB_ZONE" "the restore is in the private DNS zone"
assert_file_has "$OUT" "      az postgres flexible-server parameter set -g $RG --server-name $restored \\" "pgvector allowed on the restored server"
assert_file_has "$OUT" "        --name azure.extensions --value VECTOR" "azure.extensions set"
assert_file_has "$OUT" "      export AZURE_LOGGING_ENABLE_LOG_FILE=no" "az's log file off for the password"
assert_file_has "$OUT" "| az keyvault secret set --vault-name $VAULT -n database-url --file /dev/stdin \\" "a new version of database-url"
assert_file_has "$OUT" "          --tags kindgi-restored-server=$restored --query id -o tsv" "tagged with the restored server"
assert_out "set database_url_version in it"
assert_out "cp $VAR_FILE.pre-upgrade-"
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the way back doesn't plan with the var-file alone"; fi
if grep -qxF "      terraform apply back.tfplan" "$OUT"; then pass; else fail "the way back doesn't apply its saved plan"; fi
# Before the start: the old image's revision alone is active; one with the
# new image is deactivated. Then the start, its status, and the revision.
assert_out "lists that revision alone, with the old image, $RUNNING_IMAGE:"
assert_file_has "$OUT" "      az containerapp revision list -n kindgi-server -g $RG --query \"[].[name, properties.template.containers[0].image]\" -o tsv" "the active revisions and their images listed"
assert_file_has "$OUT" "      az containerapp revision deactivate -n kindgi-server -g $RG --revision <its name>" "the new image's revision deactivated"
assert_file_has "$OUT" "      az rest --method post --url \"$APP_URL/start?api-version=2025-01-01\"" "the app started"
assert_out "go on once the second command prints Running"
assert_file_has "$OUT" "      az containerapp show -n kindgi-server -g $RG --query \"[properties.latestRevisionName, properties.latestReadyRevisionName]\" -o tsv" "the new revision checked"
assert_out "refuses to start while"
assert_out "or while the version step 4 tagged is"
# In that order: the export (it needs the server), the stop (the first
# change), the restore, its parameter, the URL, the pin, the apply, the
# revisions' check, the start, the replay.
assert_before "$OUT" "memory erasures export" "/stop?api-version" "the ledger is exported before the stop"
assert_before "$OUT" "/stop?api-version" "az postgres flexible-server restore" "the server stops before the restore"
assert_before "$OUT" "az postgres flexible-server restore" "--name azure.extensions" "the restore comes before its parameter"
assert_before "$OUT" "--name azure.extensions" "az keyvault secret set" "the parameter comes before the URL"
assert_before "$OUT" "az keyvault secret set" "set database_url_version in it" "the URL comes before its pin"
assert_before "$OUT" "set database_url_version in it" "terraform apply back.tfplan" "the pin comes before the apply"
assert_before "$OUT" "terraform apply back.tfplan" "az containerapp revision list" "the apply comes before the revisions' check"
assert_before "$OUT" "az containerapp revision list" "/start?api-version" "the revisions' check comes before the start"
assert_before "$OUT" "/start?api-version" "memory erasures replay" "the start comes before the replay"
assert_file_has "$VAR_FILE" "$NEW_IMAGE" "var-file keeps the new image after a failed apply"

# 7. The new revision never becomes ready: the way back is printed.
case_start "start never ready"
reset_env; export STUB_TAGS="0.1.8" STUB_APP_AFTER="$APP_STUCK"
run "yes"
assert_rc 1 "unhealthy start"
assert_out "did not become ready within 600s"
assert_out "into a NEW server"
assert_jobs_deleted "after the revision never comes up"

# 7a. A new image with no new revision isn't ready: the wait wants a newer
# revision than the one serving before the apply.
case_start "no new revision"
reset_env; export STUB_TAGS="0.1.8" STUB_APP_AFTER="$APP_SAME_REVISION"
run "yes"
assert_rc 1 "the old revision isn't the new one"
assert_out "did not become ready"
assert_out "To go back"

# 7b. The way back names the CLI of the release the run started from: a server
# fix for 0.2.0 is on the 0.2 line.
case_start "go-back from a server fix"
reset_env; export STUB_APP_AFTER="$APP_STUCK"
run "yes" --from 0.2.0.1 --to 0.2.0.2
assert_rc 1 "unhealthy start"
assert_out "did not become ready"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures export --out=erasures-" "the export runs 0.2.0.1's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures replay erasures-" "the replay runs 0.2.0.1's CLI line"
if grep -qF "@kindgi/cli@0.1" "$OUT"; then fail "the way back from 0.2.0.1 names the 0.1 CLI"; else pass; fi
if grep -qF "pre-release" "$OUT"; then fail "a server fix's way back has the pre-release note"; else pass; fi

# 7c. From an rc, the 0.2 line finds no CLI until 0.2.0 is out: a note right
# under the export says so.
case_start "go-back from an rc"
reset_env; export STUB_TAGS="0.2.0-rc.0" STUB_APPLY_RC=1
run "yes"
assert_rc 1 "apply failure"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures export --out=erasures-" "the export runs the rc's CLI line"
assert_file_has "$OUT" "npx --yes @kindgi/cli@0.2 memory erasures replay erasures-" "the replay runs the rc's CLI line"
note="$(grep -A4 -F "memory erasures export" "$OUT" | tail -n 4)"
if [[ $note == "    This deployment runs a pre-release, 0.2.0-rc.0. Until 0.2.0 is out,
    npx finds no @kindgi/cli@0.2: in this step and in step 6, name the
    CLI's own pre-release instead, as @kindgi/cli@0.2.0-rc.N
    (npm view @kindgi/cli versions lists them)." ]]; then pass
else fail "the pre-release note isn't right under the export: $note"; fi

# 8. A pinned database URL is a way back's: refused before anything is read
# from Azure, so nothing is checked against, copied to or backed up from a
# server the module's state doesn't hold.
case_start "database_url_version set"
reset_env; export STUB_TAGS="0.1.8"; V_DB_URL_VERSION="00112233445566778899aabbccddeeff"
run "yes"
assert_rc 1 "a pinned URL refused"
assert_out "database_url_version is set"
assert_out "so it doesn't run while it's set"
assert_no_az "a pinned URL"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_varfile_unchanged

case_start "database_url_version set, dry run"
reset_env; export STUB_TAGS="0.1.8"; V_DB_URL_VERSION="00112233445566778899aabbccddeeff"
run "yes" --dry-run
assert_rc 1 "a pinned URL refused in a dry run too"
assert_out "upgrade (dry run): database_url_version is set"
assert_no_az "a pinned URL, dry run"

# 9. The database server's backups must cover the way back, checked before
# anything is copied or run.
case_start "retention under 7 days"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_RETENTION=6
run "yes"
assert_rc 1 "a short retention stops it"
assert_out "keeps 6 days of backups: going back restores it to a point in time, which needs at least 7 (database_backup_retention_days)."
assert_out "a precondition failed (above). Nothing was copied, backed up or changed."
if grep -qE "^(az acr login|docker login) " "$STUB_CALLS_LOG"; then fail "docker was logged in to the registry"; else pass; fi
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_docker_config_unchanged
assert_varfile_unchanged

case_start "no restore point in the past"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_EARLIEST="2099-01-01T00:00:00+00:00"
run "yes"
assert_rc 1 "a future restore point stops it"
assert_out "has no restore point in the past (its earliest restore date is \"2099-01-01T00:00:00+00:00\")"
assert_absent "$STUB_MARKER_COPY" "copy"

case_start "an unreadable earliest restore date"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_EARLIEST=""
run "yes"
assert_rc 1 "no restore date stops it"
assert_out "its earliest restore date is \"unreadable\""
assert_absent "$STUB_MARKER_COPY" "copy"

case_start "the database server isn't Ready"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_STATE="Stopped"
run "yes"
assert_rc 1 "a stopped server stops it"
assert_out "the database server $DB_SERVER is \"Stopped\", not Ready."
assert_absent "$STUB_MARKER_COPY" "copy"

case_start "the database server can't be read"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_ERR="ERROR: (AuthorizationFailed) acme"
run "yes"
assert_rc 1 "an unreadable server stops it"
assert_out "couldn't read the database server $DB_SERVER. ERROR: (AuthorizationFailed) acme"
assert_absent "$STUB_MARKER_COPY" "copy"

case_start "the server's fields under properties"
reset_env; export STUB_TAGS="0.1.8" STUB_PG_NESTED=1
run "yes"
assert_rc 0 "the Resource Manager shape is read too"
assert_out "Azure keeps 7 days of backups"

# 9a. A job run's status at the top level, as az prints some reads.
case_start "a job run's status at the top level"
reset_env; export STUB_TAGS="0.1.8" STUB_EXEC_FLAT=1
run "yes"
assert_rc 0 "a flat status is read too"
assert_out "check provider-keys: ok"

# 10. The URL secret the jobs and the server read must be there, enabled.
for url in missing disabled; do
  case_start "database-url $url"
  reset_env; export STUB_TAGS="0.1.8" STUB_URL_SECRET="$url"
  run "yes"
  assert_rc 1 "a $url URL secret stops it"
  assert_out "the vault $VAULT has no enabled secret database-url"
  assert_absent "$STUB_MARKER_COPY" "copy"
  assert_absent "$STUB_JOBS_LOG" "a check job"
done

# 10a. A way back's URL version, still database-url's newest enabled one:
# the server reads the restored server, so the run stops before anything is
# copied. The listing is out of order, and a newer disabled version doesn't
# count.
case_start "database-url's newest version is a way back's"
reset_env; export STUB_TAGS="0.1.8" STUB_URL_RESTORED="$DB_SERVER-r20261028"
run "yes"
assert_rc 1 "a way back's URL version stops it"
assert_out "the newest version of database-url in $VAULT is a way back's, naming the restored server $DB_SERVER-r20261028"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"

case_start "a way back's URL version, with a newer one since"
reset_env; export STUB_TAGS="0.1.8" STUB_URL_RESTORED_OLDER="$DB_SERVER-r20260901"
run "yes"
assert_rc 0 "an older way back's version doesn't stop it"

case_start "database-url's versions can't be listed"
reset_env; export STUB_TAGS="0.1.8" STUB_KV_VERSIONS_ERR="ERROR: (Forbidden) acme"
run "yes"
assert_rc 1 "an unreadable listing stops it"
assert_out "couldn't list the versions of database-url in $VAULT. ERROR: (Forbidden) acme"
assert_absent "$STUB_MARKER_COPY" "copy"

# 11. az set to another subscription: refused before the deployment is read.
case_start "az on another subscription"
reset_env; export STUB_TAGS="0.1.8" STUB_SUBSCRIPTION="99999999-0000-0000-0000-000000000000"
run "yes"
assert_rc 1 "another subscription refused"
assert_out "az is set to the subscription 99999999-0000-0000-0000-000000000000, but the deployment is in $SUB. Run 'az account set --subscription $SUB'"
if grep -q "az containerapp show" "$STUB_CALLS_LOG"; then fail "the app was read on another subscription"; else pass; fi
assert_absent "$STUB_MARKER_COPY" "copy"

# 12. A tier that takes on-demand backups: one, named for the upgrade, just
# before the apply and after yes; the restore point after it.
case_start "an on-demand backup on GeneralPurpose"
reset_env; export STUB_TAGS="0.1.10" STUB_PG_TIER="GeneralPurpose"
run "yes"
assert_rc 0 "the run with a backup succeeds"
assert_out "Just before that, it takes an on-demand backup of $DB_SERVER, named for this upgrade."
if grep -qE "^postgres flexible-server backup create -g $RG --server-name $DB_SERVER --name pre-upgrade-0-1-10-to-0-2-0-[0-9]{14} -o none$" "$STUB_BACKUP_LOG"; then pass
else fail "the backup isn't named for the upgrade: $(cat "$STUB_BACKUP_LOG" 2>/dev/null)"; fi
assert_before "$STUB_CALLS_LOG" "az postgres flexible-server backup create" "terraform apply" "the backup comes before the apply"
assert_before "$STUB_CALLS_LOG" "terraform show -json" "az postgres flexible-server backup create" "the backup comes after the plan is checked"
assert_before "$OUT" "taking the on-demand backup pre-upgrade-0-1-10-to-0-2-0-" "restore point: " "the restore point comes after the backup"
assert_out ", and the on-demand backup pre-upgrade-0-1-10-to-0-2-0-"

case_start "an on-demand backup that fails"
reset_env; export STUB_TAGS="0.1.10" STUB_PG_TIER="GeneralPurpose" STUB_BACKUP_ERR="ERROR: (MaxOnDemandBackupsReached) acme"
run "yes"
assert_rc 1 "a failed backup stops it"
assert_out "couldn't take the on-demand backup pre-upgrade-0-1-10-to-0-2-0-"
assert_out "MaxOnDemandBackupsReached"
assert_out "put back"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a plan not applied was kept"; else pass; fi
assert_jobs_deleted "after the backup fails"

# 13. An rc goes to its final.
case_start "rc to its final"
reset_env; export STUB_TAGS="0.2.0-rc.0"
run "yes"
assert_rc 0 "rc -> final runs"
assert_out "0.2.0-rc.0 -> 0.2.0 applied"

# 14. To an rc: its release's steps are included.
case_start "0.1.8 to an rc"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.2.0-rc.0
assert_rc 0 "to an rc runs"
assert_out "crossing: 0.1.9 0.1.10 0.2.0"
assert_out "autoCloseAfterInactiveSeconds"

# 15. An rc promoted to its final carries both tags: the final is the version.
case_start "rc and final tags on one digest"
reset_env; export STUB_TAGS="0.2.0-rc.0;0.2.0"
run "yes"
assert_rc 1 "final read from the two tags"
assert_out "already on 0.2.0,"

# 16. The release's tag isn't the digest given: refused before the copy.
case_start "digest doesn't match the release tag"
reset_env; export STUB_TAGS="0.1.8" STUB_RELEASE_DIGEST="$OLD_DIGEST"
run "yes"
assert_rc 1 "mismatched digest refused"
assert_out "not the --runtime-digest"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"

# 17. The var-file doesn't set server_image on one line: refused at the start.
case_start "var-file without a server_image line"
reset_env; export STUB_TAGS="0.1.8"
printf 'subscription_id = "%s"\n' "$SUB" >"$VAR_FILE"; cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes"
assert_rc 1 "no server_image line refused"
assert_out "must set server_image exactly once"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_varfile_unchanged

# 18. The var-file isn't what's deployed: refused.
case_start "var-file doesn't match the running image"
reset_env; export STUB_TAGS="0.1.8"
STUB_APP_BEFORE="$(app_json "$REPO/runtime@sha256:$(printf '%064d' 9)" kindgi-server--0000001 kindgi-server--0000001)"
run "yes"
assert_rc 1 "drift refused"
assert_out "Make the var-file match"
assert_absent "$STUB_MARKER_COPY" "copy"

# 19. A pack rebuild: the envelope's imageRef + imageDigest become a pinned
# pack_image (the tag dropped, a registry port kept) in the var-file.
case_start "pack rebuilt from the envelope"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.8"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR/.kindgi/build"
PACK_DIGEST="sha256:$(printf '%064d' 3)"
jq -n --arg d "$PACK_DIGEST" '{"$schema":"kindgi-deploy-envelope/v1",
  imageRef:"registry.local:5000/kindgi-images/pack:dev", imageDigest:$d}' \
  >"$PACK_DIR/.kindgi/build/deploy-envelope.json"
run "yes" --pack-dir "$PACK_DIR"
assert_rc 0 "pack rebuild runs"
assert_file_has "$STUB_CALLS_LOG" "kindgi build --local --push --env dev" "the pack is built"
assert_file_has "$VAR_FILE" "pack_image   = \"registry.local:5000/kindgi-images/pack@$PACK_DIGEST\"" "var-file pins the new pack"
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"" "var-file pins the new server"

# 20. A long name_prefix: every check job name fits in 32 characters, the
# prefix cut to 12 and a dash at its end dropped.
case_start "long name_prefix"
reset_env; export STUB_TAGS="0.1.8"; V_PREFIX="kindgi-acme-shared-dev"
run "yes"
assert_rc 0 "long prefix runs"
long=0
for job in $(jobs_made); do
  if [[ ${#job} -gt 32 || $job != kindgi-acme-upgchk-* ]]; then long=1; fi
done
if [[ $long -eq 0 && -s $STUB_JOBS_LOG ]]; then pass; else fail "a check job name is over 32 characters, or not the prefix's: $(jobs_made | tr '\n' ' ')"; fi

# 21. A .tfvars.json var-file is rewritten as JSON.
case_start "tfvars.json"
reset_env; export STUB_TAGS="0.1.8"
VAR_FILE="$CASE_DIR/dev.tfvars.json"
jq -n --arg img "$RUNNING_IMAGE" --arg sub "$SUB" '{subscription_id:$sub, server_image:$img}' >"$VAR_FILE"
ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST")
run "yes" --to 0.2.0
assert_rc 0 "json var-file runs"
if [[ "$(jq -r .server_image "$VAR_FILE")" == "$NEW_IMAGE" ]]; then pass; else fail "json var-file not rewritten"; fi

# 22. Past the newest release this script knows: refused before anything is
# read, copied or run, though 0.1.9 to 0.4.0 lie on the way.
case_start "target past the newest known release"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.5.0
assert_rc 1 "a later target refused"
assert_out "knows the steps up to 0.4.0"
assert_out "as of the @kindgi/sdk@0.5.0 tag"
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_varfile_unchanged

# 23. An rc of a later release counts as that release.
case_start "rc of a later release"
reset_env; export STUB_TAGS="0.1.9"
run "yes" --to 0.5.0-rc.1
assert_rc 1 "a later rc refused"
assert_out "knows the steps up to 0.4.0"
assert_out "as of the @kindgi/sdk@0.5.0 tag or, before that release is out, its newest @kindgi/sdk@0.5.0-rc.N tag."
assert_absent "$STUB_MARKER_COPY" "copy"

# 24. 0.1.10 -> 0.2.0: crosses 0.2.0 alone, copies it from registry.kindgi.com.
case_start "0.1.10 to 0.2.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes"
assert_rc 0 "0.1.10 -> 0.2.0 runs"
assert_out "crossing: 0.2.0$"
assert_out "0.2.0:"
assert_out "now comes from registry.kindgi.com"
assert_out "If public_url is empty, set it to the URL people open the console at"
assert_out "<public_url>/console/connect/callback"
assert_out "A pack built for 0.1.10 keeps working without a rebuild."
assert_out "The plan also changes the pack's container app in place"
if grep -q "autoCloseAfterInactiveSeconds" "$OUT"; then fail "0.1.10's steps shown for 0.1.10 -> 0.2.0"; else pass; fi
assert_out "Not applicable on Container Apps (skipped)"
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0 " "the release tag is read on registry.kindgi.com"
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools create --tag $REPO/runtime:0.2.0 registry.kindgi.com/kindgi/runtime:0.2.0@$NEW_DIGEST" "the copy tags it in the module's registry"
assert_file_has "$OUT" "This copies the runtime through this machine, down from registry.kindgi.com and up to $REPO. It takes both platforms (linux/amd64 and linux/arm64), so your copy keeps the release digest." "what the copy is"
assert_file_has "$OUT" "On a slow uplink it can take most of an hour; it says when it's done." "how long the copy can take"
said="$(grep -o -F -e "Copying runtime 0.2.0 into the module's registry" -e "This copies the runtime" -e "it says when it's done." -e "stub: imagetools create" -e "copied to $NEW_IMAGE" "$OUT" | tr '\n' '|')"
if [[ $said == "Copying runtime 0.2.0 into the module's registry|This copies the runtime|it says when it's done.|stub: imagetools create|copied to $NEW_IMAGE|" ]]; then pass
else fail "the copy's time isn't said between the step line and the copy, in order: $said"; fi
assert_out "0.1.10 -> 0.2.0 applied"

# 25. 0.1.10 -> an rc of 0.2.0: its steps are included, and it gets to the copy.
case_start "0.1.10 to 0.2.0-rc.0"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.2.0-rc.0
assert_rc 0 "0.1.10 -> 0.2.0-rc.0 runs"
assert_out "crossing: 0.2.0$"
assert_present "$STUB_MARKER_COPY" "copy"
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.2.0-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"

# 26. A target before 0.2.0 isn't on registry.kindgi.com: refused at the start.
case_start "target before 0.2.0"
reset_env; export STUB_TAGS="0.1.8"
run "yes" --to 0.1.10
assert_rc 1 "0.1.10 target refused"
assert_out "has 0.2.0 and later. Upgrade to an earlier release by hand, as that release's README says."
assert_absent "$STUB_CALLS_LOG" "a call"
assert_varfile_unchanged

# 27. Not logged in to registry.kindgi.com: the login line, before the copy.
case_start "not logged in to registry.kindgi.com"
reset_env; export STUB_TAGS="0.1.10" STUB_INSPECT_ERR="ERROR: unexpected status from HEAD request: 401 Unauthorized"
run "yes"
assert_rc 1 "no login refused"
assert_out "docker login registry.kindgi.com --username kindgi, with your license key as the password"
assert_out "401 Unauthorized"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_varfile_unchanged

# 28. The module's registry won't log docker in: stops before the copy.
case_start "az acr login fails"
reset_env; export STUB_TAGS="0.1.10" STUB_ACR_LOGIN_ERR="ERROR: (AuthorizationFailed) acme"
run "yes"
assert_rc 1 "no registry login stops it"
assert_out "couldn't log docker in to $REPO (az acr login --expose-token). Nothing was copied or changed. ERROR: (AuthorizationFailed) acme"
# docker login, which ran on the other end of the pipe with no token, isn't
# what the run reports.
assert_file_lacks "$OUT" "non TTY device" "docker's own error for an empty stdin"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_docker_config_unchanged

# 28a. docker won't take az's token: docker's error, before the copy.
case_start "docker login fails"
reset_env; export STUB_TAGS="0.1.10" STUB_DOCKER_LOGIN_ERR="Error response from daemon: Get \"https://$REPO/v2/\": unauthorized"
run "yes"
assert_rc 1 "a refused docker login stops it"
assert_out "couldn't log docker in to $REPO (docker login, with az's token). Nothing was copied or changed. Error response from daemon"
assert_file_lacks "$OUT" "You can perform manual login" "az's warning"
assert_file_lacks "$OUT" "$STUB_ACR_TOKEN" "the token isn't printed"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_docker_config_unchanged

# 29. 0.1.11 never had a final release (its changes ship in 0.2.0): neither it
# nor one of its rcs is a target.
case_start "0.1.11 isn't a target"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.1.11-rc.0
assert_rc 1 "a 0.1.11 target refused"
assert_out "has 0.2.0 and later"
assert_absent "$STUB_CALLS_LOG" "a call"
assert_varfile_unchanged

# 30. A deployment on a 0.1.11 rc upgrades to 0.2.0, crossing 0.2.0 alone.
case_start "0.1.11-rc.0 to 0.2.0"
reset_env; export STUB_TAGS="0.1.11-rc.0"
run "yes"
assert_rc 0 "0.1.11-rc.0 -> 0.2.0 runs"
assert_out "crossing: 0.2.0$"
assert_out "0.1.11-rc.0 -> 0.2.0 applied"

# 31. --backup-bucket is Cloud Run's: here it's an unknown argument.
case_start "--backup-bucket"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --backup-bucket "gs://backups/dev"
assert_rc 1 "--backup-bucket refused"
assert_out "unknown argument \"--backup-bucket\""
assert_absent "$STUB_CALLS_LOG" "a call"

# 32. --help: what the run creates, and how to delete a check job left behind.
case_start "--help"
reset_env
run "" --help
assert_rc 0 "--help exits 0"
assert_file_has "$OUT" "az containerapp job delete -n <name> -g <resource group> --yes" "how to delete a leftover job"
assert_file_has "$OUT" "<name_prefix>-upgchk-<HHMMSS>-pk, -ss and -mhc" "the jobs' names"
assert_out "It doesn't start while database_url_version is set"
assert_absent "$STUB_CALLS_LOG" "a call"

# 33. A dry run: the reads and the read-only checks, every change a real run
# would make with the names it would use, the steps to confirm by hand, and a
# read-only plan for the new image. Nothing is copied, built, backed up or
# applied, and no job is made; the var-file and docker's config are
# untouched; the plan takes no state lock and no state is written.
case_start "dry run"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
run "yes" --pack-dir "$PACK_DIR" --dry-run
assert_rc 0 "a dry run exits 0"
assert_out "DRY RUN. It reads only"
assert_file_has "$STUB_CALLS_LOG" "docker buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0 " "the release digest is read"
assert_file_has "$OUT" "2. log docker in to $REPO (a token from az acr login --expose-token, on docker login's stdin, which docker stores as it does for any login)" "the docker login"
assert_file_has "$OUT" "2. add the image tag $REPO/runtime:0.2.0 to the module's registry" "the copy"
assert_file_has "$OUT" "   (both platforms, through this machine; on a slow uplink it can take most of an hour)" "the copy's time"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-pk  (check provider-keys)" "the provider-keys job"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-ss  (check secret-scopes)" "the secret-scopes job"
assert_file_has "$OUT" "kindgi-upgchk-<HHMMSS>-mhc  (check mcp-header-credentials)" "the mcp-header-credentials job"
assert_file_has "$OUT" "in the environment kindgi-env, as the server's identity, reading database-url from the vault $VAULT" "where the jobs run"
assert_file_has "$OUT" "3. nothing yet: the backup is $DB_SERVER's point-in-time restore (7 days kept, the earliest restore point 2026-01-05T08:12:45.123456+00:00)" "the backup"
assert_file_has "$OUT" "rebuild and push the pack from $PACK_DIR " "the pack build"
assert_file_has "$OUT" "copy $VAR_FILE to $VAR_FILE.pre-upgrade-<YYYYMMDDTHHMMSSZ>" "the var-file copy"
assert_file_has "$OUT" "set server_image = \"$NEW_IMAGE\" in $VAR_FILE" "the new image"
assert_file_has "$OUT" "no on-demand backup: the Burstable tier takes none" "no on-demand backup"
assert_file_has "$OUT" "record the restore point, the UTC time just before the apply" "the restore point"
assert_file_has "$OUT" "pack_image is unchanged in this plan" "the pack image's limit"
assert_file_has "$OUT" "wait for the new revision of kindgi-server" "the wait"
assert_out "key as the password; this script copies it from there."
assert_out "dry run done. Nothing was changed"
if grep -q "Apply this plan" "$OUT"; then fail "a dry run asked for yes"; else pass; fi
assert_file_has "$STUB_CALLS_LOG" "terraform plan -var-file=$VAR_FILE -var server_image=$NEW_IMAGE -lock=false" "the plan is given the new image"
assert_out "plan check: it changes the image(s)"
assert_file_has "$OUT" "apply exactly that plan, kept as $VAR_FILE.upgrade-<YYYYMMDDTHHMMSSZ>.tfplan" "the kept plan's name"
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a dry run left a plan"; else pass; fi
assert_reads_only
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_absent "$STUB_BACKUP_LOG" "a backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged
if ls "$CASE_DIR"/dev.tfvars.pre-upgrade-* >/dev/null 2>&1; then fail "a dry run left a .pre-upgrade copy"; else pass; fi
assert_docker_config_unchanged
if [[ "$(sleeps)" == 0 ]]; then pass; else fail "a dry run waited"; fi

# 33a. A dry run on a tier that takes on-demand backups names the one a real
# run would take.
case_start "dry run, an on-demand backup"
reset_env; export STUB_TAGS="0.1.10" STUB_PG_TIER="GeneralPurpose"
run "yes" --dry-run
assert_rc 0 "a dry run exits 0"
assert_file_has "$OUT" "   take the on-demand backup pre-upgrade-0-1-10-to-0-2-0-<YYYYMMDDHHMMSS> of $DB_SERVER" "the backup's name"
assert_reads_only
assert_absent "$STUB_BACKUP_LOG" "a backup"

# 34. A dry run stops where a real run would: a failed precondition exits 1,
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

case_start "dry run, retention under 7 days"
reset_env; export STUB_TAGS="0.1.10" STUB_PG_RETENTION=1
run "yes" --dry-run
assert_rc 1 "a short retention stops the dry run"
assert_out "upgrade (dry run): a precondition failed"
assert_out "keeps 1 days of backups"
assert_reads_only

# 35. A dry run whose plan fails exits 1, and still changes nothing; without
# --pack-dir the pack stays as it is.
case_start "dry run, the plan fails"
reset_env; export STUB_TAGS="0.1.10" STUB_PLAN_RC=1
run "yes" --dry-run
assert_rc 1 "a failed plan fails the dry run"
assert_out "4. nothing: without --pack-dir the pack image stays as it is"
if grep -q "pack_image is unchanged in this plan" "$OUT"; then fail "a pack note without --pack-dir"; else pass; fi
assert_out "upgrade (dry run): terraform plan failed"
assert_reads_only
assert_varfile_unchanged

# 36. A server-only release, X.Y.Z.N, is a server fix for X.Y.Z with no SDK
# release of its own. From X.Y.Z it crosses no release and has no steps to
# confirm by hand; its image comes from its own tag on registry.kindgi.com.
# The module here is this copy's, so the run says the module goes ahead of
# the runtime, and that this script can't keep it at 0.2.0.
case_start "0.2.0 to a server-only release, 0.2.0.1"
reset_env; export STUB_TAGS="0.2.0"
run "yes" --to 0.2.0.1
assert_rc 0 "0.2.0 -> 0.2.0.1 runs"
assert_out "upgrading 0.2.0 -> 0.2.0.1, a server fix for 0.2.0: no release crossed"
assert_out "none: 0.2.0.1 is a server fix for 0.2.0."
assert_out "0.3.0 (this module's changes only; the runtime goes to 0.2.0.1):"
assert_out "0.3.1 (this module's changes only; the runtime goes to 0.2.0.1):"
assert_out "0.4.0 (this module's changes only; the runtime goes to 0.2.0.1):"
assert_out "the module here is this copy's, as of 0.4.0: the plan also makes its changes for the releases after 0.2.0"
assert_out "To keep the module at 0.2.0, upgrade by hand: this script first came with 0.4.0."
if grep -q "now comes from registry.kindgi.com" "$OUT"; then fail "0.2.0's steps shown for 0.2.0 -> 0.2.0.1"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0.1 " "the server fix's own tag is read"
assert_file_has "$STUB_DOCKER_LOG" "--tag $REPO/runtime:0.2.0.1 registry.kindgi.com/kindgi/runtime:0.2.0.1@$NEW_DIGEST" "the copy tags it 0.2.0.1"
assert_present "$STUB_MARKER_APPLY" "apply"
assert_out "0.2.0 -> 0.2.0.1 applied"

# 37. From before X.Y.Z, a server-only release crosses X.Y.Z: its steps print.
case_start "0.1.10 to 0.2.0.1"
reset_env; export STUB_TAGS="0.1.10"
run "yes" --to 0.2.0.1
assert_rc 0 "0.1.10 -> 0.2.0.1 runs"
assert_out "crossing: 0.2.0$"
assert_out "now comes from registry.kindgi.com"
if grep -q "none: " "$OUT"; then fail "a crossing upgrade said there are no steps"; else pass; fi
assert_out "0.1.10 -> 0.2.0.1 applied"

# 38. From an rc of X.Y.Z, too: the rc is below its final.
case_start "0.2.0-rc.0 to 0.2.0.1"
reset_env; export STUB_TAGS="0.2.0-rc.0"
run "yes" --to 0.2.0.1
assert_rc 0 "0.2.0-rc.0 -> 0.2.0.1 runs"
assert_out "crossing: 0.2.0$"
assert_out "0.2.0-rc.0 -> 0.2.0.1 applied"

# 39. From one server fix to the next: the running X.Y.Z.N is read from its
# copied tag.
case_start "0.2.0.1 to 0.2.0.2"
reset_env; export STUB_TAGS="0.2.0.1"
run "yes" --to 0.2.0.2
assert_rc 0 "0.2.0.1 -> 0.2.0.2 runs"
assert_out "read 0.2.0.1 from the copied image's tag"
assert_out "a server fix for 0.2.0: no release crossed"
assert_out "0.2.0.1 -> 0.2.0.2 applied"

# 40. A later server fix is past an earlier one, and past its release: going
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

# 41. A server fix of a release past the newest this script knows: the refusal
# names its release's SDK tag, since a server-only release has none.
case_start "server fix past the newest known release"
reset_env; export STUB_TAGS="0.2.0"
run "yes" --to 0.5.0.1
assert_rc 1 "a later server fix refused"
assert_out "knows the steps up to 0.4.0. 0.5.0.1 is a server fix for 0.5.0, which comes out after its final: use this script as of the @kindgi/sdk@0.5.0 tag."
if grep -q "@kindgi/sdk@0.5.0.1" "$OUT"; then fail "the refusal names an SDK tag a server-only release doesn't have"; else pass; fi
assert_absent "$STUB_DOCKER_LOG" "a registry read"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_varfile_unchanged

# 42. A server-only release has no rc, and its N starts at 1 with no leading
# zero, as the runtime's releases are numbered: anything else isn't a target.
for bad in 0.2.0.1-rc.0 0.2.0.0 0.2.0.01 0.2.0.1.1; do
  case_start "--to $bad isn't a version"
  reset_env; export STUB_TAGS="0.2.0"
  run "yes" --to "$bad"
  assert_rc 1 "$bad refused"
  assert_out "--to \"$bad\" isn't a version like 0.2.0, 0.2.0-rc.0 or 0.2.0.1"
  assert_absent "$STUB_DOCKER_LOG" "a registry read"
done

# 43. --from takes a server-only release; and with no version tag to read, the
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
assert_out "--from \"0.2.0.1-rc.0\" isn't a version like 0.1.10 or 0.2.0.1"

case_start "no version tag, no --from"
reset_env
run "yes" --to 0.2.0.1
assert_rc 1 "no version refused"
assert_out "Re-run with --from <the version it runs, such as 0.1.10 or 0.2.0.1>"
assert_absent "$STUB_DOCKER_LOG" "a registry read"

# 44. A dry run lists a server-only release like any other target: its own
# tag read and copied, no steps by hand, and nothing changed.
case_start "dry run to a server-only release"
reset_env; export STUB_TAGS="0.2.0"
run "yes" --to 0.2.0.1 --dry-run
assert_rc 0 "a dry run to 0.2.0.1 exits 0"
assert_file_has "$STUB_CALLS_LOG" "docker buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.2.0.1 " "the server fix's digest is read"
assert_file_has "$OUT" "2. add the image tag $REPO/runtime:0.2.0.1 to the module's registry" "the copy"
assert_file_has "$OUT" "(a copy of registry.kindgi.com/kindgi/runtime:0.2.0.1@$NEW_DIGEST;" "the copy's source"
assert_out "none: 0.2.0.1 is a server fix for 0.2.0."
assert_out "dry run done. Nothing was changed"
assert_reads_only
assert_absent "$STUB_MARKER_COPY" "copy"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 45. The same script with releases it doesn't ship yet (0.2.1, and 0.4.0
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

# 46. A real run without --pack-dir leaves the pack image, and its warning
# names no release: the steps to confirm by hand say which release needs a
# rebuild.
case_start "a pack service without --pack-dir"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
run "yes"
assert_rc 0 "0.1.10 -> 0.2.0 runs without --pack-dir"
assert_out "no --pack-dir was given: the pack image is left unchanged"
assert_out "If a release crossed needs the pack rebuilt (its steps to confirm by hand, above, say so)"
if grep -q "If 0.1.10 needs" "$OUT"; then fail "the warning names a release"; else pass; fi
assert_out "0.1.10 -> 0.2.0 applied"

# 47. With no --to, the target is the newest release the script knows, 0.4.0,
# and the module here is that release's: no note that it goes ahead. From
# 0.2.0 it crosses 0.3.0, 0.3.1 and 0.4.0, and all their steps print.
case_start "the default target, 0.4.0"
reset_env; export STUB_TAGS="0.2.0"
ARGS=(--var-file "$VAR_FILE" --runtime-digest "$NEW_DIGEST")
run "yes"
assert_rc 0 "0.2.0 -> 0.4.0 runs"
assert_out "crossing: 0.3.0 0.3.1 0.4.0$"
assert_out "First start runs six additive migrations"
assert_out "If seed_user_id has an upper-case letter, 0.3.0 and later read it in"
assert_out "kindgi-runtime tenants repair --tenant <id in lower case>"
assert_out "run this once, with the new runtime's kindgi-runtime:"
if grep -q "0.3.0's kindgi-runtime" "$OUT"; then fail "a run to 0.4.0 named 0.3.0's runtime"; else pass; fi
assert_out "First start runs no migrations. The steps are the packs'"
assert_out "kindgi guardrails unregister <id>"
assert_out "0.3.1 doesn't change the module."
assert_out "Eighteen new migrations: four new tables (block_version_prs,"
assert_out "keeps judgments locked while it indexes every"
assert_out "grant roles/storage.legacyBucketReader on the bucket,"
assert_out "Right after the upgrade, a project no pin covers runs its Latest"
assert_out "An Improve schedule saved at 0.3.x is read in 0.4.0's shape."
assert_out "Corrections made at 0.3.x go to nobody, so Improve doesn't learn from"
assert_out "An Improve run still going when you upgrade ends, and doesn't carry"
assert_out "Upgrade your clients, the CLI and your own callers with the runtime."
assert_out "Console links saved before 0.4.0 can answer Page not found."
assert_out "A webhook receiver, or code that reads approvals, sees 0.4.0's names."
assert_out "A stdio MCP server that keeps a credential in config.env still works,"
assert_out "change judging=<level> to"
assert_out "0.4.0's plan changes nothing in the module by itself"
if grep -q "the module here is this copy's" "$OUT"; then fail "the newest release's run says the module goes ahead"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "buildx imagetools inspect registry.kindgi.com/kindgi/runtime:0.4.0 " "0.4.0's tag is read"
assert_out "plan check: it changes the image(s)"
assert_out "0.2.0 -> 0.4.0 applied"

# 47b. 0.3.0 -> 0.3.1's candidate: it crosses 0.3.1 alone, an rc counting as
# its release, and the plan changes only the image.
case_start "0.3.0 to 0.3.1-rc.0"
reset_env; export STUB_TAGS="0.3.0"
run "yes" --to 0.3.1-rc.0
assert_rc 0 "0.3.0 -> 0.3.1-rc.0 runs"
assert_out "crossing: 0.3.1$"
assert_out "First start runs no migrations. The steps are the packs'"
assert_out "kindgi guardrails unregister <id>"
if grep -q "six additive migrations" "$OUT"; then fail "0.3.0's steps printed for a run from 0.3.0"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.3.1-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"
assert_out "plan check: it changes the image(s)"
assert_out "0.3.0 -> 0.3.1-rc.0 applied"

# 47c. 0.3.1 -> 0.4.0's candidate: it crosses 0.4.0 alone, whose module
# changes nothing by itself, so the plan changes only the image.
case_start "0.3.1 to 0.4.0-rc.0"
reset_env; export STUB_TAGS="0.3.1"
run "yes" --to 0.4.0-rc.0
assert_rc 0 "0.3.1 -> 0.4.0-rc.0 runs"
assert_out "crossing: 0.4.0$"
assert_out "Eighteen new migrations: four new tables"
assert_out "0.4.0's plan changes nothing in the module by itself"
if grep -q "First start runs no migrations. The steps are the packs'" "$OUT"; then fail "0.3.1's steps printed for a run from 0.3.1"; else pass; fi
if grep -q "the module here is this copy's" "$OUT"; then fail "a run to the newest release's rc says the module goes ahead"; else pass; fi
assert_file_has "$STUB_DOCKER_LOG" "registry.kindgi.com/kindgi/runtime:0.4.0-rc.0@$NEW_DIGEST" "the rc is copied from registry.kindgi.com"
assert_out "plan check: it changes the image(s)"
assert_out "0.3.1 -> 0.4.0-rc.0 applied"

# 48. The license renewal job runs the server's image: its image changes
# with the server's, and passes the check; anything else of it doesn't.
case_start "the license renewal job's image"
reset_env; export STUB_TAGS="0.1.10" STUB_LICENSE_JOB=1
run "yes"
assert_rc 0 "the job's new image passes"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

LICENSE_SCHEDULE="$(jq -cn '[{address: "azurerm_container_app_job.license_renewal[0]", mode: "managed",
  type: "azurerm_container_app_job", name: "license_renewal", index: 0,
  change: {actions: ["update"],
    before: {schedule_trigger_config: [{cron_expression: "17 3 * * *", parallelism: 1}]},
    after: {schedule_trigger_config: [{cron_expression: "17 4 * * *", parallelism: 1}]},
    after_unknown: {}}}]')"
case_start "the license renewal job's schedule"
reset_env; export STUB_TAGS="0.1.10" STUB_LICENSE_JOB=1 STUB_PLAN_CHANGES="$LICENSE_SCHEDULE"
run "yes"
assert_rc 1 "another change to the job stops it"
assert_file_has "$OUT" "    azurerm_container_app_job.license_renewal[0]: changes schedule_trigger_config.cron_expression" "the change, by its path"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 49. A change no release names (the server's SKU, a variable changed by
# hand): the plan check names it and stops before it asks, and nothing is
# backed up or applied.
SERVER_SKU="$(jq -cn '[{address: "azurerm_postgresql_flexible_server.kindgi", mode: "managed",
  type: "azurerm_postgresql_flexible_server", name: "kindgi",
  change: {actions: ["update"],
    before: {name: "kindgi-pg-ab12", sku_name: "B_Standard_B1ms", backup_retention_days: 7},
    after: {name: "kindgi-pg-ab12", sku_name: "GP_Standard_D2ds_v5", backup_retention_days: 7},
    after_unknown: {}}}]')"
case_start "a change no release names"
reset_env; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$SERVER_SKU" STUB_PG_TIER="GeneralPurpose"
run "yes" --to 0.3.0
assert_rc 1 "an unnamed change stops it"
assert_out "PLAN CHECK: the plan changes more than this upgrade does"
assert_file_has "$OUT" "    azurerm_postgresql_flexible_server.kindgi: changes sku_name" "the change, by its path"
if grep -q "_Standard_" "$OUT"; then fail "a value was printed"; else pass; fi
assert_out "the plan check failed (above), so nothing was applied"
if grep -q "Apply this plan" "$OUT"; then fail "it asked for yes after the check stopped it"; else pass; fi
assert_absent "$STUB_BACKUP_LOG" "a backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_jobs_deleted "after the plan check stops it"
assert_varfile_unchanged
if ls "$CASE_DIR"/dev.tfvars.upgrade-*.tfplan >/dev/null 2>&1; then fail "a stopped plan was kept"; else pass; fi

# 50. A replace of the database server stops it, whatever the releases crossed.
case_start "the plan replaces the database server"
reset_env; export STUB_TAGS="0.2.0" STUB_PG_TIER="GeneralPurpose" STUB_PLAN_CHANGES='[{"address":"azurerm_postgresql_flexible_server.kindgi","mode":"managed","type":"azurerm_postgresql_flexible_server","name":"kindgi","change":{"actions":["delete","create"],"before":{"name":"kindgi-pg-ab12"},"after":{"name":"kindgi-pg-ab12"},"after_unknown":{}}}]'
run "yes" --to 0.3.0
assert_rc 1 "a replace stops it"
assert_file_has "$OUT" "    azurerm_postgresql_flexible_server.kindgi: replaced: deleted and created again" "the replace named"
assert_absent "$STUB_BACKUP_LOG" "a backup"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 51. A pack env left off the command: the plan drops the pack's env vars, and
# the check names each one it drops, never a value. A var it keeps, moved in
# the list, isn't named.
PACK_ENV_DROPPED="$(jq -cn --arg img "$OLD_PACK" '
  {name: "KINDGI_PACK_SERVICE_TOKEN", value: null, secret_name: "pack-service-token"} as $token
  | [{address: "azurerm_container_app.pack", mode: "managed", type: "azurerm_container_app", name: "pack",
     change: {actions: ["update"],
       before: {template: [{container: [{name: "pack", image: $img, env: [
         {name: "SHOP_URL", value: "https://shop.acme.example", secret_name: null},
         $token,
         {name: "SHOP_API_KEY", value: null, secret_name: "acme-shop-key"}]}]}]},
       after: {template: [{container: [{name: "pack", image: $img, env: [$token]}]}]},
       after_unknown: {}}}]')"
case_start "the plan drops the pack's env"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_ENV_DROPPED"
run "yes"
assert_rc 1 "a plan that drops the pack's env stops"
assert_file_has "$OUT" "    azurerm_container_app.pack: changes template.container.env.SHOP_URL" "SHOP_URL named"
assert_file_has "$OUT" "    azurerm_container_app.pack: changes template.container.env.SHOP_API_KEY" "SHOP_API_KEY named"
if [[ "$(grep -c "env.SHOP_URL" "$OUT")" == 1 ]]; then pass; else fail "SHOP_URL should be named once"; fi
if grep -q "KINDGI_PACK_SERVICE_TOKEN" "$OUT"; then fail "a var the plan keeps was named"; else pass; fi
if grep -q -e "shop.acme.example" -e "acme-shop-key" "$OUT"; then fail "a value was printed"; else pass; fi
assert_out "give each file the deployment uses its own --var-file"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 52. The same in a dry run: it says a real run would stop there.
case_start "dry run, the plan drops the pack's env"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_ENV_DROPPED"
run "yes" --dry-run
assert_rc 1 "a dry run whose plan drops the pack's env fails"
assert_file_has "$OUT" "    azurerm_container_app.pack: changes template.container.env.SHOP_URL" "SHOP_URL named"
assert_out "upgrade (dry run): a real run would stop at this plan (above). Nothing was changed."
assert_reads_only
assert_absent "$STUB_JOBS_LOG" "a check job"
assert_varfile_unchanged

# 53. The pack's env in a file of its own, given with a second --var-file:
# terraform reads both, in order, the run lists both and says which one the
# image goes in, only that one changes, and the way back plans with both.
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
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$PACK_ENV_FILE -out=back.tfplan)" "$OUT"; then pass; else fail "the way back doesn't plan with both var files"; fi
assert_file_has "$VAR_FILE" "server_image = \"$NEW_IMAGE\"" "the image went into the file that sets it"
if cmp -s "$PACK_ENV_FILE" "$CASE_DIR/original-pack-env.json"; then pass; else fail "the pack env's file changed"; fi

# 54. Two var files that set server_image: refused before anything is read.
case_start "two var files set server_image"
reset_env; export STUB_TAGS="0.1.10"
OTHER="$CASE_DIR/other.tfvars"; printf 'server_image = "%s"\n' "$RUNNING_IMAGE" >"$OTHER"
run "yes" --var-file "$OTHER"
assert_rc 1 "two server_image files refused"
assert_file_has "$OUT" "both $VAR_FILE and $OTHER set server_image." "both named"
assert_absent "$STUB_CALLS_LOG" "a call"
assert_varfile_unchanged

# 55. A pack rebuild writes pack_image beside server_image: a second file that
# sets it too is refused before anything is copied.
case_start "a second var file sets pack_image, with a pack rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
OTHER="$CASE_DIR/pack.tfvars"; printf 'pack_image = "%s"\n' "$OLD_PACK" >"$OTHER"
run "yes" --var-file "$OTHER" --pack-dir "$PACK_DIR"
assert_rc 1 "a second pack_image refused"
assert_file_has "$OUT" "$OTHER sets pack_image too" "the second file named"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_varfile_unchanged

# 56. What Terraform loads on its own is listed: terraform.tfvars, an
# .auto.tfvars.json beside it, and TF_VAR_ names, never their values.
case_start "what Terraform loads on its own"
reset_env; export STUB_TAGS="0.1.10"
printf 'location = "canadacentral"\n' >"$CASE_DIR/terraform.tfvars"
printf '{}\n' >"$CASE_DIR/dev.pack-env.auto.tfvars.json"
export TF_VAR_pack_secret_env='{"SHOP_API_KEY":{"secret":"acme-shop-key","version":"latest"}}'
run "yes" --dry-run
unset TF_VAR_pack_secret_env
assert_rc 0 "a dry run exits 0"
assert_out "also loaded    terraform.tfvars (Terraform loads it from this directory on its own)"
assert_out "also loaded    dev.pack-env.auto.tfvars.json (Terraform loads it"
assert_out "also set       TF_VAR_pack_secret_env (in the environment)"
if grep -q "acme-shop-key" "$OUT"; then fail "a TF_VAR_ value was printed"; else pass; fi

# 57. 0.2.0's own in-place change to the pack (its startup probe) passes the
# check when the run crosses 0.2.0, and stops it when it doesn't.
PACK_020="$(jq -cn --arg img "$OLD_PACK" '
  def pack($i; $t; $f):
    {template: [{container: [{name: "pack", image: $img,
      startup_probe: [{interval_seconds: $i, timeout: $t, failure_count_threshold: $f, transport: "HTTP", path: "/readyz", port: 8080}]}]}]};
  [{address: "azurerm_container_app.pack", mode: "managed", type: "azurerm_container_app", name: "pack",
    change: {actions: ["update"], before: pack(5; 3; 24), after: pack(2; 1; 60), after_unknown: {}}}]')"
case_start "0.2.0's in-place change to the pack, crossing 0.2.0"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_020"
run "yes"
assert_rc 0 "0.2.0's pack change passes"
assert_out "plan check: it changes the image(s)"
assert_present "$STUB_MARKER_APPLY" "apply"

case_start "0.2.0's in-place change to the pack, on a server fix"
reset_env "$OLD_PACK"; export STUB_TAGS="0.2.0" STUB_PLAN_CHANGES="$PACK_020"
run "yes" --to 0.2.0.1
assert_rc 1 "the same change stops a server fix"
assert_file_has "$OUT" "    azurerm_container_app.pack: changes template.container.startup_probe.interval_seconds" "the interval named"
assert_file_has "$OUT" "    azurerm_container_app.pack: changes template.container.startup_probe.failure_count_threshold" "the threshold named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 58. A value known only after the apply counts as a change.
case_start "a value known only after the apply"
reset_env; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES='[{"address":"azurerm_user_assigned_identity.server","mode":"managed","type":"azurerm_user_assigned_identity","name":"server","change":{"actions":["update"],"before":{"name":"kindgi-server"},"after":{"name":"kindgi-server"},"after_unknown":{"principal_id":true}}}]'
run "yes"
assert_rc 1 "an unknown value stops it"
assert_file_has "$OUT" "    azurerm_user_assigned_identity.server: changes principal_id" "the unknown named"
assert_absent "$STUB_MARKER_APPLY" "apply"

# 59. A plan that leaves the server on its image (a value set after the
# var-file, say) stops it.
case_start "the plan keeps the server's image"
reset_env; export STUB_TAGS="0.1.10" STUB_PLAN_KEEP_IMAGE=1
run "yes"
assert_rc 1 "a plan without the new image stops it"
assert_file_has "$OUT" "PLAN CHECK: the plan doesn't point the server at $NEW_IMAGE (it has $RUNNING_IMAGE)." "the image named"
assert_absent "$STUB_MARKER_APPLY" "apply"
assert_varfile_unchanged

# 60. A file Terraform loads on its own that sets server_image, beside the
# var-file: a later apply without that --var-file would put its image back,
# so it stops before anything is copied.
case_start "an auto-loaded file sets server_image"
reset_env; export STUB_TAGS="0.1.10"
printf 'server_image = "%s"\n' "$RUNNING_IMAGE" >"$CASE_DIR/terraform.tfvars"
run "yes"
assert_rc 1 "an auto-loaded server_image stops it"
assert_out "terraform.tfvars sets server_image, and Terraform loads it from this directory on its own"
assert_absent "$STUB_MARKER_COPY" "copy"
assert_varfile_unchanged

# 61. The same for pack_image, with a pack rebuild; without one, the pack's
# image isn't written, so the file may set it.
case_start "an auto-loaded file sets pack_image, with a pack rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
printf '{"pack_image": "%s"}\n' "$OLD_PACK" >"$CASE_DIR/dev.pack.auto.tfvars.json"
run "yes" --pack-dir "$PACK_DIR"
assert_rc 1 "an auto-loaded pack_image stops a rebuild"
assert_out "dev.pack.auto.tfvars.json sets pack_image, and Terraform loads it from this directory on its own"
assert_absent "$STUB_MARKER_COPY" "copy"

case_start "an auto-loaded file sets pack_image, no rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
printf '{"pack_image": "%s"}\n' "$OLD_PACK" >"$CASE_DIR/dev.pack.auto.tfvars.json"
run "yes"
assert_rc 0 "without a rebuild it runs"
assert_out "also loaded    dev.pack.auto.tfvars.json"

# 62. An env var known only after the apply is named by its name, as a
# changed one is, never by the attribute that's unknown.
PACK_ENV_UNKNOWN="$(jq -cn --arg img "$OLD_PACK" '
  [{address: "azurerm_container_app.pack", mode: "managed", type: "azurerm_container_app", name: "pack",
    change: {actions: ["update"],
      before: {template: [{container: [{name: "pack", image: $img, env: [{name: "KINDGI_ENV", value: "dev"}, {name: "SHOP_URL", value: null}]}]}]},
      after: {template: [{container: [{name: "pack", image: $img, env: [{name: "KINDGI_ENV", value: "dev"}, {name: "SHOP_URL", value: null}]}]}]},
      after_unknown: {template: [{container: [{env: [{}, {value: true}]}]}]}}}]')"
case_start "an env var known only after the apply"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10" STUB_PLAN_CHANGES="$PACK_ENV_UNKNOWN"
run "yes"
assert_rc 1 "an unknown env value stops it"
assert_file_has "$OUT" "    azurerm_container_app.pack: changes template.container.env.SHOP_URL" "the env var named"
if grep -q "env.value" "$OUT"; then fail "the unknown attribute stood for the name"; else pass; fi

# 63. A var file whose path has a space: the way back's command quotes it, so
# it pastes as one argument.
case_start "a var file whose path has a space"
reset_env; export STUB_TAGS="0.1.10" STUB_APPLY_RC=1
SPACED="$CASE_DIR/pack env.tfvars.json"; printf '{}\n' >"$SPACED"
run "yes" --var-file "$SPACED"
assert_rc 1 "the apply fails"
if grep -qxF "      (umask 077 && terraform plan -var-file=$VAR_FILE -var-file=$CASE_DIR/pack\\ env.tfvars.json -out=back.tfplan)" "$OUT"; then pass
else fail "the way back doesn't quote the path: $(grep -F "terraform plan -var-file" "$OUT")"; fi

# 64. The image set in the environment: a later apply reads TF_VAR_ too, so
# it stops before anything is copied, as for an auto-loaded file. pack_image
# only with a rebuild.
case_start "TF_VAR_server_image set"
reset_env; export STUB_TAGS="0.1.10"
export TF_VAR_server_image="$RUNNING_IMAGE"
run "yes"
unset TF_VAR_server_image
assert_rc 1 "TF_VAR_server_image stops it"
assert_out "TF_VAR_server_image is set in the environment: a later apply without -var-file=$VAR_FILE would put its image back."
assert_absent "$STUB_MARKER_COPY" "copy"
assert_varfile_unchanged

case_start "TF_VAR_pack_image set, with a pack rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
PACK_DIR="$CASE_DIR/pack"; mkdir -p "$PACK_DIR"
export TF_VAR_pack_image="$OLD_PACK"
run "yes" --pack-dir "$PACK_DIR"
unset TF_VAR_pack_image
assert_rc 1 "TF_VAR_pack_image stops a rebuild"
assert_out "TF_VAR_pack_image is set in the environment"
assert_absent "$STUB_MARKER_COPY" "copy"

case_start "TF_VAR_pack_image set, no rebuild"
reset_env "$OLD_PACK"; export STUB_TAGS="0.1.10"
export TF_VAR_pack_image="$OLD_PACK"
run "yes"
unset TF_VAR_pack_image
assert_rc 0 "without a rebuild it runs"
assert_out "also set       TF_VAR_pack_image (in the environment)"

# 65. Each variable the script reads with terraform console is one the module
# declares: the real console refuses an undeclared one, and the stub doesn't.
case_start "VARS_EXPR reads only variables the module declares"
expr="$(sed -n "s/^VARS_EXPR='\(.*\)'\$/\1/p" "$HERE/../upgrade.sh")"
names="$(grep -oE 'var\.[a-z_][a-z0-9_]*' <<<"$expr" | sed 's/^var\.//' | sort -u)"
if grep -qx "subscription_id" <<<"$names" && grep -qx "resource_group_name" <<<"$names"; then pass; else fail "VARS_EXPR wasn't read: $expr"; fi
for n in $names; do
  if grep -qE "^variable \"$n\" " "$HERE"/../*.tf; then pass; else fail "VARS_EXPR reads var.$n, which the module doesn't declare"; fi
done

# 66. Real terraform console prints a warning on stdout, ahead of the value,
# for each variable a var file sets that the module doesn't declare. The value
# is console's last line, so the run goes on.
case_start "a var file that sets a variable the module doesn't declare"
reset_env; export STUB_TAGS="0.1.10"
printf 'acme_note    = "kept from an older copy"\n' >>"$VAR_FILE"
cp "$VAR_FILE" "$CASE_DIR/original.tfvars"
run "yes"
assert_rc 0 "it runs"
assert_file_has "$STUB_WARNED" "console acme_note" "console warned"
if grep -q "^console server_image" "$STUB_WARNED"; then fail "console warned for a declared variable"; else pass; fi
assert_out "crossing: 0.2.0$"

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
