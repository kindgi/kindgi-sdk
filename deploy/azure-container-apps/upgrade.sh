#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Upgrade a Kindgi deployment of this module to a newer runtime, in order:
# check, back up, upgrade. It never changes the running deployment before you
# type "yes" at the plan, and it never rolls back by itself — if the new
# revision doesn't come up it prints the commands to go back and stops. With
# --dry-run it changes nothing: it lists, in order, what a real run would
# change.
#
# Scope: both network shapes, a new VNet or yours. The runtime's checks run
# as Container Apps jobs in the module's own environment, which sits in the
# VNet, so they reach the private database the way the server does, as the
# server's identity, with the database URL from Key Vault.
#
# The backup: the database server's own point-in-time restore. Before any
# change it checks that the server keeps at least 7 days of backups and has
# a restore point in the past, and just before the apply it records the
# restore point, the UTC time the way back restores to. On a server tier
# that takes on-demand backups (all but Burstable), it takes one too, right
# before that.
#
# The variables: it lists the files Terraform reads them from, each --var-file
# and the ones Terraform loads on its own from this directory
# (terraform.tfvars, *.auto.tfvars and their .json forms), and passes every
# --var-file to each terraform command that reads them (console and plan).
#
# The plan: before it asks for "yes", it checks the plan itself (terraform
# show -json). It stops if the plan creates, deletes or replaces anything, or
# changes anything but the new image(s) and the in-place changes that the
# releases after the current one name in their steps to confirm by hand; it
# says what each one is. The plan is of the module in this directory, as of
# the newest release this copy knows, so with a --to below that release it
# also has the module's changes up to it, which it lists and allows. So a var
# file left off the command, whose variables the plan would empty (a pack's
# env in pack_env and pack_secret_env, say), stops it before anything is
# applied. "yes" applies exactly the plan shown.
#
# Run it from this module directory, after `terraform init`, as the identity
# that deploys the module, with az signed in to the deployment's subscription
# (it reads the running server and the module's state, runs the check jobs,
# copies the new image, and plans/applies the module).
#
# Log in to registry.kindgi.com first, where the runtime image comes from:
#   docker login registry.kindgi.com --username kindgi
# and paste your license key when it asks for the password.
#
# What it changes besides the deployment itself:
#   - It logs docker in to the module's registry (a token from
#     az acr login --expose-token, on docker login's stdin) and adds the
#     image tag <registry>/runtime:<version> there.
#   - It creates a Container Apps job for each check,
#     <name_prefix>-upgchk-<HHMMSS>-pk, -ss and -mhc, runs it once, and
#     deletes it when it ends, however it ends. It prints each job's name
#     when it creates it: a run that's killed outright (kill -9, a closed
#     laptop) can't delete them, so delete a leftover one by that name:
#       az containerapp job delete -n <name> -g <resource group> --yes
#   - On a server tier that takes them, it takes an on-demand backup,
#     pre-upgrade-<from>-to-<to>-<UTC time> (a server keeps up to seven).
#   - It rewrites the server_image line (and pack_image, with --pack-dir) in the
#     var-file that sets server_image, so a later plain apply keeps the new
#     image. The previous file is kept next to it as
#     <var-file>.pre-upgrade-<UTC time>; if you don't confirm the plan, the
#     var-file is put back.
#   - It keeps the plan it applies next to that copy, as
#     <var-file>.upgrade-<UTC time>.tfplan: `terraform show <file>` reads what
#     was applied. A plan file holds what the var files and the state hold, so
#     only you can read it; delete it once you no longer need it. A plan you
#     don't confirm, or one the check stops, isn't kept: applied later, it
#     would leave the var-file behind the deployment.
#
# It doesn't start while database_url_version is set: the way back sets it,
# to serve from a restored server that isn't in Terraform's state, and this
# script checks and restores the module's own server.
#
# Usage:
#   ./upgrade.sh --var-file dev.tfvars [--var-file <another var file> ...] \
#                --runtime-digest sha256:<64 hex> \
#                [--to 0.4.0] [--from <version>] \
#                [--pack-dir <path to the pack project>] \
#                [--check-tenant <uuid>] [--dry-run]
#
#   --var-file         A tfvars file the deployment uses (.tfvars or
#                      .tfvars.json). Give one --var-file per file, in the
#                      order you give them to terraform: each is passed to
#                      `terraform console` and `terraform plan`, and to the
#                      plan it prints for going back. A file Terraform doesn't
#                      load on its own (a pack's env in dev.pack-env.tfvars.json,
#                      say, not named *.auto.tfvars.json) needs its own
#                      --var-file.
#                      Exactly one of them sets server_image, on one line:
#                      that's the one rewritten, and pack_image goes on a line
#                      of the same file to rebuild the pack. No file
#                      Terraform loads on its own, and no TF_VAR_ in the
#                      environment, may set the image it writes, or a later
#                      apply without that --var-file would put it back.
#   --runtime-digest   The release digest of the runtime being upgraded to,
#                      from its release notes (sha256:…). Checked against the
#                      release's tag, then copied into the module's registry
#                      by its whole index.
#   --to               The target runtime version, 0.2.0 or later (default
#                      0.4.0). An rc such as 0.4.0-rc.0 works too, and so does
#                      a server-only release such as 0.2.0.1: a server fix for
#                      0.2.0, with no SDK release of its own. Earlier
#                      releases aren't on registry.kindgi.com: upgrade to
#                      those by hand, as that release's README says. This
#                      script knows the steps up to 0.4.0; for a later
#                      release, use this script as of that release's
#                      @kindgi/sdk@<version> tag (for X.Y.Z.N, X.Y.Z's tag)
#                      or, before that release is out, its newest
#                      @kindgi/sdk@<version>-rc.N tag.
#                      Below 0.4.0, the plan still makes this module's
#                      changes up to 0.4.0, with the older runtime. This
#                      script first came with 0.4.0, so to keep the module at
#                      an earlier release, upgrade by hand.
#   --from             Assert the current version (0.1.10, say, or 0.2.0.1)
#                      when it can't be read from the deployment (no version
#                      tag on the running image).
#   --pack-dir         Rebuild and push the pack from here with `kindgi build`.
#                      Without it, the runtime is upgraded alone and the pack
#                      is left as is.
#   --check-tenant     Limit the runtime's read-only checks to one tenant (its
#                      id, a uuid).
#   --dry-run          Change nothing. Run the reads and the read-only checks,
#                      list every change a real run would make, in order, with
#                      the names it would use, and show the Terraform plan for
#                      the new image, checked as a real run checks its plan
#                      (read-only: the var-file untouched, the plan taken with
#                      no state lock, and its file only in a temporary folder,
#                      removed when it ends). It writes nothing, but reading
#                      the variables through `terraform console` briefly takes
#                      the state lock (on the azurerm backend, a lease on the
#                      state's blob), so a dry run stops, without harm, while
#                      an apply holds it. The runtime's own checks run as jobs
#                      in your subscription, so only a real run runs them.

set -euo pipefail

# az writes each request's body to a log file when its file logging is on,
# and a body can carry a secret. Keep it off for every call.
export AZURE_LOGGING_ENABLE_LOG_FILE=no

# Anything this script writes to disk (the plan, the resolved config) may name
# servers, identities and secrets — keep it to this user.
umask 077

# >>> same in both modules: releases
readonly RUNTIME_REPO="registry.kindgi.com/kindgi/runtime"
readonly VERSION_FLOOR="0.1.8"         # upgrades from before this are refused
readonly TARGET_FLOOR="0.2.0"          # the first release on registry.kindgi.com
# Releases this script knows the upgrade steps for, oldest first.
readonly KNOWN_RELEASES=("0.1.9" "0.1.10" "0.2.0" "0.3.0" "0.3.1" "0.4.0")
# The newest of them.
readonly DEFAULT_TARGET="${KNOWN_RELEASES[${#KNOWN_RELEASES[@]}-1]}"

# How long to wait for the new revision to become ready (step 6).
readonly POLL_INTERVAL=10
readonly POLL_TRIES=60
# <<<
# The first release with this script. A run to an earlier one plans this
# copy's module, and no earlier tag has a script to keep the module there.
readonly FIRST_RELEASE="0.4.0"

# How long a check job's run may take: the job's replica timeout, plus the
# start (an image pulled, a replica placed). The run stops at the sum.
readonly JOB_REPLICA_TIMEOUT=600
readonly JOB_START_MARGIN=120
readonly JOB_POLL_INTERVAL=10

# The Container Apps REST version the check jobs are made with, and the way
# back stops and starts the server with: the first GA one that documents an
# app's runningStatus.
readonly ACA_API_VERSION="2025-01-01"

# The way back is a point-in-time restore: the server must keep at least
# this many days of backups (Azure's own minimum).
readonly MIN_RETENTION_DAYS=7

# --- small helpers ----------------------------------------------------------

# >>> same in both modules: small-helpers
ME="upgrade"  # "upgrade (dry run)" with --dry-run
die() { printf '%s: %s\n' "$ME" "$*" >&2; exit 1; }
warn() { printf '%s: %s\n' "$ME" "$*" >&2; }
step() { printf '\n== %s ==\n' "$*"; }
info() { printf '  %s\n' "$*"; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "this needs \"$c\" on your PATH."
  done
}
# <<<

