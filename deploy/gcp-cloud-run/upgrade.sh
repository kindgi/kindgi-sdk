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
# Scope: every network_mode, "none" (README "A small dev deployment"),
# "direct" and "connector". The runtime's checks run as jobs that reach the
# database the way the server does: with the server's VPC egress (its subnet
# in "direct"; in "connector", the connector, when the database is private-IP),
# and through the /cloudsql socket unless the database is private-IP. A
# private-IP database's certificate is checked against the instance's CAs, as
# the server checks it.
#
# The variables: it lists the files Terraform reads them from, each --var-file
# and the ones Terraform loads on its own from this directory
# (terraform.tfvars, *.auto.tfvars and their .json forms), and passes every
# --var-file to each terraform command that reads them (console and plan).
#
# The plan: before it asks for "yes", it checks the plan itself (terraform
# show -json). It stops if the plan replaces anything, or creates, deletes or
# changes anything but the new image and what the releases after the current
# one change, as their steps to confirm by hand name; it says what each one
# is. The plan is of the module in this directory, as of the newest release
# this copy knows, so with a --to below that release it also has the
# module's changes up to it, which it lists and allows. So a var file left
# off the command, whose variables the plan would empty (the server's own env
# in server_env and server_secret_env, say), stops it before anything is
# applied. "yes" applies exactly the plan shown.
#
# From a release before 0.4.0, the plan also moves the deployment to a pack
# service for each deployment, which the pack orchestrator makes (README "5.
# The pack orchestrator"). With the one pack service, from the apply until each
# pack is deployed again, calls to a deployed pack's tools are refused, so run
# it at a quiet hour. After the apply it prints the steps that finish the
# switch, by hand: the orchestrator's key, a second apply, the pack's env and a
# deploy of each pack. For those steps it reads the variables 0.4.0 took out
# (pack_image, pack_min_instances, pack_env, pack_secret_env) from the var
# files, and prints names, secret ids and version numbers, never a value.
#
# Run it from this module directory, after `terraform init`, as the identity
# that deploys the module (it reads the running service and the module's state,
# backs up the database, mirrors the new image, and plans/applies the module).
#
# Log in to registry.kindgi.com first, where the runtime image comes from:
#   docker login registry.kindgi.com --username kindgi
# and paste your license key when it asks for the password.
#
# What it changes besides the deployment itself:
#   - It grants the Cloud SQL instance's service account roles/storage.objectAdmin
#     on the backup bucket (Cloud SQL writes the export as that account). The
#     grant stays on the bucket. A new grant can take a few minutes to take
#     effect; until it does, the export waits for it.
#   - It rewrites the server_image line in the var-file that sets it, so a
#     later plain apply keeps the new image. The previous file is kept next to
#     it as
#     <var-file>.pre-upgrade-<UTC time>; if you don't confirm the plan, the
#     var-file is put back.
#   - It keeps the plan it applies next to that copy, as
#     <var-file>.upgrade-<UTC time>.tfplan: `terraform show <file>` reads what
#     was applied. A plan file holds what the var files and the state hold, so
#     only you can read it; delete it once you no longer need it. A plan you
#     don't confirm, or one the check stops, isn't kept: applied later, it
#     would leave the var-file behind the deployment.
#
# Usage:
#   ./upgrade.sh --var-file dev.tfvars [--var-file <another var file> ...] \
#                --runtime-digest sha256:<64 hex> \
#                --backup-bucket gs://<bucket>[/<prefix>] \
#                [--to 0.4.0] [--from <version>] \
#                [--check-tenant <uuid>] [--dry-run]
#
#   --var-file         A tfvars file the deployment uses (.tfvars or
#                      .tfvars.json). Give one --var-file per file, in the
#                      order you give them to terraform: each is passed to
#                      `terraform console` and `terraform plan`, and to the
#                      plan it prints for going back. A file Terraform doesn't
#                      load on its own (a pack's env in dev.pack-env.tfvars.json,
#                      say, not named *.auto.tfvars.json) needs its own
#                      --var-file. From a release before 0.4.0, give it the
#                      file with the pack's env too: the steps after the
#                      apply name each of its variables.
#                      Exactly one of them sets server_image, on one line:
#                      that's the one rewritten. No file Terraform loads on
#                      its own, and no TF_VAR_ in the environment, may set the
#                      image it writes, or a later apply without that
#                      --var-file would put it back.
#   --runtime-digest   The release digest of the runtime being upgraded to,
#                      from its release notes (sha256:…). Checked against the
#                      release's tag, then mirrored into the deployment's
#                      Artifact Registry by its whole index.
#   --backup-bucket    A GCS bucket (optionally a prefix) the database export
#                      is written to. The export is one database, never an
#                      instance backup.
#   --to               The target runtime version, 0.4.0 or later (default
#                      0.4.0). An rc such as 0.4.0-rc.0 works too, and so does
#                      a server-only release such as 0.4.0.1: a server fix for
#                      0.4.0, with no SDK release of its own. The module here
#                      is 0.4.0's, which needs the 0.4.0 runtime or later: to
#                      an earlier release, use this script as of that
#                      release's @kindgi/sdk@<version> tag (for X.Y.Z.N,
#                      X.Y.Z's tag), and below 0.2.0, which isn't on
#                      registry.kindgi.com, as of the @kindgi/sdk@0.1.10 tag.
#                      This script knows the steps up to 0.4.0; for a later
#                      release, use this script as of that release's
#                      @kindgi/sdk@<version> tag or, before that release is
#                      out, its newest @kindgi/sdk@<version>-rc.N tag.
#   --from             Assert the current version (0.1.10, say, or 0.2.0.1)
#                      when it can't be read from the deployment (no version
#                      tag on the running image).
#   --check-tenant     Limit the runtime's read-only checks to one tenant.
#   --dry-run          Change nothing. Run the reads and the read-only checks,
#                      list every change a real run would make, in order, with
#                      the names it would use, and show the Terraform plan for
#                      the new image, checked as a real run checks its plan
#                      (read-only: the var-file untouched, the plan taken with
#                      no state lock, and its file only in a temporary folder,
#                      removed when it ends). It writes nothing, but reading
#                      the variables through `terraform console` briefly takes
#                      the state lock, so a dry run stops, without harm, while
#                      an apply holds it. The runtime's own checks run as jobs
#                      in your project, so only a real run runs them.

set -euo pipefail

# gcloud writes its answers (which can include secret values piped through it)
# to a per-invocation log file unless this is set. Keep it off for every call.
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true

# Anything this script writes to disk (the plan, the resolved config) may name
# instances, service accounts and bucket paths — keep it to this user.
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

# How long to wait for a new bucket grant to reach Cloud SQL (step 3): Google
# says an IAM change typically takes effect in 2 minutes, and potentially 7
# minutes or longer.
readonly GRANT_WAIT_INTERVAL=15
readonly GRANT_WAIT_SECONDS=420

