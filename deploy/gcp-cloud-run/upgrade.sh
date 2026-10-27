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
# Usage:
#   ./upgrade.sh --var-file dev.tfvars [--var-file <another var file> ...] \
#                --runtime-digest sha256:<64 hex> \
#                --backup-bucket gs://<bucket>[/<prefix>] \
#                [--to 0.3.0] [--from <version>] \
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
#                      release's tag, then mirrored into the deployment's
#                      Artifact Registry by its whole index.
#   --backup-bucket    A GCS bucket (optionally a prefix) the database export
#                      is written to. The export is one database, never an
#                      instance backup.
#   --to               The target runtime version, 0.2.0 or later (default
#                      0.3.0). An rc such as 0.3.0-rc.0 works too, and so does
#                      a server-only release such as 0.2.0.1: a server fix for
#                      0.2.0, with no SDK release of its own. Earlier
#                      releases aren't on registry.kindgi.com: for those, use
#                      this script as of the @kindgi/sdk@0.1.10 tag. This
#                      script knows the steps up to 0.3.0; for a later
#                      release, use this script as of that release's
#                      @kindgi/sdk@<version> tag (for X.Y.Z.N, X.Y.Z's tag)
#                      or, before that release is out, its newest
#                      @kindgi/sdk@<version>-rc.N tag.
#                      Below 0.3.0, the plan still makes this module's
#                      changes up to 0.3.0, with the older runtime; that
#                      release's tag keeps the module at its own.
#   --from             Assert the current version (0.1.10, say, or 0.2.0.1)
#                      when it can't be read from the deployment (no version
#                      tag on the running image).
#   --pack-dir         Rebuild and push the pack from here with `kindgi build`
#                      (only if the deployment has a pack service). Without it,
#                      the runtime is upgraded alone and the pack is left as is.
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

readonly RUNTIME_REPO="registry.kindgi.com/kindgi/runtime"
readonly VERSION_FLOOR="0.1.8"         # upgrades from before this are refused
readonly TARGET_FLOOR="0.2.0"          # the first release on registry.kindgi.com
# Releases this script knows the upgrade steps for, oldest first.
readonly KNOWN_RELEASES=("0.1.9" "0.1.10" "0.2.0" "0.3.0")
# The newest of them.
readonly DEFAULT_TARGET="${KNOWN_RELEASES[${#KNOWN_RELEASES[@]}-1]}"

# How long to wait for the new revision to become ready (step 6).
readonly POLL_INTERVAL=10
readonly POLL_TRIES=60

# How long to wait for a new bucket grant to reach Cloud SQL (step 3): Google
# says an IAM change typically takes effect in 2 minutes, and potentially 7
# minutes or longer.
readonly GRANT_WAIT_INTERVAL=15
readonly GRANT_WAIT_SECONDS=420

# --- small helpers ----------------------------------------------------------

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

 2. Before the database changes, put the old image(s) back and save the
    plan, then read it:
      cp $(printf '%q' "$VARFILE_BACKUP") $(printf '%q' "$VAR_FILE")
      (umask 077 && terraform plan$(var_file_flags) -out=back.tfplan)
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

# The names a run gives what it creates, so a dry run lists the ones a real
# run uses. A check job's name is at most 63 characters: the prefix is cut to
# 45 (the rest adds 18) and loses a trailing "-". $2 is the run's HHMMSS.
readonly CHECKS=("provider-keys" "secret-scopes" "mcp-header-credentials")
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
varfile_backup_name() { printf '%s.pre-upgrade-%s' "$VAR_FILE" "$1"; }
# The plan a run applies, kept next to the var-file's copy.
plan_kept_name() { printf '%s.upgrade-%s.tfplan' "$VAR_FILE" "$1"; }

# --- arguments --------------------------------------------------------------

