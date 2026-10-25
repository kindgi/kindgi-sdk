#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Upgrade a small dev Kindgi deployment (network_mode = "none") to a newer
# runtime, in order: check, back up, upgrade. It never changes the running
# deployment before you type "yes" at the plan, and it never rolls back by
# itself — if the new revision doesn't come up it prints the commands to go
# back and stops.
#
# Scope: the small dev shape from README "A small dev deployment" — no VPC, and
# a public-IP Cloud SQL instance reached over /cloudsql. Any other network_mode
# is out of scope (the pre-upgrade check job would need VPC egress); the script
# says so and stops.
#
# Run it from this module directory, after `terraform init`, as the identity
# that deploys the module (it reads the running service and the module's state,
# backs up the database, mirrors the new image, and plans/applies the module).
#
# What it changes besides the deployment itself:
#   - It grants the Cloud SQL instance's service account roles/storage.objectAdmin
#     on the backup bucket (Cloud SQL writes the export as that account). The
#     grant stays on the bucket. A new grant can take a few minutes to take
#     effect; until it does, the export waits for it.
#   - It rewrites the server_image line (and pack_image, with --pack-dir) in your
#     var-file, so a later plain apply keeps the new image. The previous file is
#     kept next to it as <var-file>.pre-upgrade-<UTC time>; if you don't confirm
#     the plan, the var-file is put back.
#
# Usage:
#   ./upgrade.sh --var-file dev.tfvars \
#                --runtime-digest sha256:<64 hex> \
#                --backup-bucket gs://<bucket>[/<prefix>] \
#                [--to 0.1.10] [--from 0.1.8|0.1.9] \
#                [--pack-dir <path to the pack project>] \
#                [--check-tenant <uuid>]
#
#   --var-file         The tfvars the deployment already uses (.tfvars or
#                      .tfvars.json), with server_image on one line. Read for
#                      its variables and passed to `terraform plan`/`apply`.
#   --runtime-digest   The release digest of the runtime being upgraded to,
#                      from its release notes (sha256:…). Checked against the
#                      release's tag, then mirrored into the deployment's
#                      Artifact Registry by its whole index.
#   --backup-bucket    A GCS bucket (optionally a prefix) the database export
#                      is written to. The export is one database, never an
#                      instance backup.
#   --to               The target runtime version (default 0.1.10; an rc such
#                      as 0.1.10-rc.1 works too). This script knows the steps
#                      up to 0.1.10; for a later release, use this script as
#                      of that release's @kindgi/sdk@<version> tag.
#   --from             Assert the current version when it can't be read from the
#                      deployment (no version tag on the running image).
#   --pack-dir         Rebuild and push the pack from here with `kindgi build`
#                      (only if the deployment has a pack service). Without it,
#                      the runtime is upgraded alone and the pack is left as is.
#   --check-tenant     Limit the runtime's read-only checks to one tenant.

set -euo pipefail

# gcloud writes its answers (which can include secret values piped through it)
# to a per-invocation log file unless this is set. Keep it off for every call.
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true

# Anything this script writes to disk (the plan, the resolved config) may name
# instances, service accounts and bucket paths — keep it to this user.
umask 077

readonly RUNTIME_REPO="quay.io/kindgi/runtime"
readonly VERSION_FLOOR="0.1.8"         # upgrades from before this are refused
readonly DEFAULT_TARGET="0.1.10"
# Releases this script knows the upgrade steps for, oldest first.
readonly KNOWN_RELEASES=("0.1.9" "0.1.10")

# How long to wait for the new revision to become ready (step 6).
readonly POLL_INTERVAL=10
readonly POLL_TRIES=60

# How long to wait for a new bucket grant to reach Cloud SQL (step 3): Google
# says an IAM change usually takes effect in 2 minutes, and can take 7.
readonly GRANT_WAIT_INTERVAL=15
readonly GRANT_WAIT_SECONDS=420

# --- small helpers ----------------------------------------------------------

die() { printf 'upgrade: %s\n' "$*" >&2; exit 1; }
warn() { printf 'upgrade: %s\n' "$*" >&2; }
step() { printf '\n== %s ==\n' "$*"; }
info() { printf '  %s\n' "$*"; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "this needs \"$c\" on your PATH."
  done
}