# The module here is 0.4.0's: its server sends each deployment's pack calls to
# a pack service of that deployment's own, which only the 0.4.0 runtime and
# later can. A run to an earlier release is that release's script's.
readonly MODULE_RUNTIME_FLOOR="0.4.0"
# The release that moved the deployment from the one pack service to one per
# deployment: a run from before it makes the switch.
readonly PACKS_RELEASE="0.4.0"
# The names 0.4.0's module gives the server itself, which its plan refuses in
# server_env and server_secret_env.
readonly SERVER_ENV_SET_BY_MODULE=("KINDGI_PACK_ROUTING" "KINDGI_PACK_ENDPOINT_HOSTS" "KINDGI_PACK_ENDPOINT_KMS_KEY" "KINDGI_ENV_CLOUD_SECRETS")

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
# Migrations only go forward, so going back restores the backup into a FRESH
# database — never points an old runtime at the migrated one.
print_go_back() {
  local fresh="${DATABASE_NAME}_r$(date -u +%Y%m%d)"
  local ledger="erasures-$(date -u +%F).json"
  # Both CLI commands talk to the release the run started from: the export to
  # the server serving now, the replay to the old image put back (step 6 below).
  local cli="@kindgi/cli@$(line_of "$CURRENT")" rc_note=""
  # A range never matches a pre-release, so on an rc, @kindgi/cli@X.Y finds no
  # version until X.Y.Z is out. The rc's own number doesn't name the CLI: the
  # runtime and the SDK number their rcs separately. Only a deployment that was
  # never moved to its final reads as an rc here.
  if [[ $CURRENT == *-rc.* ]]; then
    rc_note=$'\n'"    This deployment runs a pre-release, ${CURRENT}. Until $(release_of "$CURRENT") is out,"
    rc_note+=$'\n'"    npx finds no ${cli}: in this step and in step 7, name the"
    rc_note+=$'\n'"    CLI's own pre-release instead, as @kindgi/cli@$(release_of "$CURRENT")-rc.N"
    rc_note+=$'\n'"    (npm view @kindgi/cli versions lists them)."
  fi
  # A private-IP database's URL keeps its host; a socket's names the instance.
  local db_where="host=/cloudsql/${SQL_CONNECTION_NAME} and dbname ${fresh}"
  if [[ $DATABASE_PRIVATE == true ]]; then
    db_where="dbname ${fresh}, and the host, port and sslmode=require of its current version"
  fi
  cat <<EOT >&2

======================================================================
The upgrade did not come up. NOTHING has been rolled back automatically.
Migrations only go forward, so do not point an old runtime at the
migrated database — restore the backup into a FRESH database instead.

To go back:

 1. First, export the erasure ledger from the server serving now. It holds
    every erasure so far, including any made after the backup. With the
    CLI signed in to ${SERVER_URL}:
      npx --yes ${cli} memory erasures export --out=${ledger}${rc_note}
    If no server answers, the backup's own ledger is all there is: an
    erasure made after ${STAMP} can't be replayed.

$(print_go_back_plan)
    The plan holds your variables' values, secret ones too: umask 077 keeps
    it readable by you alone, and step 6 deletes it.
    The server runs its migrations each time an instance of it starts. An
    instance of the new version that starts after step 5 and before the
    apply would migrate the fresh database too, so apply right after step 5.

 3. A fresh database on the same instance:
      gcloud sql databases create ${fresh} --instance=${DB_INSTANCE} --project=${PROJECT}

 4. Import the backup into it (the instance's service account already has
    objectAdmin on gs://${BUCKET_ONLY}, from the backup step):
      gcloud sql import sql ${DB_INSTANCE} ${EXPORT_URI} \\
        --database=${fresh} --user=kindgi --project=${PROJECT}

 5. Point the server at the fresh database: add a new version of the secret
    ${DB_URL_SECRET}, with ${db_where}.
    Set the password as in README step 3, never in a command's
    arguments. (Don't change database_name instead: the module would drop
    the migrated database, then fail to create ${fresh}.)

 6. Right away, apply the saved plan. The new revision reads the new
    secret version when it starts:
      terraform apply back.tfplan
      rm back.tfplan
    If Terraform refuses the plan as stale, plan again as in step 2 and
    apply at once.

 7. Before anyone uses it, replay the erasures:
      npx --yes ${cli} memory erasures replay ${ledger}
    A replay matches only when the server has KINDGI_ERASURE_LEDGER_KEY
    (server_secret_env); without it, every erasure comes back unmatched.
    With secrets_backend = "postgres", also run the old image's
    "check stored-secrets": a job like the pre-upgrade checks, but with the
    server's secrets settings (KINDGI_SECRETS_BACKEND, its KMS key and the
    AAD key) as well as the database URL.
======================================================================
EOT
}

# The way back's step 2: the old image(s) back, and the plan. After a switch
# to 0.4.0's packs, the module of the release it came from too, whose plan
# makes the one pack service again.
print_go_back_plan() {
  local from letters="abcde" l
  from="$(release_of "$CURRENT")"
  if [[ $SWITCH != true ]]; then
    cat <<EOT
 2. Before the database changes, put the old image(s) back and save the
    plan, then read it:
      cp $(printf '%q' "$VARFILE_BACKUP") $(printf '%q' "$VAR_FILE")
      (umask 077 && terraform plan$(var_file_flags) -out=back.tfplan)
EOT
    return 0
  fi
  cat <<EOT
 2. Before the database changes, put back the module of ${from}, then the old
    image(s), and save the plan, then read it. The module here is 0.4.0's,
    which plans the 0.4.0 runtime or later only.
EOT
  l="${letters:0:1}"; letters="${letters:1}"
  cat <<EOT
    ${l}. In this directory, put the module's .tf files as of the
       @kindgi/sdk@${from} tag (deploy/gcp-cloud-run) in place of these.
       Keep .terraform/, the state and your var files.
EOT
  l="${letters:0:1}"; letters="${letters:1}"
  cat <<EOT
    ${l}. Put the var-file back:
         cp $(printf '%q' "$VARFILE_BACKUP") $(printf '%q' "$VAR_FILE")
EOT
  if [[ $TENANCY == "multi" ]]; then
    cat <<EOT
       Then give server_env back the KINDGI_PACK_ROUTING ("per-deployment")
       and KINDGI_PACK_ENDPOINT_HOSTS that ${from}'s module needs, and start
       your own orchestrator again.
EOT
  fi
  if [[ $SECRETS_BACKEND == "none" ]]; then
    l="${letters:0:1}"; letters="${letters:1}"
    cat <<EOT
    ${l}. Take the KMS key 0.4.0's module made out of the state: ${from}'s module
       has none with secrets_backend = "none", and the key can't be
       destroyed. It stays in the project, unused. Each of these that
       terraform state list lists:
         terraform state rm google_kms_crypto_key_iam_member.server_wraps google_kms_crypto_key_iam_member.server_reads_key google_kms_crypto_key.secrets google_kms_key_ring.kindgi
EOT
  fi
  if [[ $HAS_PACK == true ]]; then
    l="${letters:0:1}"; letters="${letters:1}"
    cat <<EOT
    ${l}. If terraform state list lists no google_secret_manager_secret.shared,
       the apply took the one pack service's token away. Make it again, with
       a new value, and give it to the module, or the pack service and the
       server can't start:
         gcloud secrets create ${NAME_PREFIX}-pack-service-token --replication-policy=user-managed --locations=${REGION} --project=${PROJECT}
         openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add ${NAME_PREFIX}-pack-service-token --data-file=- --project=${PROJECT}
         terraform import$(var_file_flags) 'google_secret_manager_secret.shared["pack_service_token"]' projects/${PROJECT}/secrets/${NAME_PREFIX}-pack-service-token
EOT
  fi
  l="${letters:0:1}"; letters="${letters:1}"
  cat <<EOT
    ${l}. Plan:
         (umask 077 && terraform plan$(var_file_flags) -out=back.tfplan)
       It takes away what 0.4.0's module made: the orchestrator's Job,
       schedule, account, roles and key secret.
EOT
  if [[ $HAS_PACK == true ]]; then
    cat <<EOT
       It makes the one pack service again: from that apply until it's up,
       calls to the pack's tools are refused again.
EOT
  fi
  cat <<EOT
       The pack services the orchestrator made, named kp-..., and their kp-
       secrets aren't in the state. After the way back nothing calls them,
       and they stay until you delete them.
EOT
}

# The names a run gives what it creates, so a dry run lists the ones a real
# run uses. A check job's name is at most 63 characters: the prefix is cut to
# 45 (the rest adds 18) and loses a trailing "-". $2 is the run's HHMMSS.
# >>> same in both modules: checks
readonly CHECKS=("provider-keys" "secret-scopes" "mcp-header-credentials")
# <<<
check_job_name() {
  local prefix="${NAME_PREFIX:0:45}" suffix
  while [[ $prefix == *- ]]; do prefix="${prefix%-}"; done
  case "$1" in
    provider-keys) suffix="pk" ;;
    secret-scopes) suffix="ss" ;;
    mcp-header-credentials) suffix="mhc" ;;
  esac
  printf '%s-upgchk-%s-%s' "$prefix" "$2" "$suffix"
}
# The export and the var-file's backup copy. $1 is the run's UTC stamp.
export_uri() { printf '%s/%s-%s-%s-%s.sql.gz' "${BACKUP_BUCKET%/}" "$NAME_PREFIX" "$DATABASE_NAME" "$CURRENT" "$1"; }
# >>> same in both modules: kept-files
varfile_backup_name() { printf '%s.pre-upgrade-%s' "$VAR_FILE" "$1"; }
# The plan a run applies, kept next to the var-file's copy.
plan_kept_name() { printf '%s.upgrade-%s.tfplan' "$VAR_FILE" "$1"; }
# <<<

# --- arguments --------------------------------------------------------------