VAR_FILES=()
RUNTIME_DIGEST=""
BACKUP_BUCKET=""
TARGET="$DEFAULT_TARGET"
FROM_OVERRIDE=""
PACK_DIR=""
CHECK_TENANT=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) VAR_FILES+=("${2:-}"); shift 2 ;;
    --runtime-digest) RUNTIME_DIGEST="${2:-}"; shift 2 ;;
    --backup-bucket) BACKUP_BUCKET="${2:-}"; shift 2 ;;
    --to) TARGET="${2:-}"; shift 2 ;;
    --from) FROM_OVERRIDE="${2:-}"; shift 2 ;;
    --pack-dir) PACK_DIR="${2:-}"; shift 2 ;;
    --check-tenant) CHECK_TENANT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; ME="upgrade (dry run)"; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown argument \"$1\" (see --help)." ;;
  esac
done

[[ ${#VAR_FILES[@]} -gt 0 ]] || die "--var-file is required (see --help)."
for f in "${VAR_FILES[@]}"; do
  [[ -n $f && -f $f ]] || die "--var-file \"$f\" doesn't exist."
done
[[ -n $RUNTIME_DIGEST ]] || die "--runtime-digest is required (see --help)."
[[ $RUNTIME_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "--runtime-digest must look like sha256:<64 hex>."
[[ -n $BACKUP_BUCKET ]] || die "--backup-bucket is required (see --help)."
[[ $BACKUP_BUCKET =~ ^gs://[a-z0-9][-a-z0-9._]*(/.*)?$ ]] || die "--backup-bucket must look like gs://<bucket>[/<prefix>]."
BUCKET_ONLY="${BACKUP_BUCKET#gs://}"; BUCKET_ONLY="${BUCKET_ONLY%%/*}"
is_version "$TARGET" || die "--to \"$TARGET\" isn't a version like 0.2.0, 0.2.0-rc.0 or 0.2.0.1."
TARGET_RELEASE="$(release_of "$TARGET")"
[[ "$(ver_num "$TARGET_RELEASE")" -ge "$(ver_num "$TARGET_FLOOR")" ]] \
  || die "--to $TARGET: this script copies the runtime from registry.kindgi.com, which has $TARGET_FLOOR and later. For an earlier release, use this script as of the @kindgi/sdk@0.1.10 tag."
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

require_cmd terraform gcloud jq docker

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
VARS_EXPR='jsonencode({project_id=var.project_id, region=var.region, name_prefix=var.name_prefix, network_mode=var.network_mode, vpc_connector=var.vpc_connector, database_private_network=var.database_private_network, database_host_instance=var.database_host_instance, database_name=var.database_name, secrets_backend=var.secrets_backend, secrets_aad_key_version=var.secrets_aad_key_version, tenancy=var.tenancy, server_image=var.server_image, pack_image=var.pack_image, database_instance=var.database_instance})'
VARS_RAW="$(terraform console "${TF_VAR_FILE_ARGS[@]}" <<<"$VARS_EXPR" 2>"$WORK/console.err")" \
  || die "couldn't read the module's variables with 'terraform console'. $(cat "$WORK/console.err")"
VARS="$(jq 'fromjson' <<<"$VARS_RAW")" \
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
DATABASE_HOST_INSTANCE="$(jq -r '.database_host_instance // ""' <<<"$VARS")"
OLD_SERVER_IMAGE="$(jq -r '.server_image' <<<"$VARS")"
OLD_PACK_IMAGE="$(jq -r '.pack_image // ""' <<<"$VARS")"
DATABASE_INSTANCE_NAME="$(jq -r '.database_instance.name // ""' <<<"$VARS")"
DATABASE_INSTANCE_URL_SECRET="$(jq -r '.database_instance.url_secret // ""' <<<"$VARS")"

SERVER_SERVICE="${NAME_PREFIX}-server"

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

HAS_PACK=false
if [[ -n $OLD_PACK_IMAGE && $TENANCY == "single" ]]; then HAS_PACK=true; fi
REBUILD_PACK=false
if [[ $HAS_PACK == true && -n $PACK_DIR ]]; then REBUILD_PACK=true; fi

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
if [[ "$(ver_num "$TARGET_RELEASE")" -lt "$(ver_num "$NEWEST_KNOWN")" ]]; then
  warn "the module here is this copy's, as of $NEWEST_KNOWN: the plan also makes its changes for the releases after $TARGET_RELEASE (its steps to confirm by hand list them), with the $TARGET runtime. To keep the module at $TARGET_RELEASE, use this script as of $(sdk_tag "$TARGET_RELEASE")."
fi

NEW_SERVER_IMAGE="${IMAGE_REPOSITORY}/runtime@${RUNTIME_DIGEST}"
NEW_PACK_IMAGE="$OLD_PACK_IMAGE"

# --- step 2: checks ---------------------------------------------------------
# Everything here is read-only against the deployment. Mirroring the new image
# (below) only adds to Artifact Registry; it changes nothing that serves. The
# first change to the running deployment is the apply in step 5.

step "2. Pre-upgrade checks"

CHECK_FAILED=false
fail_check() { CHECK_FAILED=true; warn "CHECK FAILED: $*"; }

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
     pins to 0.2.0 first: --pack-dir builds what they say. A Python pack made
     by a 0.1 CLI pins kindgi>=0.1,<0.2 and kindgi-cli>=0.1,<0.2:
       uv add "kindgi==0.2.0" && uv add --dev "kindgi-cli==0.2.0"
EOT
      ;;
  esac
}

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
   - With a pack service, the plan also changes it in place, with or without
     --pack-dir: CPU only while a call runs, a start boost, and quicker
     readiness checks.
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
  step "Not applicable on Cloud Run (skipped)"
  info "PgBouncer minimum version — this module has no PgBouncer."
  info "The secret-manager secret-name grammar — this module stores secrets under \"$SECRETS_BACKEND\", never KINDGI_SECRETS_BACKEND=secret-manager."
}

# 5. The plan's check. Besides the new image(s), a plan may change only what
# the module's releases after the current one (MODULE_CROSSED) change in
# place, as their steps to confirm by hand say (module_changes):
# "<resource type>.<name> <attribute path>", the path without list indices,
# an env var or a database flag by its name. The module's own changes in that
# release (services.tf, data.tf, foundation.tf), each made in place.
plan_allowed_changes() {
  local r
  printf '%s\n' "google_cloud_run_v2_service.server template.containers.image"
  if [[ $REBUILD_PACK == true ]]; then printf '%s\n' "google_cloud_run_v2_service.pack template.containers.image"; fi
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
        ;;
    esac
  done
}

# Every change in a plan (terraform show -json) that $allowed doesn't name,
# one line each: a create, delete, replace or forget by what it does; an
# update by each attribute it changes, a value it knows or one known only
# after the apply. Never a value: a plan holds the variables' values, secret
# ones too. An env var or a database flag is keyed by its name, so one added
# or dropped from a list says which, and moves no other; one known only after
# the apply is named from the plan's after.
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
  | select($c.actions != ["no-op"] and $c.actions != ["read"])
  | if $c.actions != ["update"] then "\($addr): \($c.actions | act)"
    else
      ($c.before // {} | flat) as $b | ($c.after // {} | flat) as $a
      | ([$b, $a] | map(keys) | add | unique | map(. as $k | select($b[$k] != $a[$k])))
        + [$c.after_unknown // {} | paths(. == true) | named($c.after // {}) | tojson]
      | map(said) | unique | .[]
      | select(. as $w | $allowed | any(.[]; .key == $key and (.path as $p | $w == $p or ($w | startswith($p + ".")))) | not)
      | "\($addr): changes \(.)"
    end'

# The image a plan gives a Cloud Run service ($n: server or pack), or nothing.
readonly PLAN_IMAGE_JQ='[.resource_changes[]? | select(.type == "google_cloud_run_v2_service" and .name == $n) | .change.after.template[0].containers[0].image // empty] | first // ""'

# Check a saved plan: it must point the server (and a rebuilt pack, with $2
# true) at the new image, and change nothing else plan_allowed_changes
# doesn't name. Says what's wrong and returns 1 if not.
check_plan() {
  local plan="$1" expect_pack="$2" json="$WORK/plan.json" allowed found image ok=true
  terraform show -json "$plan" >"$json" 2>"$WORK/show.err" \
    || { warn "couldn't read the saved plan with 'terraform show -json'. $(cat "$WORK/show.err")"; return 1; }
  allowed="$(plan_allowed_changes | jq -R -s -c 'split("\n") | map(select(length > 0) | split(" ") | {key: .[0], path: .[1]})')"
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
    info "plan check: it changes the image(s), and only what the releases crossed change in place."
    return 0
  fi
  warn "Nothing above was applied. A var file left off the command (a pack's env, say) is what usually does this: give each file the deployment uses its own --var-file. If the changes are yours (a variable you changed, say), apply them on the release it runs now with a plan you review, then run this again."
  return 1
}

# A dry run stops here. It lists what the steps below would change, with the
# names they'd use, prints the steps to confirm by hand, and shows the plan for
# the new image, taken with no state lock and saved only in $WORK. It changes
# nothing.
if [[ $DRY_RUN == true ]]; then
  info "the read-only checks passed."
  [[ -n $SQL_SA ]] || die "couldn't read instance $DB_INSTANCE's service account; a real run would stop at the backup."
  varfile_value_ok server_image "$NEW_SERVER_IMAGE"
  if [[ $REBUILD_PACK == true ]]; then require_cmd kindgi; fi

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
  if [[ $REBUILD_PACK == true ]]; then
    info "4. rebuild and push the pack from ${PACK_DIR} (kindgi build --local --push --env dev)"
  elif [[ $HAS_PACK == true ]]; then
    info "4. nothing: without --pack-dir the pack image stays as it is"
  else
    info "4. nothing: no pack service"
  fi
  info "5. copy ${VAR_FILE} to $(varfile_backup_name "<YYYYMMDDTHHMMSSZ>")"
  info "   set server_image = \"${NEW_SERVER_IMAGE}\" in ${VAR_FILE}"
  if [[ $REBUILD_PACK == true ]]; then
    info "   set pack_image to the rebuilt pack (its digest is known only after the build)"
  fi
  info "   plan, check the plan as below, show it and ask you to type yes"
  info "   apply exactly that plan, kept as $(plan_kept_name "<YYYYMMDDTHHMMSSZ>")"
  info "6. wait for the new revision of ${SERVER_SERVICE}"

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

# 2d. The steps to confirm by hand, and what doesn't apply here.
print_by_hand_steps

if [[ $CHECK_FAILED == true ]]; then
  die "one or more checks failed (above). Nothing was backed up or changed. Fix them and run again."
fi
info "all automated checks passed."

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

# --- step 4: the pack image (if any) ----------------------------------------

step "4. Pack image"
if [[ $REBUILD_PACK == true ]]; then
  require_cmd kindgi
  info "rebuilding the pack from $PACK_DIR"
  ( cd "$PACK_DIR" && kindgi build --local --push --env dev ) \
    || die "the pack build failed. The runtime image is mirrored and the backup is taken; fix the pack and run again."
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
else
  info "no pack service (tenancy=$TENANCY); nothing to build."
fi

# --- step 5: plan and apply -------------------------------------------------
# The new image(s) go into the var-file itself, so what's planned is what the
# file says from now on. Until the apply starts, the EXIT trap puts it back.

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
check_plan "$PLAN" "$REBUILD_PACK" \
  || die "the plan check failed (above), so nothing was applied. (The backup stays at $EXPORT_URI.)"

printf '\n'
warn "Review the plan above. It points the server (and pack, if rebuilt) at the new image. yes applies exactly this plan, and keeps it as $PLAN_KEPT."
printf 'Apply this plan? Type yes to proceed: '
reply=""
IFS= read -r reply || reply=""
[[ $reply == "yes" ]] || die "not confirmed — nothing was applied. (The backup stays at $EXPORT_URI.)"

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
exit 0