# >>> same in both modules: version-helpers
# A version as a plain base-10 integer for comparison: an rc ranks below its
# final, and a server-only release X.Y.Z.N above it, in order of N:
# 0.2.0-rc.1 -> 200000001, 0.2.0 -> 200050000, 0.2.0.1 -> 200050001. Each of
# X, Y and Z is below 1000, an rc's number and N below 50000. 10# keeps a
# zero-padded component from being read as octal.
ver_num() {
  local v="${1%%-*}" tail=50000 a b c n
  if [[ $1 =~ -rc\.([0-9]+)$ ]]; then tail=$((10#${BASH_REMATCH[1]})); fi
  local IFS=.
  read -r a b c n <<<"$v"
  if [[ -n ${n:-} ]]; then tail=$((50000 + 10#$n)); fi
  printf '%d' "$(( ((10#${a:-0}) * 1000000 + (10#${b:-0}) * 1000 + (10#${c:-0})) * 100000 + tail ))"
}

# A version: X.Y.Z, an rc of it (X.Y.Z-rc.N), or a server-only release
# X.Y.Z.N (N from 1), a server fix for X.Y.Z with no SDK release of its own.
# A server-only release has no rc.
is_version() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+|\.[1-9][0-9]*)?$ ]]; }
is_server_fix() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[1-9][0-9]*$ ]]; }
# The release a version belongs to, whose @kindgi/sdk@ tag has the upgrade.sh
# for it: X.Y.Z for X.Y.Z, X.Y.Z-rc.N and X.Y.Z.N.
release_of() { [[ $1 =~ ^([0-9]+\.[0-9]+\.[0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"; }
# The tags whose upgrade.sh is a release's own ($1, X.Y.Z), as the docs name
# them: an rc's tag stands for the release until it's out.
sdk_tag() { printf 'the @kindgi/sdk@%s tag or, before that release is out, its newest @kindgi/sdk@%s-rc.N tag' "$1" "$1"; }
# The release line a version belongs to, X.Y: the CLI of a final is
# @kindgi/cli@X.Y, as the CLI names itself (publishedCliSpec, in
# packages/cli/src/package-manager.ts).
line_of() { [[ $1 =~ ^([0-9]+\.[0-9]+)\. ]] && printf '%s' "${BASH_REMATCH[1]}"; }
# <<<

# >>> same in both modules: varfile-helpers
# The var-file's value for one variable, or nothing unless the file sets it
# exactly once, on one line, as  name = "value"  (or as a string in .json).
varfile_value() {
  local name="$1" lines
  if [[ $VARFILE_JSON == true ]]; then
    jq -r --arg n "$name" 'if (.[$n] | type) == "string" then .[$n] else empty end' "$VAR_FILE"
    return 0
  fi
  lines="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$VAR_FILE" || true)"
  if [[ -z $lines || $lines == *$'\n'* ]]; then return 0; fi
  sed -nE "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*\"([^\"]*)\"[[:space:]]*((#|\/\/).*)?$/\1/p" <<<"$lines"
}

# A value varfile_set will write: an image reference, nothing that could
# break out of the line.
varfile_value_ok() {
  [[ $2 =~ ^[A-Za-z0-9./:@_-]+$ ]] || die "refusing to write an unexpected $1 value \"$2\"."
}

# Rewrite one variable's value in the var-file in place (its mode is kept),
# then read it back.
varfile_set() {
  local name="$1" value="$2" tmp="$WORK/varfile.new"
  varfile_value_ok "$name" "$value"
  if [[ $VARFILE_JSON == true ]]; then
    jq --arg n "$name" --arg v "$value" '.[$n] = $v' "$VAR_FILE" >"$tmp"
  else
    sed -E "s|^([[:space:]]*${name}[[:space:]]*=[[:space:]]*)\"[^\"]*\"|\1\"${value}\"|" "$VAR_FILE" >"$tmp"
  fi
  cat "$tmp" >"$VAR_FILE"
  [[ "$(varfile_value "$name")" == "$value" ]] \
    || die "couldn't write $name into $VAR_FILE."
}

# Whether a var file sets a variable at all, in any form.
varfile_sets() {
  local file="$1" name="$2"
  case "$file" in
    *.json) jq -e --arg n "$name" 'type == "object" and has($n)' "$file" >/dev/null 2>&1 ;;
    *) grep -q -E "^[[:space:]]*${name}[[:space:]]*=" "$file" ;;
  esac
}

# Every --var-file, as terraform takes them, for a command printed to run.
var_file_flags() {
  local f
  for f in "${VAR_FILES[@]}"; do printf ' -var-file=%q' "$f"; done
}
# <<<

# The go-back path, printed (never run) when the apply fails or the new revision
# doesn't come up. It reads variables set by the time it's called (steps 5/6).
# Migrations only go forward, so going back restores the database server to
# the restore point, into a NEW server, and pins the URL the server reads to
# it — never points an old runtime at the migrated one.
print_go_back() {
  local restored="${DB_SERVER}-r$(date -u +%Y%m%d)"
  local ledger="erasures-$(date -u +%F).json"
  # The server's app, as az rest takes it: az adds the cloud's Resource
  # Manager endpoint.
  local app="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${SERVER_APP}"
  # Both CLI commands talk to the release the run started from: the export to
  # the server serving now, the replay to the old image put back (step 5 below).
  local cli="@kindgi/cli@$(line_of "$CURRENT")" rc_note=""
  # A range never matches a pre-release, so on an rc, @kindgi/cli@X.Y finds no
  # version until X.Y.Z is out. The rc's own number doesn't name the CLI: the
  # runtime and the SDK number their rcs separately. Only a deployment that was
  # never moved to its final reads as an rc here.
  if [[ $CURRENT == *-rc.* ]]; then
    rc_note=$'\n'"    This deployment runs a pre-release, ${CURRENT}. Until $(release_of "$CURRENT") is out,"
    rc_note+=$'\n'"    npx finds no ${cli}: in this step and in step 6, name the"
    rc_note+=$'\n'"    CLI's own pre-release instead, as @kindgi/cli@$(release_of "$CURRENT")-rc.N"
    rc_note+=$'\n'"    (npm view @kindgi/cli versions lists them)."
  fi
  cat <<EOT >&2

======================================================================
The upgrade did not come up. NOTHING has been rolled back automatically.
Migrations only go forward, so do not point an old runtime at the
migrated database — restore the database server to the restore point,
into a NEW server, instead.

To go back:

 1. First, export the erasure ledger from the server serving now. It holds
    every erasure so far, including any made after the restore point. With
    the CLI signed in to ${SERVER_URL}:
      npx --yes ${cli} memory erasures export --out=${ledger}${rc_note}
    If no server answers, the restored database's own ledger is all there
    is: an erasure made after ${RESTORE_POINT} can't be replayed.

 2. Then stop the server's app, ${SERVER_APP}, before anything else
    changes. A stopped app runs no replica. When a secret gets a new
    version (step 4), Container Apps restarts the active revisions that
    read it: the new version, left running, would start on the restored
    server and migrate it too. az has no command to stop an app; Container
    Apps' REST API stops it:
      az rest --method post --url "${app}/stop?api-version=${ACA_API_VERSION}"
    Go on only once this prints Stopped (it can take a few minutes):
      az rest --method get --url "${app}?api-version=${ACA_API_VERSION}" --query properties.runningStatus -o tsv
    Nothing serves from here until step 5.

 3. Restore the database server to the restore point, as a new server in
    the module's database subnet and private DNS zone:
      az postgres flexible-server restore -g ${RG} --name ${restored} \\
        --source-server ${DB_SERVER} --restore-time ${RESTORE_POINT} \\
        --subnet ${DATABASE_SUBNET_ID} \\
        --private-dns-zone ${DATABASE_DNS_ZONE_ID}

 4. A restored server gets none of its source's server parameters: allow
    pgvector on it, as the module does on its own server. Then give it a
    fresh admin password and add a new version of database-url that names
    it, as README step 3 does, in a shell with az's log file off:
      export AZURE_LOGGING_ENABLE_LOG_FILE=no
      az postgres flexible-server parameter set -g ${RG} --server-name ${restored} \\
        --name azure.extensions --value VECTOR
      DBPW=\$(openssl rand -hex 24)
      printf '%s' "\$DBPW" | az postgres flexible-server update -g ${RG} -n ${restored} --admin-password @- -o none
      printf 'postgres://kindgiadmin:%s@%s:5432/${DATABASE_NAME}?sslmode=require' "\$DBPW" \\
        "\$(az postgres flexible-server show -g ${RG} -n ${restored} --query "fullyQualifiedDomainName || properties.fullyQualifiedDomainName" -o tsv)" \\
        | az keyvault secret set --vault-name ${KEY_VAULT} -n database-url --file /dev/stdin \\
          --tags kindgi-restored-server=${restored} --query id -o tsv
      unset DBPW
    It prints the new version's id; its last segment is the version. The
    tag marks the version as a way back's (step 7).

 5. Put the old image(s) back, with the server reading the URL at exactly
    that version: copy the var-file back, set database_url_version in it to
    the version step 4 printed (database_url_version = "<version>", or that
    key in a .tfvars.json), then save the plan and read it:
      cp $(printf '%q' "$VARFILE_BACKUP") $(printf '%q' "$VAR_FILE")
      (umask 077 && terraform plan$(var_file_flags) -out=back.tfplan)
    It changes the images (the server's, the pack's if this run rebuilt it,
    and the license renewal job's, if it has one) and the server's
    database-url reference, which now names that version, and nothing else.
    The plan holds your variables' values, secret ones too: umask 077 keeps
    it readable by you alone. Then apply it, and delete it:
      terraform apply back.tfplan
      rm back.tfplan
    The apply makes a new revision with the old image, which reads the
    database URL at that version, the restored server's, whatever Key
    Vault's refresh has picked up. Before you start the app, check that this
    lists that revision alone, with the old image, ${RUNNING_IMAGE}:
      az containerapp revision list -n ${SERVER_APP} -g ${RG} --query "[].[name, properties.template.containers[0].image]" -o tsv
    A revision with the new image, still listed, would start on the restored
    server too: deactivate it first, with
      az containerapp revision deactivate -n ${SERVER_APP} -g ${RG} --revision <its name>
    Then start the app, and go on once the second command prints Running:
      az rest --method post --url "${app}/start?api-version=${ACA_API_VERSION}"
      az rest --method get --url "${app}?api-version=${ACA_API_VERSION}" --query properties.runningStatus -o tsv
    Then check that the new revision serves: this prints its name twice, as
    the latest revision and the latest ready one:
      az containerapp show -n ${SERVER_APP} -g ${RG} --query "[properties.latestRevisionName, properties.latestReadyRevisionName]" -o tsv

 6. Before anyone uses it, replay the erasures:
      npx --yes ${cli} memory erasures replay ${ledger}
    Then run the old image's "check stored-secrets" (secrets are stored in
    Postgres here): a job like the pre-upgrade checks, but with the
    server's secrets settings (KINDGI_SECRETS_BACKEND,
    KINDGI_SECRETS_BACKEND_KMS, KINDGI_SECRETS_AZURE_KEY_ID,
    KINDGI_AZURE_CLIENT_ID and the AAD key) as well as the database URL.

 7. The restored server, ${restored}, isn't in Terraform's state. The
    module's own server, ${DB_SERVER}, is still the migrated one, and a
    later apply leaves ${restored} as it is. This script checks and
    restores ${DB_SERVER}, so it refuses to start while
    database_url_version is set, or while the version step 4 tagged is
    database-url's newest.
======================================================================
EOT
}

# The names a run gives what it creates, so a dry run lists the ones a real
# run uses. A Container Apps job's name is at most 32 characters: the prefix
# (12 at most, as the module takes it) and 18 more. $2 is the run's HHMMSS.
# >>> same in both modules: checks
readonly CHECKS=("provider-keys" "secret-scopes" "mcp-header-credentials")
# <<<
check_job_name() {
  local prefix="${NAME_PREFIX:0:12}" suffix
  while [[ $prefix == *- ]]; do prefix="${prefix%-}"; done
  case "$1" in
    provider-keys) suffix="pk" ;;
    secret-scopes) suffix="ss" ;;
    mcp-header-credentials) suffix="mhc" ;;
  esac
  printf '%s-upgchk-%s-%s' "$prefix" "$2" "$suffix"
}
# The var-file's backup copy. $1 is the run's UTC stamp.
# >>> same in both modules: kept-files
varfile_backup_name() { printf '%s.pre-upgrade-%s' "$VAR_FILE" "$1"; }
# The plan a run applies, kept next to the var-file's copy.
plan_kept_name() { printf '%s.upgrade-%s.tfplan' "$VAR_FILE" "$1"; }
# <<<
# An on-demand backup's name, in letters, digits and dashes. $1 is the
# time it's taken, YYYYMMDDHHMMSS in UTC.
backup_name() {
  local name="pre-upgrade-${CURRENT}-to-${TARGET}-$1"
  printf '%s' "${name//./-}"
}
# The command that reads a check job's run from Log Analytics, where the
# environment sends its console logs. It works after the job is deleted.
job_logs_command() {
  printf '%s' "az monitor log-analytics query -w $WORKSPACE_ID --analytics-query \"ContainerAppConsoleLogs_CL | where ContainerJobName_s == '$1' and ContainerGroupName_s startswith '$2' | order by _timestamp_d asc\" --query \"[].Log_s\" -o tsv"
}