VAR_FILES=()
RUNTIME_DIGEST=""
BACKUP_BUCKET=""
TARGET="$DEFAULT_TARGET"
FROM_OVERRIDE=""
PACK_DIR=""            # never set here (--pack-dir is refused); the shared code reads it
CHECK_TENANT=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) VAR_FILES+=("${2:-}"); shift 2 ;;
    --runtime-digest) RUNTIME_DIGEST="${2:-}"; shift 2 ;;
    --backup-bucket) BACKUP_BUCKET="${2:-}"; shift 2 ;;
    --to) TARGET="${2:-}"; shift 2 ;;
    --from) FROM_OVERRIDE="${2:-}"; shift 2 ;;
    --pack-dir) die "--pack-dir: from 0.4.0 each deployment has a pack service of its own, which the pack orchestrator makes from the image its deploy names, so there's no pack service to rebuild here. Deploy each pack with kindgi deploy (after an upgrade from before 0.4.0, the steps after the apply say how)." ;;
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
[[ -n $BACKUP_BUCKET ]] || die "--backup-bucket is required (see --help)."
[[ $BACKUP_BUCKET =~ ^gs://[a-z0-9][-a-z0-9._]*(/.*)?$ ]] || die "--backup-bucket must look like gs://<bucket>[/<prefix>]."
BUCKET_ONLY="${BACKUP_BUCKET#gs://}"; BUCKET_ONLY="${BUCKET_ONLY%%/*}"
is_version "$TARGET" || die "--to \"$TARGET\" isn't a version like 0.2.0, 0.2.0-rc.0 or 0.2.0.1."
TARGET_RELEASE="$(release_of "$TARGET")"
[[ "$(ver_num "$TARGET_RELEASE")" -ge "$(ver_num "$TARGET_FLOOR")" ]] \
  || die "--to $TARGET: this script copies the runtime from registry.kindgi.com, which has $TARGET_FLOOR and later. For an earlier release, use this script as of the @kindgi/sdk@0.1.10 tag."
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
[[ "$(ver_num "$TARGET_RELEASE")" -ge "$(ver_num "$MODULE_RUNTIME_FLOOR")" ]] \
  || die "--to $TARGET: the module here is ${MODULE_RUNTIME_FLOOR}'s, which needs the ${MODULE_RUNTIME_FLOOR} runtime or later. Use this script as of $(sdk_tag "$TARGET_RELEASE")."

require_cmd terraform gcloud jq docker

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
CHECK_JOBS=()          # ephemeral pre-upgrade check jobs, deleted on exit
VARFILE_BACKUP=""      # the var-file as it was, once step 5 rewrites it
VARFILE_PENDING=false  # rewritten, but the apply hasn't started: put it back
cleanup() {
  local code=$? job
  if [[ ${#CHECK_JOBS[@]} -gt 0 ]]; then
    for job in "${CHECK_JOBS[@]}"; do
      gcloud run jobs delete "$job" --project="$PROJECT" --region="$REGION" --quiet >/dev/null 2>&1 || true
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
# come from `terraform console`. console takes the state lock while it runs
# and has no -lock flag, so while an apply holds the lock this read fails,
# without harm. It writes nothing.

if [[ $DRY_RUN == true ]]; then
  printf '%s\n' "upgrade: DRY RUN. It reads only: nothing is mirrored, granted, exported, built, written or applied, and no job is run."
fi

step "Reading the deployment"

TF_OUT="$WORK/outputs.json"
terraform output -json >"$TF_OUT" 2>"$WORK/output.err" \
  || die "couldn't read terraform outputs — run this from the module directory, after 'terraform init'. $(cat "$WORK/output.err")"

IMAGE_REPOSITORY="$(jq -r '.image_repository.value // empty' "$TF_OUT")"
SERVER_SA="$(jq -r '.service_accounts.value.server // empty' "$TF_OUT")"
SERVER_URL="$(jq -r '.server_url.value // empty' "$TF_OUT")"
[[ -n $IMAGE_REPOSITORY && -n $SERVER_SA ]] \
  || die "the module's outputs are incomplete — has the deployment been applied?"

# One terraform console call returns the variables as a JSON object. console
# renders jsonencode()'s string with HCL quoting, so `jq fromjson` unwraps it.
# Its warnings, such as one for each variable a var file sets that the module
# doesn't declare, come on stdout ahead of the value, so the value is its
# last line.
VARS_EXPR='jsonencode({project_id=var.project_id, region=var.region, name_prefix=var.name_prefix, network_mode=var.network_mode, vpc_connector=var.vpc_connector, database_private_network=var.database_private_network, database_host_instance=var.database_host_instance, database_name=var.database_name, secrets_backend=var.secrets_backend, secrets_aad_key_version=var.secrets_aad_key_version, tenancy=var.tenancy, seed_tenant_id=var.seed_tenant_id, server_image=var.server_image, database_instance=var.database_instance, orchestrator_key_version=var.orchestrator_key_version, server_env_names=keys(var.server_env), server_secret_env_names=keys(var.server_secret_env), pack_endpoint_hosts=lookup(var.server_env, "KINDGI_PACK_ENDPOINT_HOSTS", "")})'
VARS_RAW="$(terraform console "${TF_VAR_FILE_ARGS[@]}" <<<"$VARS_EXPR" 2>"$WORK/console.err")" \
  || die "couldn't read the module's variables with 'terraform console'. $(cat "$WORK/console.err")"
VARS="$(jq 'fromjson' <<<"${VARS_RAW##*$'\n'}")" \
  || die "couldn't parse the module's variables from terraform console."

PROJECT="$(jq -r '.project_id' <<<"$VARS")"
REGION="$(jq -r '.region' <<<"$VARS")"
NAME_PREFIX="$(jq -r '.name_prefix' <<<"$VARS")"
NETWORK_MODE="$(jq -r '.network_mode' <<<"$VARS")"
VPC_CONNECTOR="$(jq -r '.vpc_connector // ""' <<<"$VARS")"
DATABASE_PRIVATE_NETWORK="$(jq -r '.database_private_network // ""' <<<"$VARS")"
DATABASE_NAME="$(jq -r '.database_name' <<<"$VARS")"
SECRETS_BACKEND="$(jq -r '.secrets_backend' <<<"$VARS")"
SECRETS_AAD_KEY_VERSION="$(jq -r '.secrets_aad_key_version // ""' <<<"$VARS")"
TENANCY="$(jq -r '.tenancy' <<<"$VARS")"
SEED_TENANT_ID="$(jq -r '.seed_tenant_id // ""' <<<"$VARS")"
DATABASE_HOST_INSTANCE="$(jq -r '.database_host_instance // ""' <<<"$VARS")"
OLD_SERVER_IMAGE="$(jq -r '.server_image' <<<"$VARS")"
ORCHESTRATOR_KEY_VERSION="$(jq -r '.orchestrator_key_version // ""' <<<"$VARS")"
DATABASE_INSTANCE_NAME="$(jq -r '.database_instance.name // ""' <<<"$VARS")"
DATABASE_INSTANCE_URL_SECRET="$(jq -r '.database_instance.url_secret // ""' <<<"$VARS")"

SERVER_SERVICE="${NAME_PREFIX}-server"

# The variables 0.4.0's module took out, the one pack service's: pack_image,
# pack_min_instances, pack_env and pack_secret_env. The module here doesn't
# declare them, so its console can't read them. A config of their own in
# $WORK declares those four alone, as the releases before 0.4.0 did, and reads
# them from the same files in the order Terraform takes them: TF_VAR_ in the
# environment, then from this directory terraform.tfvars,
# terraform.tfvars.json and the *.auto.tfvars(.json) files in name order, then
# each --var-file. Terraform only warns about a file's value for a variable
# the config doesn't declare, so the module's own plan takes the same files.
# Here those warnings come every time, for the module's own variables, and
# the value is again console's last line. pack_env's names alone are read,
# never its values.
REMOVED_DIR="$WORK/removed-variables"
mkdir "$REMOVED_DIR"
cat >"$REMOVED_DIR/variables.tf" <<'EOT'
variable "pack_image" {
  type    = string
  default = ""
}
variable "pack_min_instances" {
  type    = number
  default = 1
}
variable "pack_env" {
  type    = map(string)
  default = {}
}
variable "pack_secret_env" {
  type = map(object({
    secret  = string
    version = string
    project = optional(string)
  }))
  default = {}
}
EOT
REMOVED_ARGS=()
for f in terraform.tfvars terraform.tfvars.json; do
  if [[ -f $f ]]; then REMOVED_ARGS+=("-var-file=$PWD/$f"); fi
done
while IFS= read -r f; do
  if [[ -f $f ]]; then REMOVED_ARGS+=("-var-file=$PWD/$f"); fi
done < <(printf '%s\n' *.auto.tfvars *.auto.tfvars.json | LC_ALL=C sort)
for f in "${VAR_FILES[@]}"; do
  case "$f" in
    /*) REMOVED_ARGS+=("-var-file=$f") ;;
    *) REMOVED_ARGS+=("-var-file=$PWD/$f") ;;
  esac
done
REMOVED_RAW="$(terraform -chdir="$REMOVED_DIR" console "${REMOVED_ARGS[@]}" \
  <<<'jsonencode({pack_image=var.pack_image, pack_min_instances=var.pack_min_instances, pack_env_names=keys(var.pack_env), pack_secret_env=var.pack_secret_env})' \
  2>"$WORK/removed.err")" \
  || die "couldn't read the variables 0.4.0 took out (pack_image, pack_min_instances, pack_env, pack_secret_env) with 'terraform console'. $(cat "$WORK/removed.err")"
REMOVED="$(jq 'fromjson' <<<"${REMOVED_RAW##*$'\n'}")" \
  || die "couldn't parse the variables 0.4.0 took out from terraform console."
OLD_PACK_IMAGE="$(jq -r '.pack_image' <<<"$REMOVED")"
OLD_PACK_MIN_INSTANCES="$(jq -r '.pack_min_instances' <<<"$REMOVED")"

# 0.4.0's module refuses these in its plan; say so before anything is read,
# backed up or changed.
if [[ $NAME_PREFIX == "kp" || $NAME_PREFIX == kp-* ]]; then
  die "name_prefix is \"$NAME_PREFIX\": from 0.4.0 the pack orchestrator owns the services and secrets named kp-..., and the module refuses that prefix. A name_prefix can't change in place: deploy the module again under another name_prefix, and serve it from a restored instance (README \"Serving from a restored instance\")."
fi
for name in "${SERVER_ENV_SET_BY_MODULE[@]}"; do
  if jq -e --arg n "$name" '(.server_env_names + .server_secret_env_names) | index($n) != null' <<<"$VARS" >/dev/null; then
    if [[ $name == KINDGI_PACK_ENDPOINT_HOSTS ]]; then
      die "server_env or server_secret_env sets $name ($(jq -r '.pack_endpoint_hosts' <<<"$VARS")), which 0.4.0's module sets itself, to *-<project number>.${REGION}.run.app: this project's services in $REGION. An endpoint recorded on any other host is refused from the apply on. Take it out of the var file, then run again. Nothing was changed."
    fi
    die "server_env or server_secret_env sets $name, which 0.4.0's module sets itself, and its plan refuses it there. Take it out of the var file, then run again. Nothing was changed."
  fi
done

case "$NETWORK_MODE" in
  none|direct|connector) ;;
  *) die "network_mode is \"$NETWORK_MODE\"; this script knows \"none\", \"direct\" and \"connector\"." ;;
esac
# A private-IP database (the module's own instance only) is reached over TCP
# through the services' VPC egress; any other through the /cloudsql socket.
DATABASE_PRIVATE=false
if [[ -n $DATABASE_PRIVATE_NETWORK ]]; then DATABASE_PRIVATE=true; fi

# The check jobs' VPC egress: the server's own (services.tf), so they reach
# the database the way it does.
JOB_NET_ARGS=()
JOB_NET_SAID=""
case "$NETWORK_MODE" in
  direct)
    JOB_NET_ARGS=(--network="$NAME_PREFIX" --subnet="${NAME_PREFIX}-run" --vpc-egress=all-traffic)
    JOB_NET_SAID="Direct VPC egress on subnet ${NAME_PREFIX}-run, all traffic"
    ;;
  connector)
    if [[ $DATABASE_PRIVATE == true ]]; then
      JOB_NET_ARGS=(--vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only)
      JOB_NET_SAID="the connector ${VPC_CONNECTOR}, private ranges"
    fi
    ;;
esac

# The instance the database lives on: a restored one wins, then a host, then
# the module's own (named name_prefix). The URL secret the server reads from.
if [[ -n $DATABASE_INSTANCE_NAME ]]; then
  DB_INSTANCE="$DATABASE_INSTANCE_NAME"
  DB_URL_SECRET="$DATABASE_INSTANCE_URL_SECRET"
elif [[ -n $DATABASE_HOST_INSTANCE ]]; then
  DB_INSTANCE="$DATABASE_HOST_INSTANCE"
  DB_URL_SECRET="${NAME_PREFIX}-database-url"
else
  DB_INSTANCE="$NAME_PREFIX"
  DB_URL_SECRET="${NAME_PREFIX}-database-url"
fi

# The shared code rebuilds a pack with --pack-dir, which this module refuses.
REBUILD_PACK=false
NEW_PACK_IMAGE=""

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
info "project         $PROJECT"
info "region          $REGION"
info "server service  $SERVER_SERVICE"
info "network mode    $NETWORK_MODE"
if [[ $DATABASE_PRIVATE == true ]]; then
  info "database        $DATABASE_NAME on instance $DB_INSTANCE (private IP)"
else
  info "database        $DATABASE_NAME on instance $DB_INSTANCE"
fi
info "image repo      $IMAGE_REPOSITORY"

# --- step 1: the current version --------------------------------------------

step "1. Current runtime version"

# `services describe` returns the v1 (Knative) object, so the image is under
# spec.template.spec.
RUNNING_IMAGE="$(gcloud run services describe "$SERVER_SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --format='value(spec.template.spec.containers[0].image)' 2>"$WORK/describe.err")" \
  || die "couldn't read the server service \"$SERVER_SERVICE\". $(cat "$WORK/describe.err")"
[[ -n $RUNNING_IMAGE ]] || die "the server service \"$SERVER_SERVICE\" has no image — is it deployed?"
[[ $RUNNING_IMAGE == "$OLD_SERVER_IMAGE" ]] \
  || die "the server runs $RUNNING_IMAGE, but $VAR_FILE has server_image = \"$OLD_SERVER_IMAGE\". Make the var-file match what's deployed, then run again."

CURRENT=""
if [[ -n $FROM_OVERRIDE ]]; then
  CURRENT="$FROM_OVERRIDE"
  info "using --from $CURRENT"
else
  # The running image is digest-pinned and carries no tag. The version tag is on
  # the same digest in Artifact Registry (README step 2 mirrors with --tag).
  repo_no_digest="${RUNNING_IMAGE%@*}"
  running_digest="${RUNNING_IMAGE##*@}"
  tags="$(gcloud artifacts docker images list "$repo_no_digest" --include-tags \
    --filter="version=${running_digest}" --format='value(tags)' 2>/dev/null || true)"
  # tags is semicolon/comma/space separated; word-split on those (no array, so
  # an empty result just iterates zero times under set -u on bash 3.2). An rc
  # promoted to its final carries both tags; the highest is the version.
  for tag in ${tags//[;,]/ }; do
    if is_version "$tag"; then
      if [[ -z $CURRENT || "$(ver_num "$tag")" -gt "$(ver_num "$CURRENT")" ]]; then CURRENT="$tag"; fi
    fi
  done
  if [[ -n $CURRENT ]]; then
    info "read $CURRENT from the mirrored image's tag"
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
  warn "the module here is this copy's, as of $NEWEST_KNOWN: the plan also makes its changes for the releases after $TARGET_RELEASE (its steps to confirm by hand list them), with the $TARGET runtime. To keep the module at $TARGET_RELEASE, use this script as of $(sdk_tag "$TARGET_RELEASE")."
fi

# A run from a release before 0.4.0 moves the deployment to 0.4.0's packs. An
# rc of 0.4.0 has them already.
SWITCH=false
if [[ "$(ver_num "$(release_of "$CURRENT")")" -lt "$(ver_num "$PACKS_RELEASE")" ]]; then SWITCH=true; fi
# Whether it ran the one pack service then, which the switch takes away.
HAS_PACK=false
if [[ $SWITCH == true && -n $OLD_PACK_IMAGE && $TENANCY == "single" ]]; then HAS_PACK=true; fi

if [[ $SWITCH == true ]]; then
  # The orchestrator's key secret is made by this run's apply, and the key is
  # minted after it, by the 0.4.0 server: no version of it can exist yet.
  if [[ -n $ORCHESTRATOR_KEY_VERSION ]]; then
    die "orchestrator_key_version is set (\"$ORCHESTRATOR_KEY_VERSION\"), but ${NAME_PREFIX}-orchestrator-key, the secret it names a version of, is made by this run's apply, and the key in it is minted after that, by the 0.4.0 server. Take it out of the var file, then run again: the steps after the apply say when to set it. Nothing was changed."
  fi
  # Each pack_secret_env entry becomes a cloud secret of the pack's env, so it
  # must be one: checked as kindgi env set --cloud-secret checks it, by its
  # name, secret id, project and version, never a value.
  bad_secret_env="$(jq -r '.pack_secret_env | to_entries[]
    | .key as $n | .value as $r
    | if ($n | test("^[A-Z_][A-Z0-9_]*$") | not) or ($n | startswith("KINDGI_"))
        then "\($n): a pack env name is upper-case letters, digits and _, and not KINDGI_..."
      elif ($r.secret | test("^[A-Za-z0-9_-]{1,255}$") | not)
        then "\($n): secret is a secret id of letters, digits, _ and -, with the project in project, not a path"
      elif ($r.secret | startswith("kp-"))
        then "\($n): secret \($r.secret) starts with kp-, which the pack services own"
      elif $r.project != null and ($r.project | test("^([a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]{0,29})$") | not)
        then "\($n): project is a project id or number"
      elif $r.version == "latest"
        then "\($n): version is \"latest\": pick its number (gcloud secrets versions list \($r.secret)), and set that"
      elif ($r.version | test("^[1-9][0-9]{0,18}$") | not)
        then "\($n): version is a version number"
      else empty end' <<<"$REMOVED")"
  if [[ -n $bad_secret_env ]]; then
    warn "from 0.4.0 each pack_secret_env entry is a cloud secret of the pack's env, pinned to a version number. These aren't:"
    sed 's/^/    /' <<<"$bad_secret_env" >&2
    die "fix them in the var file, then run again. Nothing was changed."
  fi
fi

NEW_SERVER_IMAGE="${IMAGE_REPOSITORY}/runtime@${RUNTIME_DIGEST}"

# --- step 2: checks ---------------------------------------------------------
# Everything here is read-only against the deployment. Mirroring the new image
# (below) only adds to Artifact Registry; it changes nothing that serves. The
# first change to the running deployment is the apply in step 5.

step "2. Pre-upgrade checks"

# >>> same in both modules: fail-check
CHECK_FAILED=false
fail_check() { CHECK_FAILED=true; warn "CHECK FAILED: $*"; }
# <<<

# 2a. Preconditions, cheapest first.
# The database's instance: its socket (the check jobs and the server mount it),
# its service account (it writes the export), its version and its public IP.
sql_json="$(gcloud sql instances describe "$DB_INSTANCE" --project="$PROJECT" --format=json 2>"$WORK/sql.err" || true)"
SQL_CONNECTION_NAME="$(jq -r '.connectionName // empty' <<<"${sql_json:-null}" 2>/dev/null || true)"
SQL_SA="$(jq -r '.serviceAccountEmailAddress // empty' <<<"${sql_json:-null}" 2>/dev/null || true)"
if [[ -z $SQL_CONNECTION_NAME ]]; then
  fail_check "couldn't read Cloud SQL instance $DB_INSTANCE. $(cat "$WORK/sql.err")"
else
  # A shared instance must run Postgres 16 or later; the module's own instance
  # is Postgres 16 by construction.
  if [[ -n $DATABASE_HOST_INSTANCE ]]; then
    db_version="$(jq -r '.databaseVersion // ""' <<<"$sql_json")"
    if [[ $db_version =~ ^POSTGRES_(1[6-9]|[2-9][0-9])$ ]]; then
      info "host instance $DB_INSTANCE is $db_version (ok)"
    else
      fail_check "host instance $DB_INSTANCE is \"${db_version:-unreadable}\", not Postgres 16 or later."
    fi
  fi
  if [[ $DATABASE_PRIVATE != true && "$(jq -r '.settings.ipConfiguration.ipv4Enabled // false' <<<"$sql_json")" != "true" ]]; then
    fail_check "instance $DB_INSTANCE has no public IP; the server and the check jobs reach it over /cloudsql, which needs one."
  fi
fi

# A private-IP database: the CAs its certificate must chain to, read as the
# module reads them (google_sql_ca_certs), so the check jobs check it as the
# server does (KINDGI_DATABASE_SERVER_CA).
DATABASE_SERVER_CA=""
if [[ $DATABASE_PRIVATE == true ]]; then
  DATABASE_SERVER_CA="$(gcloud sql ssl server-ca-certs list --instance="$DB_INSTANCE" --project="$PROJECT" --format=json 2>"$WORK/ca.err" \
    | jq -r '[.[]? | .cert // empty | sub("^\\s+"; "") | sub("\\s+$"; "")] | join("\n")' 2>/dev/null || true)"
  [[ -n $DATABASE_SERVER_CA ]] \
    || fail_check "couldn't read instance $DB_INSTANCE's server CAs, which the check jobs check its certificate against, as the server does. $(cat "$WORK/ca.err")"
fi

# A var-file from a module copy before secrets_aad_key_version stops at the
# plan, after the export. Say so now.
if [[ $SECRETS_BACKEND == "postgres" && -z $SECRETS_AAD_KEY_VERSION ]]; then
  fail_check "secrets_backend = \"postgres\" needs secrets_aad_key_version in $VAR_FILE: the version of ${NAME_PREFIX}-secrets-aad-key the server reads now, never \"latest\" (README \"Upgrading\")."
fi

# The release's own tag must be the digest given, or the mirror below would put
# the version tag (which a later run's step 1 reads) on the wrong image.
release_digest="$(docker buildx imagetools inspect "${RUNTIME_REPO}:${TARGET}" --format '{{json .Manifest}}' 2>"$WORK/inspect.err" | jq -r '.digest // empty' 2>/dev/null || true)"
if [[ -z $release_digest ]]; then
  fail_check "couldn't read ${RUNTIME_REPO}:${TARGET}. Are you logged in? docker login registry.kindgi.com --username kindgi, with your license key as the password. $(cat "$WORK/inspect.err")"
elif [[ $release_digest != "$RUNTIME_DIGEST" ]]; then
  fail_check "${RUNTIME_REPO}:${TARGET} is $release_digest, not the --runtime-digest $RUNTIME_DIGEST. Check the pair against the release notes."
fi

# Stop on a failed precondition before spending anything: no image is mirrored
# and no check job runs if one fails.
if [[ $CHECK_FAILED == true ]]; then
  die "a precondition failed (above). Nothing was mirrored, backed up or changed. Fix it and run again."
fi

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
    0.1.10)
      cat <<'EOT'
   - The plan also changes, in place: the database instance, one flag
     (idle_in_transaction_session_timeout, which needs no restart); in
     direct mode, the Cloud NAT's port settings; and in none mode, the pack
     service's VPC access setting, which it didn't use, goes.
EOT
      ;;
    0.2.0)
      cat <<'EOT'
   - With a pack service, 0.2.0's module changes it in place: CPU only while
     a call runs, a start boost, and quicker readiness checks. 0.4.0's deletes
     it (below), so this plan doesn't change it.
   - With a private-IP database (database_private_network), the plan also
     gives the server KINDGI_DATABASE_SERVER_CA, in place: the instance's
     CAs, which the server checks the database's certificate against.
EOT
      ;;
    0.3.0)
      cat <<'EOT'
   - With the module's own database instance, the plan changes it in place:
     it turns on Google's deletion protection (deletion_protection_enabled)
     beside Terraform's, while database_deletion_protection is on (the
     default). If a plan says the instance must be replaced, answer no: a
     replace deletes the database. (This script's plan check stops on a
     replace before it asks.)
   - With a private-IP database (database_private_network) as well, that
     change makes the module read the instance's CAs during the apply, so
     the plan shows the server's KINDGI_DATABASE_SERVER_CA as known after
     apply. It's still the instance's CAs.
EOT
      ;;
    0.3.1)
      cat <<'EOT'
   - 0.3.1 doesn't change the module.
EOT
      ;;
    0.4.0)
      if [[ $SWITCH != true ]]; then
        cat <<'EOT'
   - From a 0.4.0 pre-release, the module has 0.4.0's packs already: the plan
     gives the orchestrator's Job the new image too.
EOT
        return 0
      fi
      cat <<'EOT'
   - The plan moves the deployment to a pack service for each deployment,
     which the pack orchestrator makes: a Cloud Run Job, from the server's
     image, that Cloud Scheduler runs once a minute. With the one pack
     service, it deletes that service, its token's secret and their grants.
     It makes the orchestrator's account, its grants and its key's secret,
     the server's right to invoke the project's services, and, with
     secrets_backend "none", the KMS key the pack services' tokens are sealed
     under. It gives the server its settings for routing each deployment
     (KINDGI_PACK_ROUTING and the rest). The Job and its schedule come at a
     second apply, by hand, once the orchestrator's key is in its secret.
   - With the one pack service, from the apply until each pack is deployed
     again, calls to a deployed pack's tools are refused: pack-route-missing,
     then, for about a minute, pack-endpoint-pending. Pick a quiet hour.
     Going back to the release it runs now makes the one pack service again,
     with a second such window.
   - After the apply, this script prints the steps that finish the switch, by
     hand: the orchestrator's key, the var file's second apply, the pack's
     env, and a deploy of each pack.
EOT
      if [[ $TENANCY == "multi" ]]; then
        cat <<'EOT'
   - With tenancy = "multi", stop your own orchestrator before the apply: from
     0.4.0 the module's makes each new deployment's service. An endpoint
     yours recorded stays as it is, and its calls keep reaching your service
     while its host matches *-<project number>.<region>.run.app, until that
     deployment is deployed again. Then the old one is retired, and you
     delete your service, its token and its secrets.
EOT
      fi
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
  step "Not applicable on Cloud Run (skipped)"
  info "PgBouncer minimum version — this module has no PgBouncer."
  info "The secret-manager secret-name grammar — this module stores secrets under \"$SECRETS_BACKEND\", never KINDGI_SECRETS_BACKEND=secret-manager."
}

# What step 4 says: from 0.4.0 there's no pack to build here.
pack_step_said() {
  if [[ $HAS_PACK == true ]]; then
    printf '%s' "the apply deletes the one pack service, and the pack orchestrator makes each deployment's own, from the image its deploy names (the steps after the apply)"
  else
    printf '%s' "the pack orchestrator makes each deployment's pack service, from the image its deploy names"
  fi
}

# After a run from before 0.4.0, the steps that finish the switch to a pack
# service per deployment: printed, never run. They name the pack's env by its
# names, and its secrets by id, project and version number, never a value.
print_switch_steps() {
  local readers plain cloud name path n=2 env_flags tenant="<tenant id>" grants=""
  readers="$(jq -r '[.pack_secret_env[] | {secret, project}] | unique[]
    | if .project == null then "        { secret = \"\(.secret)\" },"
      else "        { secret = \"\(.secret)\", project = \"\(.project)\" }," end' <<<"$REMOVED")"
  plain="$(jq -r '.pack_env_names[]' <<<"$REMOVED")"
  cloud="$(jq -r --arg p "$PROJECT" '.pack_secret_env | to_entries[]
    | "\(.key) projects/\(.value.project // $p)/secrets/\(.value.secret)/versions/\(.value.version)"' <<<"$REMOVED")"
  if [[ -n $readers ]]; then grants=", and the pack account's grants on those secrets"; fi
  if [[ $TENANCY == "single" && -n $SEED_TENANT_ID ]]; then tenant="$SEED_TENANT_ID"; fi
  env_flags="--url $(printf '%q' "$SERVER_URL") --scope=tenant --env=<env>"
  step "Steps that finish the switch to 0.4.0's packs, by hand"
  cat <<EOT
 1. Mint the pack orchestrator's key, and keep it as the first version of
    ${NAME_PREFIX}-orchestrator-key, as step 1 of this says, with your names
    in it (README "5. The pack orchestrator"):
      terraform output -raw orchestrator_key_steps

 2. In the var files, set orchestrator_key_version to the version it added
    ("1" the first time), and take out the variables 0.4.0 doesn't have:
    pack_image, pack_min_instances, pack_env and pack_secret_env. A var file
    that held only those goes from the command below.
EOT
  if [[ -n $readers ]]; then
    cat <<EOT
    Add the secrets the pack's env reads to pack_secret_readers, so the pack
    account may read each one:
      pack_secret_readers = [
${readers}
      ]
EOT
  fi
  if [[ $OLD_PACK_MIN_INSTANCES != "1" ]]; then
    cat <<EOT
    pack_min_instances was ${OLD_PACK_MIN_INSTANCES}. From 0.4.0 a pack service
    scales to zero when it's idle, and its first call after that waits for
    an instance to start (README "The pack services").
EOT
  fi
  cat <<EOT
    Then plan, read the plan, and apply it. It makes the orchestrator's Job
    and its schedule${grants}. The plan holds your variables' values, secret
    ones too: umask 077 keeps it readable by you alone.
      (umask 077 && terraform plan$(var_file_flags) -out=switch.tfplan)
      terraform apply switch.tfplan
      rm switch.tfplan
EOT
  if [[ -n $plain || -n $cloud ]]; then
    n=$((n + 1))
    cat <<EOT

 ${n}. Set the pack's env in Kindgi, at the env the pack is deployed at
    (README "The pack services"). At the tenant's scope each deployment gets
    it, as the one pack service did; org:<id> or project:<id> narrows it.
EOT
    if [[ -n $plain ]]; then
      printf '%s
' "    Its plain values, each with its value from pack_env, and the API token:"
      while IFS= read -r name; do
        printf '      KINDGI_API_TOKEN=<api token> kindgi env set %q <its value> %s
' "$name" "$env_flags"
      done <<<"$plain"
    fi
    if [[ -n $cloud ]]; then
      printf '%s
' "    Its cloud secrets, with a system key holding system:env-refs, minted as"
      printf '%s
' "    README \"The pack services\" says (revoke it once they're set):"
      while read -r name path; do
        printf '      KINDGI_API_TOKEN=<that key> kindgi env set %s --cloud-secret %s --tenant=%s %s
' "$name" "$path" "$tenant" "$env_flags"
      done <<<"$cloud"
    fi
  fi
  n=$((n + 1))
  cat <<EOT

 ${n}. Deploy each pack again, as it's deployed now, with the same image and a
    new idempotency key, so the deploy isn't answered as the earlier one was:
      kindgi deploy --env <env> --endpoint $(printf '%q' "$SERVER_URL") --token <api token> --idempotency-key <new value>
    Its tools answer once the orchestrator has made its service, within about
    a minute; with the one pack service, until the deploy they answer
    pack-route-missing.
    kindgi deployments get <deployment-id> shows whether its service is ready.
EOT
  if [[ $TENANCY == "multi" ]]; then
    n=$((n + 1))
    cat <<EOT

 ${n}. With tenancy = "multi", each tenant deploys its packs again, as above,
    with a key of the tenant. Each old deployment is then retired. Once
    GET /v1/system/deployments?endpoint=retire no longer lists one, delete
    the service your own orchestrator made for it, its token and its
    secrets.
EOT
  fi
}

# 5. The plan's check. Besides the new image(s), a plan may change only what
# the module's releases after the current one (MODULE_CROSSED) change in
# place, as their steps to confirm by hand say (module_changes):
# "<resource type>.<name> <attribute path>", the path without list indices,
# an env var or a database flag by its name. A resource the release makes or
# takes away is "<resource type>.<name> (created)" or "(deleted)", and one
# instance of it "<resource type>.<name>[<index>]". The module's own changes
# in that release (services.tf, data.tf, foundation.tf, orchestrator.tf). $1
# is the plan (terraform show -json), for a change allowed only beside
# another.
plan_allowed_changes() {
  local r
  printf '%s\n' "google_cloud_run_v2_service.server template.containers.image"
  # From 0.4.0 the orchestrator's Job runs the server's image too.
  printf '%s\n' "google_cloud_run_v2_job.orchestrator template.template.containers.image"
  for r in ${MODULE_CROSSED[@]+"${MODULE_CROSSED[@]}"}; do
    case "$r" in
      0.1.10)
        printf '%s\n' \
          "google_sql_database_instance.kindgi settings.database_flags.idle_in_transaction_session_timeout" \
          "google_compute_router_nat.nat enable_dynamic_port_allocation" \
          "google_compute_router_nat.nat enable_endpoint_independent_mapping" \
          "google_compute_router_nat.nat min_ports_per_vm" \
          "google_compute_router_nat.nat max_ports_per_vm" \
          "google_compute_router_nat.nat tcp_time_wait_timeout_sec"
        # The pack's VPC access goes in none mode only, where it had no use.
        if [[ $NETWORK_MODE == none ]]; then printf '%s\n' "google_cloud_run_v2_service.pack template.vpc_access"; fi
        ;;
      0.2.0)
        printf '%s\n' \
          "google_cloud_run_v2_service.pack template.containers.resources.cpu_idle" \
          "google_cloud_run_v2_service.pack template.containers.resources.startup_cpu_boost" \
          "google_cloud_run_v2_service.pack template.containers.startup_probe.period_seconds" \
          "google_cloud_run_v2_service.pack template.containers.startup_probe.timeout_seconds" \
          "google_cloud_run_v2_service.pack template.containers.startup_probe.failure_threshold" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_DATABASE_SERVER_CA"
        ;;
      0.3.0)
        printf '%s\n' "google_sql_database_instance.kindgi settings.deletion_protection_enabled"
        # That change makes the module read a private-IP instance's CAs during
        # the apply, so in the same plan the server's are known only then.
        # Never on their own.
        if [[ $DATABASE_PRIVATE == true ]] && plan_protects_instance "$1"; then
          printf '%s\n' "google_cloud_run_v2_service.server template.containers.env.KINDGI_DATABASE_SERVER_CA"
        fi
        ;;
      0.4.0)
        # Only a run from before 0.4.0 makes the switch.
        [[ $SWITCH == true ]] || continue
        printf '%s\n' \
          "google_cloud_run_v2_service.pack (deleted)" \
          "google_cloud_run_v2_service_iam_member.server_invokes_pack (deleted)" \
          "google_secret_manager_secret.shared (deleted)" \
          "google_secret_manager_secret_iam_member.pack_reads_token (deleted)" \
          "google_secret_manager_secret_iam_member.pack_reads_its_secrets (deleted)" \
          "google_secret_manager_secret_iam_member.server_reads[\"pack_service_token\"] (deleted)" \
          "google_service_account.orchestrator (created)" \
          "google_project_iam_member.orchestrator_runs_services (created)" \
          "google_service_account_iam_member.orchestrator_acts_as_pack (created)" \
          "google_artifact_registry_repository_iam_member.orchestrator_reads_images (created)" \
          "google_project_iam_custom_role.pack_secrets (created)" \
          "google_project_iam_member.orchestrator_pack_secrets (created)" \
          "google_project_iam_custom_role.secret_create_list (created)" \
          "google_project_iam_member.orchestrator_creates_lists_secrets (created)" \
          "google_project_iam_member.pack_reads_pack_secrets (created)" \
          "google_secret_manager_secret.orchestrator_key (created)" \
          "google_secret_manager_secret_iam_member.orchestrator_reads_key (created)" \
          "google_project_iam_member.server_invokes_packs (created)" \
          "google_project_service.apis[\"cloudscheduler.googleapis.com\"] (created)" \
          "google_cloud_run_v2_service_iam_member.orchestrator_invokes_server (created)" \
          "google_secret_manager_secret_iam_member.pack_reads_cloud_secrets (created)" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_PACK_ROUTING" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_PACK_ENDPOINT_HOSTS" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_PACK_ENDPOINT_KMS_KEY" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_ENV_CLOUD_SECRETS" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_PACK_SERVICE_URL" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_PACK_SERVICE_TOKEN" \
          "google_cloud_run_v2_service.server template.containers.env.KINDGI_PACK_SERVICE_AUTH"
        # The KMS key the endpoints' tokens are sealed under: the secrets'
        # key, which "postgres" has already.
        if [[ $SECRETS_BACKEND == "none" ]]; then
          printf '%s\n' \
            "google_project_service.apis[\"cloudkms.googleapis.com\"] (created)" \
            "google_kms_key_ring.kindgi (created)" \
            "google_kms_crypto_key.secrets (created)" \
            "google_kms_crypto_key_iam_member.server_wraps (created)" \
            "google_kms_crypto_key_iam_member.server_reads_key (created)"
        fi
        # The pack account, now there in every shape: renamed where the one
        # pack service ran as it, made with its grants where none did.
        if [[ $HAS_PACK == true ]]; then
          printf '%s\n' "google_service_account.pack display_name"
        else
          printf '%s\n' \
            "google_service_account.pack (created)" \
            "google_project_iam_member.pack_sql_client (created)" \
            "google_storage_bucket_iam_member.pack_reads (created)" \
            "google_cloud_run_v2_service_iam_member.pack_invokes (created)"
        fi
        ;;
    esac
  done
}

# Whether a plan (terraform show -json) turns on Google's deletion protection
# on the module's instance, in place: 0.3.0's change.
plan_protects_instance() {
  jq -e '[.resource_changes[]?
    | select(.type == "google_sql_database_instance" and .name == "kindgi" and .change.actions == ["update"])
    | select((.change.before.settings[0].deletion_protection_enabled // false) != true
        and .change.after.settings[0].deletion_protection_enabled == true)] | length > 0' "$1" >/dev/null 2>&1
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

# The image a plan gives a Cloud Run service ($n: server or pack), or nothing.
readonly PLAN_IMAGE_JQ='[.resource_changes[]? | select(.type == "google_cloud_run_v2_service" and .name == $n) | .change.after.template[0].containers[0].image // empty] | first // ""'

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
  [[ -n $SQL_SA ]] || die "couldn't read instance $DB_INSTANCE's service account; a real run would stop at the backup."
  varfile_value_ok server_image "$NEW_SERVER_IMAGE"

  step "What a real run would change, in order"
  info "2. add gcloud as the credential helper for ${REGION}-docker.pkg.dev in your docker config"
  info "   (gcloud auth configure-docker; no change if it's there already)"
  info "2. add the image tag ${IMAGE_REPOSITORY}/runtime:${TARGET} to Artifact Registry"
  info "   (a copy of ${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST}; it serves nothing until step 5)"
  info "   (both platforms, through this machine; on a slow uplink it can take most of an hour)"
  info "2. create, run and then delete ${#CHECKS[@]} Cloud Run jobs with the new image, one per check:"
  for check in "${CHECKS[@]}"; do
    info "     $(check_job_name "$check" "<HHMMSS>")  (check $check)"
  done
  if [[ -n $JOB_NET_SAID ]]; then info "   with the server's VPC egress: ${JOB_NET_SAID}"; fi
  if [[ $DATABASE_PRIVATE == true ]]; then
    info "   reaching the database at its private IP, its certificate checked against the instance's CAs"
  else
    info "   reaching the database through the /cloudsql socket of ${SQL_CONNECTION_NAME}"
  fi
  info "   A dry run doesn't run them; a real run stops before the backup if one fails."
  info "3. grant serviceAccount:${SQL_SA} roles/storage.objectAdmin on gs://${BUCKET_ONLY} (the grant stays)"
  info "   export the \"${DATABASE_NAME}\" database to $(export_uri "<YYYYMMDDTHHMMSSZ>")"
  info "4. nothing to build: $(pack_step_said)"
  info "5. copy ${VAR_FILE} to $(varfile_backup_name "<YYYYMMDDTHHMMSSZ>")"
  info "   set server_image = \"${NEW_SERVER_IMAGE}\" in ${VAR_FILE}"
  info "   plan, check the plan as below, show it and ask you to type yes"
  info "   apply exactly that plan, kept as $(plan_kept_name "<YYYYMMDDTHHMMSSZ>")"
  info "6. wait for the new revision of ${SERVER_SERVICE}"
  if [[ $SWITCH == true ]]; then info "   then print the steps that finish the switch to 0.4.0's packs (below)"; fi

  print_by_hand_steps
  if [[ $SWITCH == true ]]; then print_switch_steps; fi

  step "Terraform plan for the new image (read-only; ${VAR_FILE} is untouched)"
  terraform plan "${TF_VAR_FILE_ARGS[@]}" -var "server_image=${NEW_SERVER_IMAGE}" -lock=false -out="$WORK/dry-run.tfplan" \
    || die "terraform plan failed. Nothing has changed."
  check_plan "$WORK/dry-run.tfplan" false \
    || die "a real run would stop at this plan (above). Nothing was changed."

  printf '\n%s\n' "upgrade: dry run done. Nothing was changed. Run the same command without --dry-run to upgrade."
  exit 0
fi

# 2b. Mirror the new runtime image into the deployment's Artifact Registry, so
# the read-only check job (and step 5) can pull it (Cloud Run can't pull from
# a registry that takes a password, like registry.kindgi.com). The mirror keeps
# the release digest. This adds an image; it serves nothing until step 5.
# The copy goes through this machine, every layer down and back up, and takes
# both platforms: copying only linux/amd64 would make a new index with a digest
# of its own, not the release digest step 5 pins. On a slow uplink that's most
# of an hour.
step "Mirroring runtime ${TARGET} into Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null 2>&1 || true
info "This copies the runtime through this machine, down from ${RUNTIME_REPO%%/*} and up to Artifact Registry. It takes both platforms (linux/amd64 and linux/arm64), so your copy keeps the release digest."
info "On a slow uplink it can take most of an hour; it says when it's done."
docker buildx imagetools create --tag "${IMAGE_REPOSITORY}/runtime:${TARGET}" \
  "${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST}" \
  || die "couldn't mirror ${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST} into ${IMAGE_REPOSITORY}. Are you logged in to registry.kindgi.com (docker login registry.kindgi.com --username kindgi), and can you push to Artifact Registry?"
info "mirrored to $NEW_SERVER_IMAGE"

# 2c. The runtime's own read-only checks, run with the NEW image against the
# database, as ephemeral Cloud Run jobs (one per check, deleted on exit). They
# need only KINDGI_DATABASE_URL: nothing starts, no migrations, no license. The
# check name is baked into the job's args at create time, since `jobs execute`
# can't override them across gcloud versions. provider-keys, secret-scopes and
# mcp-header-credentials apply for 0.1.8 -> 0.1.10 (stored-secrets is a restore
# check; purged-tenants is multi-tenant only).
step "Running the new runtime's read-only checks (as jobs)"
check_stamp="$(date -u +%H%M%S)"
# The way to the database, as the server's: its VPC egress, then the /cloudsql
# socket, or the CAs a private-IP database's certificate is checked against
# (PEM text over several lines, so it goes in an env-vars file: YAML, which
# JSON is too).
job_db_args=(${JOB_NET_ARGS[@]+"${JOB_NET_ARGS[@]}"})
if [[ $DATABASE_PRIVATE == true ]]; then
  jq -n --arg ca "$DATABASE_SERVER_CA" '{KINDGI_DATABASE_SERVER_CA: $ca}' >"$WORK/job-env.yaml"
  job_db_args+=(--env-vars-file="$WORK/job-env.yaml")
else
  job_db_args+=(--set-cloudsql-instances="$SQL_CONNECTION_NAME")
fi
for check in "${CHECKS[@]}"; do
  job="$(check_job_name "$check" "$check_stamp")"
  args="check,${check}"
  if [[ -n $CHECK_TENANT ]]; then args="${args},--tenant,${CHECK_TENANT}"; fi
  if gcloud run jobs create "$job" \
      --project="$PROJECT" --region="$REGION" \
      --image="$NEW_SERVER_IMAGE" \
      --service-account="$SERVER_SA" \
      "${job_db_args[@]}" \
      --set-secrets="KINDGI_DATABASE_URL=${DB_URL_SECRET}:latest" \
      --args="$args" --max-retries=0 --quiet >/dev/null 2>"$WORK/job.err"; then
    CHECK_JOBS+=("$job")
    # --wait exits non-zero when the execution fails: the check exited 1
    # (findings) or 2 (couldn't run). Either fails the check.
    if gcloud run jobs execute "$job" --project="$PROJECT" --region="$REGION" \
        --wait --quiet >/dev/null 2>"$WORK/exec.err"; then
      info "check $check: ok"
    else
      fail_check "the runtime check \"$check\" reported findings or couldn't run — see: gcloud run jobs executions list --job=$job --region=$REGION"
    fi
  else
    fail_check "couldn't create the check job for $check. $(cat "$WORK/job.err")"
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

# --- step 3: back up the database -------------------------------------------
# One database, as an export — never an instance backup, which would be the
# app's whole instance and whose restore would roll the app's data back too.

step "3. Backing up the \"$DATABASE_NAME\" database"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EXPORT_URI="$(export_uri "$STAMP")"

# The export is written by the instance's own service account, which needs
# object-create on the bucket. Grant it (idempotent), scoped to this bucket.
[[ -n $SQL_SA ]] || die "couldn't read instance $DB_INSTANCE's service account; can't grant the export."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_ONLY}" \
  --member="serviceAccount:${SQL_SA}" --role="roles/storage.objectAdmin" --quiet >/dev/null \
  || die "couldn't grant instance $DB_INSTANCE's service account write on gs://${BUCKET_ONLY}."
info "granted $SQL_SA roles/storage.objectAdmin on gs://${BUCKET_ONLY} (the grant stays)."

warn "The export is a point in time. Writes after it are not in the backup and are lost if you roll back. On a busy deployment, stop traffic first."
info "exporting to $EXPORT_URI (a large database can take several minutes; gcloud's output follows when it ends)"
# Until the grant above takes effect, Cloud SQL refuses the export with
# HTTPError 412 and "the required permissions for the bucket". Only that is
# waited out, for up to GRANT_WAIT_SECONDS; any other failure stops at once.
waited=0
until gcloud sql export sql "$DB_INSTANCE" "$EXPORT_URI" \
    --project="$PROJECT" --database="$DATABASE_NAME" --quiet 2>"$WORK/export.err"; do
  if ! grep -q 'HTTPError 412' "$WORK/export.err" || ! grep -q 'permissions for the bucket' "$WORK/export.err"; then
    cat "$WORK/export.err" >&2
    die "the export failed (above). Nothing has changed. Fix the cause and run again."
  fi
  if ((waited == 0)); then
    cat "$WORK/export.err" >&2
    info "the grant on gs://${BUCKET_ONLY} hasn't taken effect yet (a new grant can take a few minutes); waiting for it, up to $((GRANT_WAIT_SECONDS / 60)) minutes."
  fi
  ((waited < GRANT_WAIT_SECONDS)) \
    || die "Cloud SQL still can't write to gs://${BUCKET_ONLY} after $((GRANT_WAIT_SECONDS / 60)) minutes. Nothing has changed. Check that the bucket grants $SQL_SA roles/storage.objectAdmin (gcloud storage buckets get-iam-policy gs://${BUCKET_ONLY}), then run again."
  sleep "$GRANT_WAIT_INTERVAL"
  waited=$((waited + GRANT_WAIT_INTERVAL))
  info "trying the export again (${waited}s waited)"
done
cat "$WORK/export.err" >&2
info "backup complete: $EXPORT_URI"

# --- step 4: the pack services ---------------------------------------------

step "4. Pack services"
info "nothing to build: $(pack_step_said)"

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
  || die "the plan check failed (above), so nothing was applied. (The backup stays at $EXPORT_URI.)"
if [[ $SWITCH == true ]]; then
  printf '\n'
  warn "This plan moves the deployment to a pack service for each deployment. With the one pack service, from the apply until each pack is deployed again (the steps after it say how), calls to a deployed pack's tools are refused: pack-route-missing, then, for about a minute, pack-endpoint-pending. If that matters now, answer no and run this again at a quiet hour."
  if [[ $TENANCY == "multi" ]]; then
    warn "With tenancy = \"multi\", stop your own orchestrator before you answer yes: from the apply on, the module's makes each new deployment's service. The services yours made keep serving until each tenant deploys again."
  fi
fi

# >>> same in both modules: yes-prompt
printf '\n'
warn "Review the plan above. It points the server (and pack, if rebuilt) at the new image. yes applies exactly this plan, and keeps it as $PLAN_KEPT."
printf 'Apply this plan? Type yes to proceed: '
reply=""
IFS= read -r reply || reply=""
# <<<
[[ $reply == "yes" ]] || die "not confirmed — nothing was applied. (The backup stays at $EXPORT_URI.)"

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

step "6. Waiting for the new revision to be ready"
ready=false
for ((i = 1; i <= POLL_TRIES; i++)); do
  svc_json="$(gcloud run services describe "$SERVER_SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json 2>/dev/null || true)"
  if [[ -n $svc_json ]]; then
    state="$(jq -r '.terminalCondition.state // (.status.conditions[]? | select(.type=="Ready") | .status) // ""' <<<"$svc_json")"
    latest_ready="$(jq -r '.latestReadyRevision // .status.latestReadyRevisionName // ""' <<<"$svc_json")"
    latest_created="$(jq -r '.latestCreatedRevision // .status.latestCreatedRevisionName // ""' <<<"$svc_json")"
    if [[ ( $state == "CONDITION_SUCCEEDED" || $state == "True" ) && -n $latest_ready && $latest_ready == "$latest_created" ]]; then
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
info "Backup kept at $EXPORT_URI; the previous var-file at $VARFILE_BACKUP; the plan applied at $PLAN_KEPT."
if [[ $SWITCH == true ]]; then print_switch_steps; fi
exit 0