# A version as a plain base-10 integer for comparison, with an rc ranked below
# its final: 0.1.10-rc.1 -> 1010001, 0.1.10 -> 1010999. 10# keeps a
# zero-padded component from being read as octal.
ver_num() {
  local v="${1%%-*}" rc=999 a b c
  if [[ $1 =~ -rc\.([0-9]+)$ ]]; then rc="${BASH_REMATCH[1]}"; fi
  local IFS=.
  read -r a b c <<<"$v"
  printf '%d' "$(( ((10#${a:-0}) * 1000000 + (10#${b:-0}) * 1000 + (10#${c:-0})) * 1000 + 10#$rc ))"
}

is_semver() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; }

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

# Rewrite one variable's value in the var-file in place (its mode is kept),
# then read it back.
varfile_set() {
  local name="$1" value="$2" tmp="$WORK/varfile.new"
  [[ $value =~ ^[A-Za-z0-9./:@_-]+$ ]] || die "refusing to write an unexpected $name value \"$value\"."
  if [[ $VARFILE_JSON == true ]]; then
    jq --arg n "$name" --arg v "$value" '.[$n] = $v' "$VAR_FILE" >"$tmp"
  else
    sed -E "s|^([[:space:]]*${name}[[:space:]]*=[[:space:]]*)\"[^\"]*\"|\1\"${value}\"|" "$VAR_FILE" >"$tmp"
  fi
  cat "$tmp" >"$VAR_FILE"
  [[ "$(varfile_value "$name")" == "$value" ]] \
    || die "couldn't write $name into $VAR_FILE."
}

# The go-back path, printed (never run) when the apply fails or the new revision
# doesn't come up. It reads variables set by the time it's called (steps 5/6).
# Migrations only go forward, so going back restores the backup into a FRESH
# database — never points an old runtime at the migrated one.
print_go_back() {
  local fresh="${DATABASE_NAME}_r$(date -u +%Y%m%d)"
  local ledger="erasures-$(date -u +%F).json"
  cat <<EOT >&2

======================================================================
The upgrade did not come up. NOTHING has been rolled back automatically.
Migrations only go forward, so do not point an old runtime at the
migrated database — restore the backup into a FRESH database instead.

To go back:

 1. First, export the erasure ledger from the server serving now. It holds
    every erasure so far, including any made after the backup. With the
    CLI signed in to ${SERVER_URL}:
      npx --yes @kindgi/cli@0.1 memory erasures export --out=${ledger}
    If no server answers, the backup's own ledger is all there is: an
    erasure made after ${STAMP} can't be replayed.

 2. A fresh database on the same instance:
      gcloud sql databases create ${fresh} --instance=${DB_INSTANCE} --project=${PROJECT}

 3. Import the backup into it (the instance's service account already has
    objectAdmin on gs://${BUCKET_ONLY}, from the backup step):
      gcloud sql import sql ${DB_INSTANCE} ${EXPORT_URI} \\
        --database=${fresh} --user=kindgi --project=${PROJECT}

 4. Point the server at the fresh database: add a new version of the secret
    ${DB_URL_SECRET}, with host=/cloudsql/${SQL_CONNECTION_NAME} and dbname
    ${fresh}. Set the password as in README step 3, never in a command's
    arguments. (Don't change database_name instead: the module would drop
    the migrated database, then fail to create ${fresh}.)

 5. Put the old image(s) back and apply. The new revision reads the new
    secret version when it starts:
      cp ${VARFILE_BACKUP} ${VAR_FILE}
      terraform apply -var-file=${VAR_FILE}

 6. Before anyone uses it, replay the erasures:
      npx --yes @kindgi/cli@0.1 memory erasures replay ${ledger}
    A replay matches only when the server has KINDGI_ERASURE_LEDGER_KEY
    (server_secret_env); without it, every erasure comes back unmatched.
    With secrets_backend = "postgres", also run the old image's
    "check stored-secrets": a job like the pre-upgrade checks, but with the
    server's secrets settings (KINDGI_SECRETS_BACKEND, its KMS key and the
    AAD key) as well as the database URL.
======================================================================
EOT
}

# --- arguments --------------------------------------------------------------