# --- arguments --------------------------------------------------------------

VAR_FILES=()
RUNTIME_DIGEST=""
TARGET="$DEFAULT_TARGET"
FROM_OVERRIDE=""
PACK_DIR=""
CHECK_TENANT=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) VAR_FILES+=("${2:-}"); shift 2 ;;
    --runtime-digest) RUNTIME_DIGEST="${2:-}"; shift 2 ;;
    --to) TARGET="${2:-}"; shift 2 ;;
    --from) FROM_OVERRIDE="${2:-}"; shift 2 ;;
    --pack-dir) PACK_DIR="${2:-}"; shift 2 ;;
    --check-tenant) CHECK_TENANT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; ME="upgrade (dry run)"; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown argument \"$1\" (see --help)." ;;
  esac
done

# >>> same in both modules: required-arguments
[[ ${#VAR_FILES[@]} -gt 0 ]] || die "--var-file is required (see --help)."
for f in "${VAR_FILES[@]}"; do
  [[ -n $f && -f $f ]] || die "--var-file \"$f\" doesn't exist."
done
[[ -n $RUNTIME_DIGEST ]] || die "--runtime-digest is required (see --help)."
[[ $RUNTIME_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "--runtime-digest must look like sha256:<64 hex>."
# <<<
is_version "$TARGET" || die "--to \"$TARGET\" isn't a version like 0.2.0, 0.2.0-rc.0 or 0.2.0.1."
TARGET_RELEASE="$(release_of "$TARGET")"
[[ "$(ver_num "$TARGET_RELEASE")" -ge "$(ver_num "$TARGET_FLOOR")" ]] \
  || die "--to $TARGET: this script copies the runtime from registry.kindgi.com, which has $TARGET_FLOOR and later. Upgrade to an earlier release by hand, as that release's README says."
# >>> same in both modules: target-release
# A later release may need steps this copy doesn't have, so it isn't run past
# the newest release it knows (an rc counts as its final). A server-only
# release has no SDK tag of its own: its release's script runs it.
NEWEST_KNOWN="${KNOWN_RELEASES[${#KNOWN_RELEASES[@]}-1]}"
if [[ "$(ver_num "$TARGET_RELEASE")" -gt "$(ver_num "$NEWEST_KNOWN")" ]]; then
  if is_server_fix "$TARGET"; then
    die "--to $TARGET: this script knows the steps up to $NEWEST_KNOWN. $TARGET is a server fix for $TARGET_RELEASE, which comes out after its final: use this script as of the @kindgi/sdk@$TARGET_RELEASE tag."
  fi
  die "--to $TARGET: this script knows the steps up to $NEWEST_KNOWN. Use this script as of $(sdk_tag "$TARGET_RELEASE")."
fi
if is_server_fix "$TARGET" && [[ " ${KNOWN_RELEASES[*]} " != *" $TARGET_RELEASE "* ]]; then
  die "--to $TARGET: a server fix for $TARGET_RELEASE, which isn't a release this script knows (${KNOWN_RELEASES[*]})."
fi
if [[ -n $FROM_OVERRIDE ]]; then is_version "$FROM_OVERRIDE" || die "--from \"$FROM_OVERRIDE\" isn't a version like 0.1.10 or 0.2.0.1."; fi
if [[ -n $PACK_DIR ]]; then [[ -d $PACK_DIR ]] || die "--pack-dir \"$PACK_DIR\" isn't a directory."; fi
# <<<
# The tenant goes to the check job as an argument of its own: a uuid only.
if [[ -n $CHECK_TENANT ]]; then
  [[ $CHECK_TENANT =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || die "--check-tenant \"$CHECK_TENANT\" isn't a tenant id (a uuid)."
fi

require_cmd terraform az jq docker

# >>> same in both modules: var-file
# The var-file this run writes the new image(s) into: the one that sets
# server_image. Terraform takes a later file's value over an earlier one's,
# so a second file that sets it would plan an image this run didn't write.
VAR_FILE=""
for f in "${VAR_FILES[@]}"; do
  if varfile_sets "$f" server_image; then
    [[ -z $VAR_FILE || $f == "$VAR_FILE" ]] \
      || die "both $VAR_FILE and $f set server_image. Keep it in one --var-file: the one this script writes the new image into."
    VAR_FILE="$f"
  fi
done
[[ -n $VAR_FILE ]] \
  || die "no --var-file sets server_image. One of them must set server_image exactly once, on one line (server_image = \"<image>\"): the one this script writes the new image into."
VARFILE_JSON=false
case "$VAR_FILE" in *.json) VARFILE_JSON=true ;; esac
TF_VAR_FILE_ARGS=()
for f in "${VAR_FILES[@]}"; do TF_VAR_FILE_ARGS+=("-var-file=$f"); done
# <<<

WORK="$(mktemp -d)"
CHECK_JOBS=()          # the check jobs, by name, deleted on exit
VARFILE_BACKUP=""      # the var-file as it was, once step 5 rewrites it
VARFILE_PENDING=false  # rewritten, but the apply hasn't started: put it back
cleanup() {
  local code=$? job
  # A job is listed before its create starts, so one whose create was cut
  # short is deleted too; one that was never made isn't there to delete.
  if [[ ${#CHECK_JOBS[@]} -gt 0 ]]; then
    for job in "${CHECK_JOBS[@]}"; do
      if ! az containerapp job delete -n "$job" -g "$RG" --yes >/dev/null 2>&1 \
          && az containerapp job show -n "$job" -g "$RG" >/dev/null 2>&1; then
        warn "couldn't delete the check job $job. Delete it with: az containerapp job delete -n $job -g $RG --yes"
      fi
    done
  fi
  if [[ $VARFILE_PENDING == true && -f $VARFILE_BACKUP ]]; then
    cat "$VARFILE_BACKUP" >"$VAR_FILE"
    warn "nothing was applied, so $VAR_FILE is put back as it was."
  fi
  if [[ -n ${WORK:-} && -d $WORK ]]; then rm -rf "$WORK"; fi
  exit "$code"
}
trap cleanup EXIT

# --- resolve the deployment's configuration ---------------------------------
# Outputs come from `terraform output`; variables (including their defaults)
# and the ids of what the module made come from `terraform console`. console
# takes the state lock while it runs and has no -lock flag, so while an apply
# holds the lock this read fails, without harm. It writes nothing.

if [[ $DRY_RUN == true ]]; then
  printf '%s\n' "upgrade: DRY RUN. It reads only: nothing is copied, built, backed up, written or applied, and no job is run."
fi

step "Reading the deployment"

TF_OUT="$WORK/outputs.json"
terraform output -json >"$TF_OUT" 2>"$WORK/output.err" \
  || die "couldn't read terraform outputs — run this from the module directory, after 'terraform init'. $(cat "$WORK/output.err")"

# The registry's login server: the module's images are <registry>/<name>.
IMAGE_REPOSITORY="$(jq -r '.image_registry.value // empty' "$TF_OUT")"
SERVER_URL="$(jq -r '.server_url.value // empty' "$TF_OUT")"
DB_SERVER="$(jq -r '.database_server_name.value // empty' "$TF_OUT")"
KEY_VAULT="$(jq -r '.key_vault_name.value // empty' "$TF_OUT")"
[[ -n $IMAGE_REPOSITORY && -n $DB_SERVER && -n $KEY_VAULT ]] \
  || die "the module's outputs are incomplete — has the deployment been applied?"

# One terraform console call returns the variables, and the ids the az
# calls need, as a JSON object. console renders jsonencode()'s string with
# HCL quoting, so `jq fromjson` unwraps it. Its warnings, such as one for
# each variable a var file sets that the module doesn't declare, come on
# stdout ahead of the value, so the value is its last line.
VARS_EXPR='jsonencode({subscription_id=var.subscription_id, resource_group_name=var.resource_group_name, name_prefix=var.name_prefix, database_name=var.database_name, database_url_version=var.database_url_version, server_image=var.server_image, pack_image=var.pack_image, vault_uri=azurerm_key_vault.kindgi.vault_uri, server_identity=azurerm_user_assigned_identity.server.id, environment_id=azurerm_container_app_environment.kindgi.id, workspace_id=azurerm_log_analytics_workspace.kindgi.workspace_id, database_subnet_id=local.database_subnet_id, database_dns_zone_id=local.database_dns_zone_id})'
VARS_RAW="$(terraform console "${TF_VAR_FILE_ARGS[@]}" <<<"$VARS_EXPR" 2>"$WORK/console.err")" \
  || die "couldn't read the module's variables with 'terraform console'. $(cat "$WORK/console.err")"
VARS="$(jq 'fromjson' <<<"${VARS_RAW##*$'\n'}")" \
  || die "couldn't parse the module's variables from terraform console."

SUBSCRIPTION="$(jq -r '.subscription_id' <<<"$VARS")"
RG="$(jq -r '.resource_group_name' <<<"$VARS")"
NAME_PREFIX="$(jq -r '.name_prefix' <<<"$VARS")"
DATABASE_NAME="$(jq -r '.database_name' <<<"$VARS")"
DATABASE_URL_VERSION="$(jq -r '.database_url_version // ""' <<<"$VARS")"
OLD_SERVER_IMAGE="$(jq -r '.server_image' <<<"$VARS")"
OLD_PACK_IMAGE="$(jq -r '.pack_image // ""' <<<"$VARS")"
VAULT_URI="$(jq -r '.vault_uri // ""' <<<"$VARS")"
SERVER_IDENTITY="$(jq -r '.server_identity // ""' <<<"$VARS")"
ENVIRONMENT_ID="$(jq -r '.environment_id // ""' <<<"$VARS")"
WORKSPACE_ID="$(jq -r '.workspace_id // ""' <<<"$VARS")"
DATABASE_SUBNET_ID="$(jq -r '.database_subnet_id // ""' <<<"$VARS")"
DATABASE_DNS_ZONE_ID="$(jq -r '.database_dns_zone_id // ""' <<<"$VARS")"
[[ -n $VAULT_URI && -n $SERVER_IDENTITY && -n $ENVIRONMENT_ID && -n $WORKSPACE_ID && -n $DATABASE_SUBNET_ID && -n $DATABASE_DNS_ZONE_ID ]] \
  || die "the module's state is incomplete (the vault, the server's identity, the environment, the log workspace or the database's network) — has the deployment been applied?"

# A pinned database URL is a way back's: the server reads a restored server
# that isn't in Terraform's state, and this script checks and restores the
# module's own. Refused before anything is read from Azure.
if [[ -n $DATABASE_URL_VERSION ]]; then
  die "database_url_version is set: the server reads the database URL at that version, which a way back points at a restored server outside Terraform's state. This script checks and restores the module's own server, $DB_SERVER, so it doesn't run while it's set (README \"Upgrading\"). Nothing was changed."
fi

SERVER_APP="${NAME_PREFIX}-server"
ENVIRONMENT="${NAME_PREFIX}-env"
# The URL secret, without a version, as the server reads it (data.tf).
DB_URL_SECRET_URI="${VAULT_URI%/}/secrets/database-url"
# pack_image has no default: the module always runs a pack service.
HAS_PACK=true
REBUILD_PACK=false
if [[ -n $PACK_DIR ]]; then REBUILD_PACK=true; fi

# >>> same in both modules: var-file-checks
# Step 5 rewrites the image line(s) in the var-file, so a later plain apply
# can't put the old image back on the migrated database. Refuse now, before
# any work, if the file doesn't hold each one exactly once as terraform reads it.
if [[ "$(varfile_value server_image)" != "$OLD_SERVER_IMAGE" ]]; then
  die "$VAR_FILE must set server_image exactly once, on one line (server_image = \"<image>\"), as the value terraform uses. Fix the file and run again."
fi
if [[ $REBUILD_PACK == true && "$(varfile_value pack_image)" != "$OLD_PACK_IMAGE" ]]; then
  die "$VAR_FILE must set pack_image exactly once, on one line (pack_image = \"<image>\"), to rebuild the pack. Fix the file and run again."
fi
if [[ $REBUILD_PACK == true ]]; then
  for f in "${VAR_FILES[@]}"; do
    if [[ $f != "$VAR_FILE" ]] && varfile_sets "$f" pack_image; then
      die "$f sets pack_image too: the rebuilt pack's image goes in $VAR_FILE, beside server_image, and only there. Fix the files and run again."
    fi
  done
fi

for f in "${VAR_FILES[@]}"; do
  if [[ $f == "$VAR_FILE" ]]; then
    info "var file        $f (the new image goes in here)"
  else
    info "var file        $f"
  fi
done
# What Terraform reads on its own, before the -var-file files (which win):
# from this directory, and from TF_VAR_<name> in the environment.
for f in terraform.tfvars terraform.tfvars.json *.auto.tfvars *.auto.tfvars.json; do
  if [[ -f $f ]]; then info "also loaded    $f (Terraform loads it from this directory on its own)"; fi
done
# One of them that sets the image this run writes, other than the var-file it
# writes it into, would put the old image back at a later apply without that
# --var-file.
for f in terraform.tfvars terraform.tfvars.json *.auto.tfvars *.auto.tfvars.json; do
  [[ -f $f && ! $f -ef $VAR_FILE ]] || continue
  if varfile_sets "$f" server_image; then
    die "$f sets server_image, and Terraform loads it from this directory on its own: a later apply without -var-file=$VAR_FILE would put its image back. Keep server_image in $VAR_FILE only, then run again. Nothing was changed."
  fi
  if [[ $REBUILD_PACK == true ]] && varfile_sets "$f" pack_image; then
    die "$f sets pack_image, and Terraform loads it from this directory on its own: a later apply without -var-file=$VAR_FILE would put its image back. Keep pack_image in $VAR_FILE only, then run again. Nothing was changed."
  fi
done
# The same for one set in the environment, which a later apply reads too.
if [[ -n ${TF_VAR_server_image+set} ]]; then
  die "TF_VAR_server_image is set in the environment: a later apply without -var-file=$VAR_FILE would put its image back. Unset it and keep server_image in $VAR_FILE only, then run again. Nothing was changed."
fi
if [[ $REBUILD_PACK == true && -n ${TF_VAR_pack_image+set} ]]; then
  die "TF_VAR_pack_image is set in the environment: a later apply without -var-file=$VAR_FILE would put its image back. Unset it and keep pack_image in $VAR_FILE only, then run again. Nothing was changed."
fi
for v in $(compgen -e | grep '^TF_VAR_' || true); do
  info "also set       $v (in the environment)"
done
# <<<
info "subscription    $SUBSCRIPTION"
info "resource group  $RG"
info "server app      $SERVER_APP"
info "environment     $ENVIRONMENT"
info "database        $DATABASE_NAME on server $DB_SERVER"
info "registry        $IMAGE_REPOSITORY"

# az acts on the subscription it's set to, which may not be the deployment's.
account_json="$(az account show -o json 2>"$WORK/account.err")" \
  || die "couldn't read az's subscription — sign in with 'az login'. $(cat "$WORK/account.err")"
AZ_SUBSCRIPTION="$(jq -r '.id // empty' <<<"$account_json")"
[[ $AZ_SUBSCRIPTION == "$SUBSCRIPTION" ]] \
  || die "az is set to the subscription ${AZ_SUBSCRIPTION:-(none)}, but the deployment is in $SUBSCRIPTION. Run 'az account set --subscription $SUBSCRIPTION', then run this again. Nothing was changed."

# --- step 1: the current version --------------------------------------------

step "1. Current runtime version"

# `containerapp show` returns the app as Azure Resource Manager does: the
# image and the revision names are under properties.
app_json="$(az containerapp show -n "$SERVER_APP" -g "$RG" -o json 2>"$WORK/describe.err")" \
  || die "couldn't read the server app \"$SERVER_APP\". $(cat "$WORK/describe.err")"
RUNNING_IMAGE="$(jq -r '.properties.template.containers[0].image // empty' <<<"$app_json")"
# The revision serving now: step 6 waits for a newer one.
OLD_REVISION="$(jq -r '.properties.latestRevisionName // empty' <<<"$app_json")"
# The check jobs go where the server runs, in its environment's region.
LOCATION="$(jq -r '.location // empty' <<<"$app_json")"
[[ -n $RUNNING_IMAGE ]] || die "the server app \"$SERVER_APP\" has no image — is it deployed?"
[[ -n $LOCATION ]] || die "the server app \"$SERVER_APP\" has no location — is it deployed?"
[[ $RUNNING_IMAGE == "$OLD_SERVER_IMAGE" ]] \
  || die "the server runs $RUNNING_IMAGE, but $VAR_FILE has server_image = \"$OLD_SERVER_IMAGE\". Make the var-file match what's deployed, then run again."

CURRENT=""
if [[ -n $FROM_OVERRIDE ]]; then
  CURRENT="$FROM_OVERRIDE"
  info "using --from $CURRENT"
else
  # The running image is digest-pinned and carries no tag. The version tag is on
  # the same digest in the registry (README step 2 copies with --tag).
  repo_no_digest="${RUNNING_IMAGE%@*}"
  running_digest="${RUNNING_IMAGE##*@}"
  repo_host="${repo_no_digest%%/*}"
  tags="$(az acr manifest list-metadata -r "${repo_host%%.*}" -n "${repo_no_digest#*/}" -o json 2>/dev/null \
    | jq -r --arg d "$running_digest" '.[]? | select(.digest == $d) | .tags[]? // empty' 2>/dev/null || true)"
  # One tag a line; an empty result iterates zero times under set -u on
  # bash 3.2. An rc promoted to its final carries both tags; the highest is
  # the version.
  for tag in $tags; do
    if is_version "$tag"; then
      if [[ -z $CURRENT || "$(ver_num "$tag")" -gt "$(ver_num "$CURRENT")" ]]; then CURRENT="$tag"; fi
    fi
  done
  if [[ -n $CURRENT ]]; then
    info "read $CURRENT from the copied image's tag"
  else
    die "couldn't read the version from the running image (no version tag on its digest). Re-run with --from <the version it runs, such as 0.1.10 or 0.2.0.1>."
  fi
fi

# >>> same in both modules: versions-crossed
if [[ "$(ver_num "$CURRENT")" -lt "$(ver_num "$VERSION_FLOOR")" ]]; then
  die "the deployment is on $CURRENT; this script upgrades from $VERSION_FLOOR or later. Upgrade to $VERSION_FLOOR first."
fi
if [[ "$(ver_num "$CURRENT")" -ge "$(ver_num "$TARGET")" ]]; then
  die "the deployment is already on $CURRENT, at or past the target $TARGET. Nothing to do."
fi

# The releases this upgrade crosses (current < r <= the target's release, so
# an rc target gets its release's steps), from what we know. From X.Y.Z, or
# an earlier X.Y.Z.N, to a server-only release X.Y.Z.N it crosses none: a
# server fix has no steps of its own.
CROSSED=()
for r in "${KNOWN_RELEASES[@]}"; do
  if [[ "$(ver_num "$r")" -gt "$(ver_num "$CURRENT")" && "$(ver_num "$r")" -le "$(ver_num "$TARGET_RELEASE")" ]]; then
    CROSSED+=("$r")
  fi
done
if [[ ${#CROSSED[@]} -gt 0 ]]; then
  info "upgrading $CURRENT -> $TARGET, crossing: ${CROSSED[*]}"
elif is_server_fix "$TARGET" && [[ "$(ver_num "$CURRENT")" -ge "$(ver_num "$TARGET_RELEASE")" ]]; then
  info "upgrading $CURRENT -> $TARGET, a server fix for $TARGET_RELEASE: no release crossed"
else
  die "no known upgrade steps between $CURRENT and $TARGET; this script knows ${KNOWN_RELEASES[*]}."
fi
# The plan is of the module in this directory, this copy's, as of the newest
# release it knows. So it makes that module's changes for every release after
# the current one up to that one, past the target's release too.
MODULE_CROSSED=()
for r in "${KNOWN_RELEASES[@]}"; do
  if [[ "$(ver_num "$r")" -gt "$(ver_num "$CURRENT")" ]]; then MODULE_CROSSED+=("$r"); fi
done
# <<<
if [[ "$(ver_num "$TARGET_RELEASE")" -lt "$(ver_num "$NEWEST_KNOWN")" ]]; then
  keep="use this script as of $(sdk_tag "$TARGET_RELEASE")"
  if [[ "$(ver_num "$TARGET_RELEASE")" -lt "$(ver_num "$FIRST_RELEASE")" ]]; then
    keep="upgrade by hand: this script first came with $FIRST_RELEASE"
  fi
  warn "the module here is this copy's, as of $NEWEST_KNOWN: the plan also makes its changes for the releases after $TARGET_RELEASE (its steps to confirm by hand list them), with the $TARGET runtime. To keep the module at $TARGET_RELEASE, $keep."
fi

NEW_SERVER_IMAGE="${IMAGE_REPOSITORY}/runtime@${RUNTIME_DIGEST}"
NEW_PACK_IMAGE="$OLD_PACK_IMAGE"

# --- step 2: checks ---------------------------------------------------------
# Everything here is read-only against the deployment. Copying the new image
# (below) only adds to the registry, and the check jobs only read; neither
# changes anything that serves. The first change to the running deployment
# is the apply in step 5.

step "2. Pre-upgrade checks"

# >>> same in both modules: fail-check
CHECK_FAILED=false
fail_check() { CHECK_FAILED=true; warn "CHECK FAILED: $*"; }
# <<<

# 2a. Preconditions, cheapest first.
# The database server: Ready, and its point-in-time restore covering now,
# since the way back restores it to the time just before the apply. az
# prints a server's properties at the top level; the Resource Manager shape
# has them under properties, so both are read.
pg_json="$(az postgres flexible-server show -g "$RG" -n "$DB_SERVER" -o json 2>"$WORK/pg.err" || true)"
pg_state="$(jq -r '(.state // .properties.state) // empty' <<<"${pg_json:-null}" 2>/dev/null || true)"
RETENTION_DAYS="$(jq -r '(.backup // .properties.backup // {}).backupRetentionDays // empty' <<<"${pg_json:-null}" 2>/dev/null || true)"
EARLIEST_RESTORE="$(jq -r '(.backup // .properties.backup // {}).earliestRestoreDate // empty' <<<"${pg_json:-null}" 2>/dev/null || true)"
DB_TIER="$(jq -r '.sku.tier // empty' <<<"${pg_json:-null}" 2>/dev/null || true)"
if [[ -z $pg_state ]]; then
  fail_check "couldn't read the database server $DB_SERVER. $(cat "$WORK/pg.err")"
else
  if [[ $pg_state != "Ready" ]]; then
    fail_check "the database server $DB_SERVER is \"$pg_state\", not Ready."
  fi
  if ! [[ $RETENTION_DAYS =~ ^[0-9]+$ ]] || ((RETENTION_DAYS < MIN_RETENTION_DAYS)); then
    fail_check "the database server $DB_SERVER keeps ${RETENTION_DAYS:-no} days of backups: going back restores it to a point in time, which needs at least $MIN_RETENTION_DAYS (database_backup_retention_days)."
  fi
  # ISO 8601, in UTC, with fractions of a second, which jq's reader doesn't
  # take: they're dropped. Any other form fails the check.
  if ! jq -en --arg t "$EARLIEST_RESTORE" '$t | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601 < now' >/dev/null 2>&1; then
    fail_check "the database server $DB_SERVER has no restore point in the past (its earliest restore date is \"${EARLIEST_RESTORE:-unreadable}\"), so it couldn't be restored to now."
  fi
fi

# The URL secret the server and the check jobs read, by reference: it must
# exist. The vault's listing names its secrets and holds no value.
if ! az keyvault secret list --vault-name "$KEY_VAULT" -o json 2>"$WORK/kv.err" \
    | jq -e 'any(.[]?; (.id // "" | split("/") | last) == "database-url" and .attributes.enabled == true)' >/dev/null 2>&1; then
  fail_check "the vault $KEY_VAULT has no enabled secret database-url, which the server and the check jobs read (README, step 3). $(cat "$WORK/kv.err")"
# The URL's newest enabled version is the one the server reads without a
# version. A way back tags the version it adds with the restored server's
# name (its step 4): while that one is the newest, the server reads the
# restored server, even with database_url_version cleared. The versions'
# listing holds their tags and no value.
elif ! url_versions="$(az keyvault secret list-versions --vault-name "$KEY_VAULT" -n database-url -o json 2>"$WORK/kvv.err")"; then
  fail_check "couldn't list the versions of database-url in $KEY_VAULT. $(cat "$WORK/kvv.err")"
else
  if ! url_restored="$(jq -r '[.[]? | select(.attributes.enabled == true)] | sort_by(.attributes.created) | last | .tags["kindgi-restored-server"] // empty' <<<"$url_versions" 2>/dev/null)"; then
    fail_check "couldn't read the versions of database-url in $KEY_VAULT that az listed."
  elif [[ -n $url_restored ]]; then
    fail_check "the newest version of database-url in $KEY_VAULT is a way back's, naming the restored server $url_restored (its kindgi-restored-server tag), so the server reads that server, though database_url_version isn't set. This script checks and restores the module's own server, $DB_SERVER, so it doesn't run while the server reads a restored one."
  fi
fi

# The release's own tag must be the digest given, or the copy below would put
# the version tag (which a later run's step 1 reads) on the wrong image.
release_digest="$(docker buildx imagetools inspect "${RUNTIME_REPO}:${TARGET}" --format '{{json .Manifest}}' 2>"$WORK/inspect.err" | jq -r '.digest // empty' 2>/dev/null || true)"
if [[ -z $release_digest ]]; then
  fail_check "couldn't read ${RUNTIME_REPO}:${TARGET}. Are you logged in? docker login registry.kindgi.com --username kindgi, with your license key as the password. $(cat "$WORK/inspect.err")"
elif [[ $release_digest != "$RUNTIME_DIGEST" ]]; then
  fail_check "${RUNTIME_REPO}:${TARGET} is $release_digest, not the --runtime-digest $RUNTIME_DIGEST. Check the pair against the release notes."
fi

# Stop on a failed precondition before spending anything: no image is copied
# and no check job runs if one fails.
if [[ $CHECK_FAILED == true ]]; then
  die "a precondition failed (above). Nothing was copied, backed up or changed. Fix it and run again."
fi

# Microsoft: the Burstable tier takes no on-demand backup. Any other takes
# one, and a server keeps up to seven.
ON_DEMAND_BACKUP=true
if [[ $DB_TIER == "Burstable" ]]; then ON_DEMAND_BACKUP=false; fi

# >>> same in both modules: release-steps
# A release's steps to confirm by hand, for the runtime it brings.
release_steps() {
  case "$1" in
    0.1.9)
      cat <<'EOT'
   - A tool id registered with both an active draft and an active published
     version: unregister one kind first.
   - If your CLI reaches the server by a different name, re-authenticate:
       kindgi auth login --url <name> --token <key>
   - An MCP endpoint id containing a "." must be re-registered under "-" or "_".
     List them:  GET /v1/mcp/endpoints
   - First start rewrites fga_tuple_outbox (about 6s per million rows). On a
     large table, pick a quiet time:  SELECT count(*) FROM fga_tuple_outbox;
   - A start can stop on a held lock: a migration waits 5s at a time, 6 times,
     then the new revision fails, naming the table and the session holding it
     (end it with pg_terminate_backend, or let it finish). The old revision
     keeps serving meanwhile.
EOT
      ;;
    0.1.10)
      cat <<'EOT'
   - If any agent sets conversationPolicy.autoCloseAfterInactiveSeconds, remove
     it before you rebuild the pack. In the pack source:
       grep -rn "autoCloseAfterInactiveSeconds" src/
   - Before re-registering a tool or MCP endpoint, drop "secretScopes" from any
     definition you read back from the server.
EOT
      ;;
    0.2.0)
      cat <<'EOT'
   - The runtime image now comes from registry.kindgi.com, with your license
     key as the password; this script copies it from there.
   - If public_url is empty, set it to the URL people open the console at:
     once it's set, console sessions are accepted from that origin only. A
     paused tool call's link is made from it; without it, the link is made
     from the address the server is bound to, which another system can't
     reach, and the server logs that at the first pause. Connections stay
     off until it's set, and the server logs what else they need as it
     starts. Each app's sign-in sends people back to
       <public_url>/console/connect/callback
   - First start runs five additive migrations (new tables, new columns that
     can be empty, nothing rewritten) in seconds. Three of them take a short
     lock on kernel_runs, kernel_triggers, hitl_approvals or judgments: a
     long transaction holding one makes the new revision fail after about a
     minute, naming the session that holds it (end it with
     pg_terminate_backend, or let it finish). The old revision keeps serving
     meanwhile.
   - With openfga_api_url empty (no authorization store), check who changes
     the tenant's settings (model providers, policies, adapters, trusted
     signing keys, sign-in providers): a script or a person that isn't a
     tenant admin now gets 403 permission-denied when it changes them, and
     on any call to the outgoing webhook endpoints or the compliance
     evidence. Without a store, a tenant admin is the deployment's API
     token, an admin key, or a console signed in with either; a person
     signed in with an emailed link or an identity provider isn't one.
   - A pack built for 0.1.10 keeps working without a rebuild. To use 0.2.0's
     features in it (a tool that pauses, a connection, data blocks), move its
     pins to 0.2.0 first: its next build takes what they say. A Python pack made
     by a 0.1 CLI pins kindgi>=0.1,<0.2 and kindgi-cli>=0.1,<0.2:
       uv add "kindgi==0.2.0" && uv add --dev "kindgi-cli==0.2.0"
EOT
      ;;
    0.3.0)
      cat <<'EOT'
   - First start runs six additive migrations (new tables, new columns that
     are empty or have a fixed default, nothing rewritten). Five of them take
     a short lock on the tables they change or point to: kernel_runs (three
     of them do), kernel_journal, kernel_waitpoints, kernel_triggers,
     kernel_trigger_fires, orgs and projects. One of them (trigger versions)
     keeps kernel_runs, kernel_triggers and kernel_trigger_fires locked while
     it reads every trigger fire, to check two new references and index
     them. Meanwhile runs, triggers and their fires wait, on the old revision
     too, so with many fires (SELECT count(*) FROM kernel_trigger_fires;)
     upgrade at a quiet time.
     A long transaction holding one of those tables makes the new revision
     fail after about a minute, naming the session that holds it (end it
     with pg_terminate_backend, or let it finish). The old revision keeps
     serving meanwhile. After them, the server indexes the flow records
     without holding back writes to them.
   - If seed_user_id has an upper-case letter, 0.3.0 and later read it in
     lower case and make a new seed user with that id. The old one keeps its
     grants and the keys minted for it, but it's no longer the seed user.
     Mint keys for the new one, then revoke the old one's keys and, with
     openfga_api_url set, take away its tenant admin.
   - If seed_tenant_id has an upper-case letter, 0.3.0 and later read it in
     lower case, and at start the server logs a warning naming the steps
     left, with your id filled in. Until they're done, keep seed_tenant_id
     as it is, and register a new identity provider only once the new
     runtime serves all the traffic. With KINDGI_ARTIFACTS in server_env,
     first move the stored files from tenants/<id as set> to
     tenants/<id in lower case>. In a gcs: bucket:
       gcloud storage rsync --recursive \
         gs://<bucket>/tenants/<id as set> \
         gs://<bucket>/tenants/<id in lower case>
       gcloud storage rm --recursive --all-versions \
         gs://<bucket>/tenants/<id as set>
     With openfga_api_url set, once the new runtime serves all the traffic,
     run this once, with the new runtime's kindgi-runtime:
       kindgi-runtime tenants repair --tenant <id in lower case> \
         --old-spelling <id as set>
     Then set seed_tenant_id in lower case, and apply.
EOT
      ;;
    0.3.1)
      cat <<'EOT'
   - First start runs no migrations. The steps are the packs': with 0.3.1's
     kindgi CLI and SDK, rebuild and redeploy each pack that has guardrails.
   - A guardrail at before-tool, after-tool or model-step: until its pack's
     next deploy, it still can't run its check there
     (check-point-unsupported), as in 0.3.0.
   - An llm-judge guardrail a deploy before 0.3.1 registered still never
     judges. Make sure the pack sets its judgeCapabilities, then
       kindgi guardrails unregister <id>
     and deploy the pack right after: until then, the guardrail doesn't
     run. Without the unregister, the deploy is refused with 409
     guardrail-already-registered. The same goes for a guardrail whose at
     or sees changed while an earlier deploy kept the old ones.
EOT
      ;;
    0.4.0)
      # STEPS-PENDING marks a release whose runtime steps here aren't final
      # yet: they come from its release notes' Upgrade steps before its rc,
      # and the rc's cut stops while either script has the marker.
      cat <<'EOT'
   - STEPS-PENDING: this copy's 0.4.0 runtime steps below aren't final yet.
     Don't upgrade a deployment you keep with it: read the 0.4.0 release
     notes' Upgrade steps.
   - First start runs sixteen migrations: one new table, new columns that
     are empty or have a fixed default, nothing rewritten, and the
     supervisor_fix_proposals table dropped. They lock the tables they
     change or point to: agent_registry, agent_registry_versions,
     agent_promotions, block_registry_versions, deployments,
     deployment_endpoints, eval_runs, eval_suite_cases,
     improvement_proposals, judgments and projects. Seven of them hold the
     lock while they read every row, to check a new rule or build an
     index. One keeps judgments locked while it indexes every judgment, so
     people's judgments and corrections wait, on the old revision too; one
     indexes eval_runs, so starting or updating a test run waits. With many
     of either (SELECT count(*) FROM judgments; and the same FROM
     eval_runs) upgrade at a quiet time.
     A long transaction holding one of those tables makes the new revision
     fail after about a minute, naming the session that holds it (end it
     with pg_terminate_backend, or let it finish). The old revision keeps
     serving meanwhile.
   - With KINDGI_ARTIFACTS set to a gcs: bucket in server_env, give the
     identity the server reads it as storage.buckets.get on that bucket
     first: the 0.4.0 runtime reads the bucket's settings at start, and
     without it the runtime refuses to start. roles/storage.objectAdmin
     doesn't grant it: grant roles/storage.legacyBucketReader on the bucket,
     or add the permission to a custom role. A ledger or purge-record bucket
     needs only storage.objects.create.
   - A mail trigger on the company's mailbox now stores the connection it
     reads with. At its next look at the mailbox, one whose project has a
     single company connection at the app stores that one and reads on.
     With several, it reads nothing and shows connection-not-chosen, naming
     them, until a project admin points it at one:
       kindgi mail-triggers update <trigger-id> --mailbox=google \
         --as=company --connection=<name>
     (or --mailbox=microsoft), with --folder again if it watches a folder
     other than the inbox, and --allow-unattended if it lists tools allowed
     unattended.
   - Upgrading drops the old supervisor_fix_proposals table; at 0.3.x no
     route or job wrote to it.
   - Projects gain one column, sort_end_user_corrections, empty on existing
     projects, and empty reads as no: their end users' corrections aren't
     sorted until a project turns it on.
   - In KINDGI_LOG_LEVELS (server_env), change judging=<level> to
     expert-queue=<level>. The old name only warns at boot, and has no
     effect.
EOT
      ;;
  esac
}
# <<<

# What a release's module changes in place, which the plan makes: the plan
# check allows these (plan_allowed_changes) and nothing else. A run to an
# earlier release makes them too, with that release's runtime, so each one
# here works with the runtimes before its release. One that needs its own
# release's runtime has to make a --to below that release refuse, as a --to
# past this copy's releases does.
module_changes() {
  case "$1" in
    0.2.0)
      cat <<'EOT'
   - The plan also changes the pack's container app in place, with or
     without --pack-dir: quicker readiness checks (its startup probe asks
     every 2 s, up to 60 times).
EOT
      ;;
    0.3.1)
      cat <<'EOT'
   - 0.3.1 doesn't change the module.
EOT
      ;;
    0.4.0)
      cat <<'EOT'
   - 0.4.0's plan changes nothing in the module by itself: its one new
     variable, database_url_version, is empty unless a way back sets it.
EOT
      ;;
  esac
}

# 2d. Steps that need an operator's eye or the app's source, printed, not
# run; then what doesn't apply here. A dry run prints them too.
print_by_hand_steps() {
  local r
  step "Steps to confirm by hand (per release crossed)"
  # Empty for a server fix; expanded this way so bash 3.2's set -u allows that.
  if [[ ${#CROSSED[@]} -eq 0 ]]; then info "none: $TARGET is a server fix for $TARGET_RELEASE."; fi
  # A release up to the target's has its steps and its module changes; one
  # past it, only the module's changes, which the plan makes all the same.
  for r in ${MODULE_CROSSED[@]+"${MODULE_CROSSED[@]}"}; do
    if [[ "$(ver_num "$r")" -le "$(ver_num "$TARGET_RELEASE")" ]]; then
      printf '  %s:\n' "$r"
      release_steps "$r"
    else
      printf "  %s (this module's changes only; the runtime goes to %s):\n" "$r" "$TARGET"
    fi
    module_changes "$r"
  done

  # Not applicable on this module — said plainly so nobody goes looking.
  step "Not applicable on Container Apps (skipped)"
  info "PgBouncer minimum version — the server connects on port 5432, never through the database server's built-in PgBouncer."
  info "The secret-manager secret-name grammar — this module stores secrets in Postgres (KINDGI_SECRETS_BACKEND=postgres), never secret-manager."
}

# 5. The plan's check. Besides the new image(s), a plan may change only what
# the module's releases after the current one (MODULE_CROSSED) change in
# place, as their steps to confirm by hand say (module_changes):
# "<resource type>.<name> <attribute path>", the path without list indices,
# an env var by its name. The module's own changes in that release
# (services.tf, data.tf, foundation.tf, license-renewal.tf), each made in
# place. The way back's plan, which changes the server's database-url
# reference, is never checked here: it's printed, and run by hand. $1 is the
# plan (terraform show -json); no change here needs it.
plan_allowed_changes() {
  local r
  printf '%s\n' "azurerm_container_app.server template.container.image"
  # The license renewal job runs the server's image, with
  # license_renewal_schedule set.
  printf '%s\n' "azurerm_container_app_job.license_renewal template.container.image"
  if [[ $REBUILD_PACK == true ]]; then printf '%s\n' "azurerm_container_app.pack template.container.image"; fi
  for r in ${MODULE_CROSSED[@]+"${MODULE_CROSSED[@]}"}; do
    case "$r" in
      0.2.0)
        printf '%s\n' \
          "azurerm_container_app.pack template.container.startup_probe.interval_seconds" \
          "azurerm_container_app.pack template.container.startup_probe.timeout" \
          "azurerm_container_app.pack template.container.startup_probe.failure_count_threshold"
        ;;
    esac
  done
}

# >>> same in both modules: plan-changes
# Every change in a plan (terraform show -json) that $allowed doesn't name,
# one line each: a create, delete, replace or forget by what it does; an
# update by each attribute it changes, a value it knows or one known only
# after the apply. $allowed names a resource by "<type>.<name>", which covers
# each of its instances, or one instance by "<type>.<name>[<index>]" (a
# string index in double quotes); a create or a delete by the path
# "(created)" or "(deleted)". A replace or a forget is always listed. Never a
# value: a plan holds the variables' values, secret ones too. An env var or
# a database flag is keyed by its name, so one added or dropped from a list
# says which, and moves no other; one known only after the apply is named
# from the plan's after.
readonly PLAN_CHANGES_JQ='
  def leaves(p):
    if type == "object" then to_entries[] | .key as $k | .value | leaves(p + [$k])
    elif type == "array" then
      if (p | length) > 0 and (p[-1] == "env" or p[-1] == "database_flags")
         and all(.[]; type == "object" and (.name | type) == "string")
      then .[] | .name as $n | ([p + [$n], "set"], (del(.name) | leaves(p + [$n])))
      else to_entries[] | .key as $i | .value | leaves(p + [$i]) end
    else [p, .] end;
  def flat: [leaves([])] | map({key: (.[0] | tojson), value: .[1]}) | from_entries;
  def named($doc):
    . as $p
    | reduce range(1; $p | length) as $i ($p;
        if ($p[$i] | type) == "number" and ($p[$i - 1] == "env" or $p[$i - 1] == "database_flags")
        then ((try ($doc | getpath($p[0:$i])) catch null)
              | if type == "array" and all(.[]; type == "object" and (.name | type) == "string")
                then .[$p[$i]].name else null end) as $n
          | if $n != null then .[$i] = $n else . end
        else . end);
  def said:
    fromjson | map(select(type == "string")) as $s
    | ([range(0; $s | length) | select($s[.] == "env" or $s[.] == "database_flags")] | first) as $i
    | (if $i != null and ($s | length) > $i + 1 then $s[0:$i + 2] else $s end) | join(".");
  def act:
    if . == ["create"] then "created"
    elif . == ["delete"] then "deleted"
    elif . == ["delete", "create"] or . == ["create", "delete"] then "replaced: deleted and created again"
    elif . == ["forget"] then "taken out of the state"
    else join(", ") end;
  .resource_changes[]?
  | .address as $addr | "\(.type).\(.name)" as $key | .change as $c
  | ($key + (if .index == null then "" elif (.index | type) == "string"
      then "[\(.index | tojson)]" else "[\(.index)]" end)) as $inst
  | select($c.actions != ["no-op"] and $c.actions != ["read"])
  | if $c.actions != ["update"] then
      ($c.actions | act) as $did
      | select(($did == "created" or $did == "deleted")
          and ($allowed | any(.[]; (.key == $key or .key == $inst) and .path == "(\($did))")) | not)
      | "\($addr): \($did)"
    else
      ($c.before // {} | flat) as $b | ($c.after // {} | flat) as $a
      | ([$b, $a] | map(keys) | add | unique | map(. as $k | select($b[$k] != $a[$k])))
        + [$c.after_unknown // {} | paths(. == true) | named($c.after // {}) | tojson]
      | map(said) | unique | .[]
      | select(. as $w | $allowed | any(.[]; (.key == $key or .key == $inst) and (.path as $p | $w == $p or ($w | startswith($p + ".")))) | not)
      | "\($addr): changes \(.)"
    end'
# <<<

# The image a plan gives a container app ($n: server or pack), or nothing.
readonly PLAN_IMAGE_JQ='[.resource_changes[]? | select(.type == "azurerm_container_app" and .name == $n) | .change.after.template[0].container[0].image // empty] | first // ""'

# >>> same in both modules: check-plan
# Check a saved plan: it must point the server (and a rebuilt pack, with $2
# true) at the new image, and change nothing else plan_allowed_changes
# doesn't name. Says what's wrong and returns 1 if not.
check_plan() {
  local plan="$1" expect_pack="$2" json="$WORK/plan.json" allowed found image ok=true
  terraform show -json "$plan" >"$json" 2>"$WORK/show.err" \
    || { warn "couldn't read the saved plan with 'terraform show -json'. $(cat "$WORK/show.err")"; return 1; }
  allowed="$(plan_allowed_changes "$json" | jq -R -s -c 'split("\n") | map(select(length > 0) | split(" ") | {key: .[0], path: .[1]})')"
  found="$(jq -r --argjson allowed "$allowed" "$PLAN_CHANGES_JQ" "$json")" \
    || { warn "couldn't read the changes in the saved plan."; return 1; }
  image="$(jq -r --arg n server "$PLAN_IMAGE_JQ" "$json")"
  if [[ $image != "$NEW_SERVER_IMAGE" ]]; then
    warn "PLAN CHECK: the plan doesn't point the server at ${NEW_SERVER_IMAGE}${image:+ (it has $image)}."
    ok=false
  fi
  if [[ $expect_pack == true ]]; then
    image="$(jq -r --arg n pack "$PLAN_IMAGE_JQ" "$json")"
    if [[ $image != "$NEW_PACK_IMAGE" ]]; then
      warn "PLAN CHECK: the plan doesn't point the pack at ${NEW_PACK_IMAGE}${image:+ (it has $image)}."
      ok=false
    fi
  fi
  if [[ -n $found ]]; then
    warn "PLAN CHECK: the plan changes more than this upgrade does:"
    sed 's/^/    /' <<<"$found" >&2
    ok=false
  fi
  if [[ $ok == true ]]; then
    info "plan check: it changes the image(s), and only what the releases crossed change."
    return 0
  fi
  warn "Nothing above was applied. A var file left off the command (a pack's env, say) is what usually does this: give each file the deployment uses its own --var-file. If the changes are yours (a variable you changed, say), apply them on the release it runs now with a plan you review, then run this again."
  return 1
}
# <<<

# A dry run stops here. It lists what the steps below would change, with the
# names they'd use, prints the steps to confirm by hand, and shows the plan for
# the new image, taken with no state lock and saved only in $WORK. It changes
# nothing.
if [[ $DRY_RUN == true ]]; then
  info "the read-only checks passed."
  varfile_value_ok server_image "$NEW_SERVER_IMAGE"
  if [[ $REBUILD_PACK == true ]]; then require_cmd kindgi; fi

  step "What a real run would change, in order"
  info "2. log docker in to ${IMAGE_REPOSITORY} (a token from az acr login --expose-token, on docker login's stdin, which docker stores as it does for any login)"
  info "2. add the image tag ${IMAGE_REPOSITORY}/runtime:${TARGET} to the module's registry"
  info "   (a copy of ${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST}; it serves nothing until step 5)"
  info "   (both platforms, through this machine; on a slow uplink it can take most of an hour)"
  info "2. create, run and then delete ${#CHECKS[@]} Container Apps jobs with the new image, one per check:"
  for check in "${CHECKS[@]}"; do
    info "     $(check_job_name "$check" "<HHMMSS>")  (check $check)"
  done
  info "   in the environment ${ENVIRONMENT}, as the server's identity, reading database-url from the vault ${KEY_VAULT}"
  info "   A dry run doesn't run them; a real run stops before the plan if one fails."
  info "3. nothing yet: the backup is ${DB_SERVER}'s point-in-time restore (${RETENTION_DAYS} days kept, the earliest restore point ${EARLIEST_RESTORE})"
  if [[ $REBUILD_PACK == true ]]; then
    info "4. rebuild and push the pack from ${PACK_DIR} (kindgi build --local --push --env dev)"
  else
    info "4. nothing: without --pack-dir the pack image stays as it is"
  fi
  info "5. copy ${VAR_FILE} to $(varfile_backup_name "<YYYYMMDDTHHMMSSZ>")"
  info "   set server_image = \"${NEW_SERVER_IMAGE}\" in ${VAR_FILE}"
  if [[ $REBUILD_PACK == true ]]; then
    info "   set pack_image to the rebuilt pack (its digest is known only after the build)"
  fi
  info "   plan, check the plan as below, show it and ask you to type yes"
  if [[ $ON_DEMAND_BACKUP == true ]]; then
    info "   take the on-demand backup $(backup_name "<YYYYMMDDHHMMSS>") of ${DB_SERVER}"
  else
    info "   no on-demand backup: the ${DB_TIER} tier takes none"
  fi
  info "   record the restore point, the UTC time just before the apply"
  info "   apply exactly that plan, kept as $(plan_kept_name "<YYYYMMDDTHHMMSSZ>")"
  info "6. wait for the new revision of ${SERVER_APP}"

  print_by_hand_steps

  step "Terraform plan for the new image (read-only; ${VAR_FILE} is untouched)"
  if [[ $REBUILD_PACK == true ]]; then
    info "pack_image is unchanged in this plan: the rebuilt pack's digest is known only after the build."
  fi
  terraform plan "${TF_VAR_FILE_ARGS[@]}" -var "server_image=${NEW_SERVER_IMAGE}" -lock=false -out="$WORK/dry-run.tfplan" \
    || die "terraform plan failed. Nothing has changed."
  check_plan "$WORK/dry-run.tfplan" false \
    || die "a real run would stop at this plan (above). Nothing was changed."

  printf '\n%s\n' "upgrade: dry run done. Nothing was changed. Run the same command without --dry-run to upgrade."
  exit 0
fi

# 2b. Copy the new runtime image into the module's registry, so the check
# jobs (and step 5) pull it with the server's identity, as the server pulls.
# The copy keeps the release digest. This adds an image; it serves nothing
# until step 5. The copy goes through this machine, every layer down and
# back up, and takes both platforms: copying only linux/amd64 would make a
# new index with a digest of its own, not the release digest step 5 pins.
# On a slow uplink that's most of an hour.
step "Copying runtime ${TARGET} into the module's registry"
# The registry's token goes from az's stdout straight to docker login's
# stdin. A plain `az acr login` runs `docker login --password <token>`, so the
# token would be in docker's arguments, which any process on this machine can
# read while docker runs. 00000000-0000-0000-0000-000000000000 is the username
# az's token goes with. az's stdin is /dev/null, so it never asks for a
# username and password where nobody sees the question.
if ! az acr login -n "${IMAGE_REPOSITORY%%.*}" --expose-token --query accessToken -o tsv </dev/null 2>"$WORK/acr.err" \
  | docker login "$IMAGE_REPOSITORY" --username 00000000-0000-0000-0000-000000000000 --password-stdin \
    >/dev/null 2>"$WORK/login.err"; then
  if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
    die "couldn't log docker in to ${IMAGE_REPOSITORY} (az acr login --expose-token). Nothing was copied or changed. $(cat "$WORK/acr.err")"
  fi
  die "couldn't log docker in to ${IMAGE_REPOSITORY} (docker login, with az's token). Nothing was copied or changed. $(cat "$WORK/login.err")"
fi
info "This copies the runtime through this machine, down from ${RUNTIME_REPO%%/*} and up to ${IMAGE_REPOSITORY}. It takes both platforms (linux/amd64 and linux/arm64), so your copy keeps the release digest."
info "On a slow uplink it can take most of an hour; it says when it's done."
docker buildx imagetools create --tag "${IMAGE_REPOSITORY}/runtime:${TARGET}" \
  "${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST}" \
  || die "couldn't copy ${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST} into ${IMAGE_REPOSITORY}. Are you logged in to registry.kindgi.com (docker login registry.kindgi.com --username kindgi), and can you push to the module's registry?"
info "copied to $NEW_SERVER_IMAGE"

# Start a check job, then follow its run until it ends. Only Succeeded
# passes. Failed, Stopped, Degraded or any other end fails the check, and so
# does a run still going past JOB_POLL_BOUND seconds. Azure gives the run's
# state, not the check's exit code, so a check that found something (exit 1)
# and one that couldn't run (exit 2) both end Failed.
JOB_POLL_BOUND=$((JOB_REPLICA_TIMEOUT + JOB_START_MARGIN))
run_check() {
  local check="$1" job="$2" execution status="" waited=0
  execution="$(az containerapp job start -n "$job" -g "$RG" -o json 2>"$WORK/start.err" \
    | jq -r '.name // empty' 2>/dev/null || true)"
  if [[ -z $execution ]]; then
    fail_check "couldn't start the check job $job for $check. $(cat "$WORK/start.err")"
    return 0
  fi
  while :; do
    # Under properties, as Resource Manager returns it, or flat, as az
    # prints some reads.
    status="$(az containerapp job execution show -n "$job" -g "$RG" --job-execution-name "$execution" -o json 2>/dev/null \
      | jq -r '.properties.status // .status // empty' 2>/dev/null || true)"
    # Still going, or not readable yet: ask again, up to the bound.
    case "$status" in
      Running | Processing | "") ;;
      *) break ;;
    esac
    if ((waited >= JOB_POLL_BOUND)); then
      fail_check "the runtime check \"$check\" didn't end within ${JOB_POLL_BOUND}s (the job's ${JOB_REPLICA_TIMEOUT}s timeout, and ${JOB_START_MARGIN}s to start): it was ${status:-unreadable}. Its run is $execution; its logs, which reach Log Analytics a few minutes after it ends, and stay there after this run deletes the job: $(job_logs_command "$job" "$execution")"
      return 0
    fi
    sleep "$JOB_POLL_INTERVAL"
    waited=$((waited + JOB_POLL_INTERVAL))
  done
  if [[ $status == "Succeeded" ]]; then
    info "check $check: ok"
    return 0
  fi
  fail_check "the runtime check \"$check\" ended $status, not Succeeded: it reported findings or couldn't run. Its run is $execution; its logs, which reach Log Analytics a few minutes after it ends, and stay there after this run deletes the job: $(job_logs_command "$job" "$execution")"
}

# 2c. The runtime's own read-only checks, run with the NEW image against the
# database, as Container Apps jobs (one per check, deleted on exit). They
# need only KINDGI_DATABASE_URL: nothing starts, no migrations, no license.
# Each job runs in the module's environment, in its VNet, so it reaches the
# private database as the server does. It runs as the server's identity,
# which reads each of the server's secrets (Key Vault Secrets User, data.tf
# l.147-153) and pulls from the module's registry (AcrPull, foundation.tf
# l.151-155), and gets the database URL as a Key Vault reference without a
# version, as the server does. The check name is baked into the job's args
# at create time. provider-keys, secret-scopes and mcp-header-credentials
# apply for 0.1.8 -> 0.1.10 (stored-secrets is a restore check;
# purged-tenants is multi-tenant only).
#
# Each job is made from its whole resource, through Resource Manager, which
# takes it as written. `az containerapp job create --args` reads an argument
# that starts with -- (the check's --tenant) as an option of its own, and
# its --yaml rewrites the spec's keys, the identity's resource id among them.
# The resource names the URL's secret by reference and holds no value.
check_job_spec() {
  jq -n --arg location "$LOCATION" --arg identity "$SERVER_IDENTITY" --arg env "$ENVIRONMENT_ID" \
    --arg registry "$IMAGE_REPOSITORY" --arg image "$NEW_SERVER_IMAGE" --arg url "$DB_URL_SECRET_URI" \
    --arg name "$1" --arg check "$2" --arg tenant "$CHECK_TENANT" --argjson timeout "$JOB_REPLICA_TIMEOUT" '{
    location: $location,
    identity: {type: "UserAssigned", userAssignedIdentities: {($identity): {}}},
    properties: {
      environmentId: $env,
      workloadProfileName: "Consumption",
      configuration: {
        triggerType: "Manual",
        replicaTimeout: $timeout,
        replicaRetryLimit: 0,
        manualTriggerConfig: {parallelism: 1, replicaCompletionCount: 1},
        secrets: [{name: "database-url", keyVaultUrl: $url, identity: $identity}],
        registries: [{server: $registry, identity: $identity}]
      },
      template: {containers: [{
        name: $name,
        image: $image,
        args: (["check", $check] + (if $tenant == "" then [] else ["--tenant", $tenant] end)),
        env: [{name: "KINDGI_DATABASE_URL", secretRef: "database-url"}]
      }]}
    }}'
}
step "Running the new runtime's read-only checks (as jobs)"
check_stamp="$(date -u +%H%M%S)"
for check in "${CHECKS[@]}"; do
  job="$(check_job_name "$check" "$check_stamp")"
  spec="$WORK/$job.json"
  (umask 077 && check_job_spec "$job" "$check" >"$spec")
  CHECK_JOBS+=("$job")
  info "creating the check job $job (deleted when this run ends; if the run is killed first: az containerapp job delete -n $job -g $RG --yes)"
  # It returns once the job is made, or its making has failed.
  if az resource create --id "/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${job}" \
      --api-version "$ACA_API_VERSION" --is-full-object --properties "@${spec}" -o none 2>"$WORK/job.err"; then
    run_check "$check" "$job"
  else
    fail_check "couldn't create the check job $job for $check. $(cat "$WORK/job.err")"
  fi
done

# >>> same in both modules: checks-done
# 2d. The steps to confirm by hand, and what doesn't apply here.
print_by_hand_steps

if [[ $CHECK_FAILED == true ]]; then
  die "one or more checks failed (above). Nothing was backed up or changed. Fix them and run again."
fi
info "all automated checks passed."
# <<<

# --- step 3: the backup -----------------------------------------------------
# The database server's own point-in-time restore: Azure backs it up on its
# own, and a restore makes a NEW server, never overwriting this one. The
# point the way back restores to is the UTC time just before the apply,
# which step 5 records, after the on-demand backup, where the tier takes one.

step "3. The backup: point-in-time restore of $DB_SERVER"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
info "Azure keeps $RETENTION_DAYS days of backups of $DB_SERVER; the earliest point it restores to is $EARLIEST_RESTORE."
info "After you type yes, this run records the restore point, the UTC time just before the apply: the way back restores to it, into a new server."
if [[ $ON_DEMAND_BACKUP == true ]]; then
  info "Just before that, it takes an on-demand backup of $DB_SERVER, named for this upgrade."
else
  info "No on-demand backup: the $DB_TIER tier takes none."
fi
warn "Writes after the restore point are not in the backup and are lost if you roll back. On a busy deployment, stop traffic first."

# --- step 4: the pack image -------------------------------------------------

step "4. Pack image"
if [[ $REBUILD_PACK == true ]]; then
  require_cmd kindgi
  info "rebuilding the pack from $PACK_DIR"
  ( cd "$PACK_DIR" && kindgi build --local --push --env dev ) \
    || die "the pack build failed. The runtime image is copied, and nothing else has changed; fix the pack and run again."
  envelope="${PACK_DIR%/}/.kindgi/build/deploy-envelope.json"
  [[ -f $envelope ]] || die "the pack build left no $envelope to read the new image from."
  # pack_image is pinned by digest: the pushed ref's repository, then the digest.
  pack_ref="$(jq -r '.imageRef // empty' "$envelope")"
  pack_digest="$(jq -r '.imageDigest // empty' "$envelope")"
  if [[ $pack_ref == *@sha256:* ]]; then
    NEW_PACK_IMAGE="$pack_ref"
  else
    [[ -n $pack_ref && $pack_digest =~ ^sha256:[0-9a-f]{64}$ ]] \
      || die "couldn't read the new pack image (imageRef, imageDigest) from $envelope."
    pack_repo="$pack_ref"
    # Drop a tag, which follows the last "/" (a registry host's ":port" doesn't).
    if [[ ${pack_ref##*/} == *:* ]]; then pack_repo="${pack_ref%:*}"; fi
    NEW_PACK_IMAGE="${pack_repo}@${pack_digest}"
  fi
  info "new pack image $NEW_PACK_IMAGE"
elif [[ $HAS_PACK == true ]]; then
  warn "the deployment has a pack service, but no --pack-dir was given: the pack image is left unchanged. If a release crossed needs the pack rebuilt (its steps to confirm by hand, above, say so), rebuild it with 'kindgi build --local --push' and run again with --pack-dir."
fi

# --- step 5: plan and apply -------------------------------------------------
# The new image(s) go into the var-file itself, so what's planned is what the
# file says from now on. Until the apply starts, the EXIT trap puts it back.

# >>> same in both modules: plan
step "5. Terraform plan"
VARFILE_BACKUP="$(varfile_backup_name "$STAMP")"
cp "$VAR_FILE" "$VARFILE_BACKUP"
VARFILE_PENDING=true
varfile_set server_image "$NEW_SERVER_IMAGE"
if [[ $REBUILD_PACK == true ]]; then varfile_set pack_image "$NEW_PACK_IMAGE"; fi
info "$VAR_FILE now pins the new image(s); the previous copy is $VARFILE_BACKUP."

# The plan is saved in the work folder, removed at exit, until "yes": only the
# plan applied is kept, next to the var-file's copy.
PLAN="$WORK/upgrade.tfplan"
PLAN_KEPT="$(plan_kept_name "$STAMP")"
terraform plan "${TF_VAR_FILE_ARGS[@]}" -out="$PLAN" \
  || die "terraform plan failed. Nothing has changed."
# <<<
check_plan "$PLAN" "$REBUILD_PACK" \
  || die "the plan check failed (above), so nothing was applied."

# >>> same in both modules: yes-prompt
printf '\n'
warn "Review the plan above. It points the server (and pack, if rebuilt) at the new image. yes applies exactly this plan, and keeps it as $PLAN_KEPT."
printf 'Apply this plan? Type yes to proceed: '
reply=""
IFS= read -r reply || reply=""
# <<<
[[ $reply == "yes" ]] || die "not confirmed — nothing was applied."

# The backup, last before the apply, so it holds every write until then: an
# on-demand backup where the tier takes one, then the restore point.
step "The backup, just before the apply"
BACKUP_NAME=""
if [[ $ON_DEMAND_BACKUP == true ]]; then
  BACKUP_NAME="$(backup_name "$(date -u +%Y%m%d%H%M%S)")"
  info "taking the on-demand backup $BACKUP_NAME of $DB_SERVER (it can take several minutes)"
  az postgres flexible-server backup create -g "$RG" --server-name "$DB_SERVER" --name "$BACKUP_NAME" -o none 2>"$WORK/backup.err" \
    || die "couldn't take the on-demand backup $BACKUP_NAME (a server keeps up to seven), so nothing was applied. $(cat "$WORK/backup.err")"
fi
RESTORE_POINT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
info "restore point: $RESTORE_POINT (UTC), on $DB_SERVER. The way back restores to it."

# >>> same in both modules: apply
step "Applying"
mv "$PLAN" "$PLAN_KEPT" || die "couldn't keep the plan as $PLAN_KEPT, so nothing was applied."
# From here the deployment may change, so the var-file keeps the new image(s).
VARFILE_PENDING=false
info "applying the plan shown, kept as $PLAN_KEPT"
if ! terraform apply "$PLAN_KEPT"; then
  warn "terraform apply failed."
  print_go_back
  exit 1
fi
# <<<

# --- step 6: wait for the new revision --------------------------------------
# The image change makes a new revision (Single revision mode). It's ready
# when the app's update has succeeded and the latest revision, a new one
# with the new image, is the latest ready one too.

step "6. Waiting for the new revision to be ready"
ready=false
for ((i = 1; i <= POLL_TRIES; i++)); do
  app_json="$(az containerapp show -n "$SERVER_APP" -g "$RG" -o json 2>/dev/null || true)"
  if [[ -n $app_json ]]; then
    state="$(jq -r '.properties.provisioningState // ""' <<<"$app_json" 2>/dev/null || true)"
    latest="$(jq -r '.properties.latestRevisionName // ""' <<<"$app_json" 2>/dev/null || true)"
    latest_ready="$(jq -r '.properties.latestReadyRevisionName // ""' <<<"$app_json" 2>/dev/null || true)"
    image="$(jq -r '.properties.template.containers[0].image // ""' <<<"$app_json" 2>/dev/null || true)"
    if [[ $state == "Succeeded" && -n $latest && $latest != "$OLD_REVISION" && $latest_ready == "$latest" && $image == "$NEW_SERVER_IMAGE" ]]; then
      ready=true
      info "revision $latest_ready is serving."
      break
    fi
  fi
  sleep "$POLL_INTERVAL"
done

if [[ $ready != true ]]; then
  warn "the new revision did not become ready within $((POLL_INTERVAL * POLL_TRIES))s."
  print_go_back
  exit 1
fi

step "Done"
info "$CURRENT -> $TARGET applied. Check it with:  kindgi health --url \"$SERVER_URL\" --token <api token>"
info "Restore point $RESTORE_POINT on ${DB_SERVER}${BACKUP_NAME:+, and the on-demand backup $BACKUP_NAME}; the previous var-file at $VARFILE_BACKUP; the plan applied at $PLAN_KEPT."
exit 0