VAR_FILE=""
RUNTIME_DIGEST=""
BACKUP_BUCKET=""
TARGET="$DEFAULT_TARGET"
FROM_OVERRIDE=""
PACK_DIR=""
CHECK_TENANT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) VAR_FILE="${2:-}"; shift 2 ;;
    --runtime-digest) RUNTIME_DIGEST="${2:-}"; shift 2 ;;
    --backup-bucket) BACKUP_BUCKET="${2:-}"; shift 2 ;;
    --to) TARGET="${2:-}"; shift 2 ;;
    --from) FROM_OVERRIDE="${2:-}"; shift 2 ;;
    --pack-dir) PACK_DIR="${2:-}"; shift 2 ;;
    --check-tenant) CHECK_TENANT="${2:-}"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown argument \"$1\" (see --help)." ;;
  esac
done

[[ -n $VAR_FILE ]] || die "--var-file is required (see --help)."
[[ -f $VAR_FILE ]] || die "--var-file \"$VAR_FILE\" doesn't exist."
[[ -n $RUNTIME_DIGEST ]] || die "--runtime-digest is required (see --help)."
[[ $RUNTIME_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "--runtime-digest must look like sha256:<64 hex>."
[[ -n $BACKUP_BUCKET ]] || die "--backup-bucket is required (see --help)."
[[ $BACKUP_BUCKET =~ ^gs://[a-z0-9][-a-z0-9._]*(/.*)?$ ]] || die "--backup-bucket must look like gs://<bucket>[/<prefix>]."
is_semver "$TARGET" || die "--to \"$TARGET\" isn't a version like 0.1.10."
# A later release may need steps this copy doesn't have, so it isn't run past
# the newest release it knows (an rc counts as its final).
NEWEST_KNOWN="${KNOWN_RELEASES[${#KNOWN_RELEASES[@]}-1]}"
[[ "$(ver_num "${TARGET%%-*}")" -le "$(ver_num "$NEWEST_KNOWN")" ]] \
  || die "--to $TARGET: this script knows the steps up to $NEWEST_KNOWN. Use this script as of the @kindgi/sdk@${TARGET%%-*} tag (before it's out, that release's newest @kindgi/sdk@${TARGET%%-*}-rc tag)."
if [[ -n $FROM_OVERRIDE ]]; then is_semver "$FROM_OVERRIDE" || die "--from \"$FROM_OVERRIDE\" isn't a version like 0.1.8."; fi
if [[ -n $PACK_DIR ]]; then [[ -d $PACK_DIR ]] || die "--pack-dir \"$PACK_DIR\" isn't a directory."; fi

VARFILE_JSON=false
case "$VAR_FILE" in *.json) VARFILE_JSON=true ;; esac

require_cmd terraform gcloud jq docker

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
# come from `terraform console`, which evaluates them without reading state.

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
VARS_EXPR='jsonencode({project_id=var.project_id, region=var.region, name_prefix=var.name_prefix, network_mode=var.network_mode, database_host_instance=var.database_host_instance, database_name=var.database_name, secrets_backend=var.secrets_backend, secrets_aad_key_version=var.secrets_aad_key_version, tenancy=var.tenancy, server_image=var.server_image, pack_image=var.pack_image, database_instance=var.database_instance})'
VARS_RAW="$(terraform console -var-file="$VAR_FILE" <<<"$VARS_EXPR" 2>"$WORK/console.err")" \
  || die "couldn't read the module's variables with 'terraform console'. $(cat "$WORK/console.err")"
VARS="$(jq 'fromjson' <<<"$VARS_RAW")" \
  || die "couldn't parse the module's variables from terraform console."

PROJECT="$(jq -r '.project_id' <<<"$VARS")"
REGION="$(jq -r '.region' <<<"$VARS")"
NAME_PREFIX="$(jq -r '.name_prefix' <<<"$VARS")"
NETWORK_MODE="$(jq -r '.network_mode' <<<"$VARS")"
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

# This script is for the small dev shape. Any other network_mode reaches its
# database or pack differently, and the check job here has no VPC egress.
[[ $NETWORK_MODE == "none" ]] \
  || die "this script covers the small dev shape (network_mode = \"none\") only; this deployment uses \"$NETWORK_MODE\". Upgrade it by hand (README \"Upgrading\")."

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

info "project         $PROJECT"
info "region          $REGION"
info "server service  $SERVER_SERVICE"
info "database        $DATABASE_NAME on instance $DB_INSTANCE"
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
    if is_semver "$tag"; then
      if [[ -z $CURRENT || "$(ver_num "$tag")" -gt "$(ver_num "$CURRENT")" ]]; then CURRENT="$tag"; fi
    fi
  done
  if [[ -n $CURRENT ]]; then
    info "read $CURRENT from the mirrored image's tag"
  else
    die "couldn't read the version from the running image (no version tag on its digest). Re-run with --from <0.1.8|0.1.9>."
  fi
fi

if [[ "$(ver_num "$CURRENT")" -lt "$(ver_num "$VERSION_FLOOR")" ]]; then
  die "the deployment is on $CURRENT; this script upgrades from $VERSION_FLOOR or later. Upgrade to $VERSION_FLOOR first."
fi
if [[ "$(ver_num "$CURRENT")" -ge "$(ver_num "$TARGET")" ]]; then
  die "the deployment is already on $CURRENT, at or past the target $TARGET. Nothing to do."
fi

# The releases this upgrade crosses (current < r <= target's final, so an rc
# target gets its release's steps), from what we know.
CROSSED=()
for r in "${KNOWN_RELEASES[@]}"; do
  if [[ "$(ver_num "$r")" -gt "$(ver_num "$CURRENT")" && "$(ver_num "$r")" -le "$(ver_num "${TARGET%%-*}")" ]]; then
    CROSSED+=("$r")
  fi
done
[[ ${#CROSSED[@]} -gt 0 ]] || die "no known upgrade steps between $CURRENT and $TARGET; this script knows ${KNOWN_RELEASES[*]}."
info "upgrading $CURRENT -> $TARGET, crossing: ${CROSSED[*]}"

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
  if [[ "$(jq -r '.settings.ipConfiguration.ipv4Enabled // false' <<<"$sql_json")" != "true" ]]; then
    fail_check "instance $DB_INSTANCE has no public IP; the small dev shape reaches it over /cloudsql."
  fi
fi

# A var-file from a module copy before secrets_aad_key_version stops at the
# plan, after the export. Say so now.
if [[ $SECRETS_BACKEND == "postgres" && -z $SECRETS_AAD_KEY_VERSION ]]; then
  fail_check "secrets_backend = \"postgres\" needs secrets_aad_key_version in $VAR_FILE: the version of ${NAME_PREFIX}-secrets-aad-key the server reads now, never \"latest\" (README \"Upgrading\")."
fi

# The release's own tag must be the digest given, or the mirror below would put
# the version tag (which a later run's step 1 reads) on the wrong image.
quay_digest="$(docker buildx imagetools inspect "${RUNTIME_REPO}:${TARGET}" --format '{{json .Manifest}}' 2>"$WORK/inspect.err" | jq -r '.digest // empty' 2>/dev/null || true)"
if [[ -z $quay_digest ]]; then
  fail_check "couldn't read ${RUNTIME_REPO}:${TARGET}. $(cat "$WORK/inspect.err")"
elif [[ $quay_digest != "$RUNTIME_DIGEST" ]]; then
  fail_check "${RUNTIME_REPO}:${TARGET} is $quay_digest, not the --runtime-digest $RUNTIME_DIGEST. Check the pair against the release notes."
fi

# Stop on a failed precondition before spending anything: no image is mirrored
# and no check job runs if one fails.
if [[ $CHECK_FAILED == true ]]; then
  die "a precondition failed (above). Nothing was mirrored, backed up or changed. Fix it and run again."
fi

# 2b. Mirror the new runtime image into the deployment's Artifact Registry, so
# the read-only check job (and step 5) can pull it (Cloud Run can't pull from
# quay). The mirror keeps the release digest. This adds an image; it serves
# nothing until step 5.
step "Mirroring runtime ${TARGET} into Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null 2>&1 || true
docker buildx imagetools create --tag "${IMAGE_REPOSITORY}/runtime:${TARGET}" \
  "${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST}" \
  || die "couldn't mirror ${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST} into ${IMAGE_REPOSITORY}. Is 'kindgi auth registry' done and do you have push access?"
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
# A job name is at most 63 characters; the id below adds 18 to the prefix,
# and name_prefix has no length limit of its own.
job_prefix="${NAME_PREFIX:0:45}"
while [[ $job_prefix == *- ]]; do job_prefix="${job_prefix%-}"; done
check_suffix_provider_keys="pk"
check_suffix_secret_scopes="ss"
check_suffix_mcp_header_credentials="mhc"
for check in provider-keys secret-scopes mcp-header-credentials; do
  suffix_var="check_suffix_${check//-/_}"
  job="${job_prefix}-upgchk-${check_stamp}-${!suffix_var}"
  args="check,${check}"
  if [[ -n $CHECK_TENANT ]]; then args="${args},--tenant,${CHECK_TENANT}"; fi
  if gcloud run jobs create "$job" \
      --project="$PROJECT" --region="$REGION" \
      --image="$NEW_SERVER_IMAGE" \
      --service-account="$SERVER_SA" \
      --set-cloudsql-instances="$SQL_CONNECTION_NAME" \
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

# 2d. Steps that need an operator's eye or the app's source — printed, not run.
step "Steps to confirm by hand (per release crossed)"
for r in "${CROSSED[@]}"; do
  case "$r" in
    0.1.9)
      cat <<'EOT'
  0.1.9:
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
  0.1.10:
   - If any agent sets conversationPolicy.autoCloseAfterInactiveSeconds, remove
     it before you rebuild the pack. In the pack source:
       grep -rn "autoCloseAfterInactiveSeconds" src/
   - Before re-registering a tool or MCP endpoint, drop "secretScopes" from any
     definition you read back from the server.
EOT
      ;;
  esac
done

# Not applicable on this shape — said plainly so nobody goes looking.
step "Not applicable on Cloud Run (skipped)"
info "PgBouncer minimum version — the small dev shape has no PgBouncer."
info "The secret-manager secret-name grammar — this module stores secrets under \"$SECRETS_BACKEND\", never KINDGI_SECRETS_BACKEND=secret-manager."

if [[ $CHECK_FAILED == true ]]; then
  die "one or more checks failed (above). Nothing was backed up or changed. Fix them and run again."
fi
info "all automated checks passed."

# --- step 3: back up the database -------------------------------------------
# One database, as an export — never an instance backup, which would be the
# app's whole instance and whose restore would roll the app's data back too.

step "3. Backing up the \"$DATABASE_NAME\" database"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EXPORT_URI="${BACKUP_BUCKET%/}/${NAME_PREFIX}-${DATABASE_NAME}-${CURRENT}-${STAMP}.sql.gz"

# The export is written by the instance's own service account, which needs
# object-create on the bucket. Grant it (idempotent), scoped to this bucket.
BUCKET_ONLY="${BACKUP_BUCKET#gs://}"; BUCKET_ONLY="${BUCKET_ONLY%%/*}"
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
  warn "the deployment has a pack service, but no --pack-dir was given: the pack image is left unchanged. If 0.1.10 needs a pack rebuilt (e.g. to drop production-only installs or secretScopes), rebuild it with 'kindgi build --local --push' and run again with --pack-dir."
else
  info "no pack service (tenancy=$TENANCY); nothing to build."
fi

# --- step 5: plan and apply -------------------------------------------------
# The new image(s) go into the var-file itself, so what's planned is what the
# file says from now on. Until the apply starts, the EXIT trap puts it back.

step "5. Terraform plan"
VARFILE_BACKUP="${VAR_FILE}.pre-upgrade-${STAMP}"
cp "$VAR_FILE" "$VARFILE_BACKUP"
VARFILE_PENDING=true
varfile_set server_image "$NEW_SERVER_IMAGE"
if [[ $REBUILD_PACK == true ]]; then varfile_set pack_image "$NEW_PACK_IMAGE"; fi
info "$VAR_FILE now pins the new image(s); the previous copy is $VARFILE_BACKUP."

PLAN="$WORK/upgrade.tfplan"
terraform plan -var-file="$VAR_FILE" -out="$PLAN" \
  || die "terraform plan failed. Nothing has changed."

printf '\n'
warn "Review the plan above. It points the server (and pack, if rebuilt) at the new image."
printf 'Apply this plan? Type yes to proceed: '
reply=""
IFS= read -r reply || reply=""
[[ $reply == "yes" ]] || die "not confirmed — nothing was applied. (The backup stays at $EXPORT_URI.)"

step "Applying"
# From here the deployment may change, so the var-file keeps the new image(s).
VARFILE_PENDING=false
if ! terraform apply "$PLAN"; then
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
info "Backup kept at $EXPORT_URI; the previous var-file at $VARFILE_BACKUP."
exit 0
