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
# Scope: the small dev shape from README "A small dev deployment" — a public-IP
# Cloud SQL instance reached over /cloudsql. Private-IP deployments are out of
# scope (the pre-upgrade check job would need VPC egress); the script says so
# and stops.
#
# Run it from this module directory, after `terraform init`, as the identity
# that deploys the module (it reads the running service and the module's state,
# backs up the database, mirrors the new image, and plans/applies the module).
#
# Usage:
#   ./upgrade.sh --var-file dev.tfvars \
#                --runtime-digest sha256:<64 hex> \
#                --backup-bucket gs://<bucket>[/<prefix>] \
#                [--to 0.1.10] [--from 0.1.8|0.1.9] \
#                [--pack-dir <path to the pack project>] \
#                [--check-tenant <uuid>]
#
#   --var-file         The tfvars the deployment already uses. Read for its
#                      variables and passed to `terraform plan`/`apply`.
#   --runtime-digest   The release digest of the runtime being upgraded to,
#                      from its release notes (sha256:…). Mirrored into the
#                      deployment's Artifact Registry by its whole index.
#   --backup-bucket    A GCS bucket (optionally a prefix) the database export
#                      is written to. The export is one database, never an
#                      instance backup.
#   --to               The target runtime version (default 0.1.10).
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

# A version as a plain base-10 integer for comparison; the -rc suffix is
# ignored. 0.1.8 -> 1008, 0.1.10 -> 1010. 10# forces base 10 so a zero-padded
# component isn't read as octal, and the result carries no leading zero.
ver_num() {
  local v="${1%%-*}" a b c
  local IFS=.
  read -r a b c <<<"$v"
  printf '%d' "$(( (10#${a:-0}) * 1000000 + (10#${b:-0}) * 1000 + (10#${c:-0}) ))"
}

is_semver() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; }

# The go-back path, printed (never run) when the apply fails or the new revision
# doesn't come up. It reads variables set by the time it's called (steps 5/6).
# Migrations only go forward, so going back restores the backup into a FRESH
# database — never points an old runtime at the migrated one.
print_go_back() {
  local fresh="${DATABASE_NAME}-r$(date -u +%Y%m%d)"
  cat <<EOT >&2

======================================================================
The upgrade did not come up. NOTHING has been rolled back automatically.
Migrations only go forward, so do not point an old runtime at the
migrated database — restore the backup into a FRESH database instead.

To go back:

 1. A fresh database on the same instance:
      gcloud sql databases create ${fresh} --instance=${DB_INSTANCE} --project=${PROJECT}

 2. Import the backup into it:
      gcloud sql import sql ${DB_INSTANCE} ${EXPORT_URI} \\
        --database=${fresh} --user=kindgi --project=${PROJECT}
    (the instance's service account needs read on gs://${BUCKET_ONLY})

 3. Point the server at the fresh database — a new version of ${DB_URL_SECRET}
    with host=/cloudsql/${SQL_CONNECTION_NAME} and dbname ${fresh} (set the
    password through the Cloud SQL Admin API as in README step 3, never in a
    command's arguments), or set database_name=${fresh} in ${VAR_FILE}.

 4. Replay the erasure ledger before it serves (a Cloud Run job of the OLD
    runtime image ${OLD_SERVER_IMAGE}):
      <old image> erasures replay --from gcs:${BACKUP_BUCKET}
    and, with the postgres secrets backend, <old image> check stored-secrets.

 5. Put the old image(s) back and apply:
      server_image = "${OLD_SERVER_IMAGE}"
EOT
  if [[ $HAS_PACK == true && -n ${PACK_DIR:-} ]]; then
    printf '      pack_image   = "%s"\n' "$OLD_PACK_IMAGE" >&2
  fi
  cat <<EOT >&2
      terraform apply -var-file=${VAR_FILE}
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
    -h|--help) sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
if [[ -n $FROM_OVERRIDE ]]; then is_semver "$FROM_OVERRIDE" || die "--from \"$FROM_OVERRIDE\" isn't a version like 0.1.8."; fi
if [[ -n $PACK_DIR ]]; then [[ -d $PACK_DIR ]] || die "--pack-dir \"$PACK_DIR\" isn't a directory."; fi

require_cmd terraform gcloud jq

WORK="$(mktemp -d)"
CHECK_JOBS=()          # ephemeral pre-upgrade check jobs, deleted on exit
cleanup() {
  local code=$? job
  if [[ ${#CHECK_JOBS[@]} -gt 0 ]]; then
    for job in "${CHECK_JOBS[@]}"; do
      gcloud run jobs delete "$job" --project="$PROJECT" --region="$REGION" --quiet >/dev/null 2>&1 || true
    done
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
SQL_CONNECTION_NAME="$(jq -r '.sql_connection_name.value // empty' "$TF_OUT")"
SERVER_SA="$(jq -r '.service_accounts.value.server // empty' "$TF_OUT")"
SERVER_URL="$(jq -r '.server_url.value // empty' "$TF_OUT")"
[[ -n $IMAGE_REPOSITORY && -n $SQL_CONNECTION_NAME && -n $SERVER_SA ]] \
  || die "the module's outputs are incomplete — has the deployment been applied?"

# One terraform console call returns the variables as a JSON object. console
# renders jsonencode()'s string with HCL quoting, so `jq fromjson` unwraps it.
VARS_EXPR='jsonencode({project_id=var.project_id, region=var.region, name_prefix=var.name_prefix, database_host_instance=var.database_host_instance, database_name=var.database_name, secrets_backend=var.secrets_backend, tenancy=var.tenancy, database_private_network=var.database_private_network, server_image=var.server_image, pack_image=var.pack_image, database_instance=var.database_instance})'
VARS_RAW="$(terraform console -var-file="$VAR_FILE" <<<"$VARS_EXPR" 2>"$WORK/console.err")" \
  || die "couldn't read the module's variables with 'terraform console'. $(cat "$WORK/console.err")"
VARS="$(jq 'fromjson' <<<"$VARS_RAW")" \
  || die "couldn't parse the module's variables from terraform console."

PROJECT="$(jq -r '.project_id' <<<"$VARS")"
REGION="$(jq -r '.region' <<<"$VARS")"
NAME_PREFIX="$(jq -r '.name_prefix' <<<"$VARS")"
DATABASE_NAME="$(jq -r '.database_name' <<<"$VARS")"
SECRETS_BACKEND="$(jq -r '.secrets_backend' <<<"$VARS")"
TENANCY="$(jq -r '.tenancy' <<<"$VARS")"
DATABASE_PRIVATE_NETWORK="$(jq -r '.database_private_network // ""' <<<"$VARS")"
DATABASE_HOST_INSTANCE="$(jq -r '.database_host_instance // ""' <<<"$VARS")"
OLD_SERVER_IMAGE="$(jq -r '.server_image' <<<"$VARS")"
OLD_PACK_IMAGE="$(jq -r '.pack_image // ""' <<<"$VARS")"
DATABASE_INSTANCE_NAME="$(jq -r '.database_instance.name // ""' <<<"$VARS")"
DATABASE_INSTANCE_URL_SECRET="$(jq -r '.database_instance.url_secret // ""' <<<"$VARS")"

SERVER_SERVICE="${NAME_PREFIX}-server"

# This script is for the small dev shape, which is public-IP only. A private-IP
# deployment would need the check job (and more) wired through a VPC connector.
[[ -z $DATABASE_PRIVATE_NETWORK ]] \
  || die "this script covers the small dev (public-IP) shape only; database_private_network is set. Upgrade that deployment by hand."

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

info "project         $PROJECT"
info "region          $REGION"
info "server service  $SERVER_SERVICE"
info "database        $DATABASE_NAME on instance $DB_INSTANCE"
info "image repo      $IMAGE_REPOSITORY"

# --- step 1: the current version --------------------------------------------

step "1. Current runtime version"

CURRENT=""
if [[ -n $FROM_OVERRIDE ]]; then
  CURRENT="$FROM_OVERRIDE"
  info "using --from $CURRENT"
else
  RUNNING_IMAGE="$(gcloud run services describe "$SERVER_SERVICE" \
    --project="$PROJECT" --region="$REGION" \
    --format='value(template.containers[0].image)' 2>"$WORK/describe.err")" \
    || die "couldn't read the server service \"$SERVER_SERVICE\". $(cat "$WORK/describe.err")"
  [[ -n $RUNNING_IMAGE ]] || die "the server service \"$SERVER_SERVICE\" has no image — is it deployed?"
  # The running image is digest-pinned and carries no tag. The version tag is on
  # the same digest in Artifact Registry (README step 2 mirrors with --tag).
  repo_no_digest="${RUNNING_IMAGE%@*}"
  running_digest="${RUNNING_IMAGE##*@}"
  tags="$(gcloud artifacts docker images list "$repo_no_digest" --include-tags \
    --filter="version=${running_digest}" --format='value(tags)' 2>/dev/null || true)"
  # tags is semicolon/comma/space separated; word-split on those (no array, so
  # an empty result just iterates zero times under set -u on bash 3.2).
  for tag in ${tags//[;,]/ }; do
    if is_semver "$tag"; then CURRENT="$tag"; break; fi
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

# The releases this upgrade crosses (current < r <= target), from what we know.
CROSSED=()
for r in "${KNOWN_RELEASES[@]}"; do
  if [[ "$(ver_num "$r")" -gt "$(ver_num "$CURRENT")" && "$(ver_num "$r")" -le "$(ver_num "$TARGET")" ]]; then
    CROSSED+=("$r")
  fi
done
[[ ${#CROSSED[@]} -gt 0 ]] || die "no known upgrade steps between $CURRENT and $TARGET; this script knows ${KNOWN_RELEASES[*]}."
info "upgrading $CURRENT -> $TARGET, crossing: ${CROSSED[*]}"

NEW_SERVER_IMAGE="${IMAGE_REPOSITORY}/runtime@${RUNTIME_DIGEST}"
NEW_PACK_IMAGE="$OLD_PACK_IMAGE"
HAS_PACK=false
if [[ -n $OLD_PACK_IMAGE && $TENANCY == "single" ]]; then HAS_PACK=true; fi

# --- step 2: checks ---------------------------------------------------------
# Everything here is read-only against the deployment. Mirroring the new image
# (below) only adds to Artifact Registry; it changes nothing that serves. The
# first change to the running deployment is the apply in step 5.

step "2. Pre-upgrade checks"

CHECK_FAILED=false
fail_check() { CHECK_FAILED=true; warn "CHECK FAILED: $*"; }

# 2a. The host instance must run Postgres 16 or later (a shared instance only;
# the module's own instance is Postgres 16 by construction). The small dev shape
# needs a public IP.
if [[ -n $DATABASE_HOST_INSTANCE ]]; then
  host_version="$(gcloud sql instances describe "$DATABASE_HOST_INSTANCE" \
    --project="$PROJECT" --format='value(databaseVersion)' 2>/dev/null || true)"
  if [[ $host_version =~ ^POSTGRES_(1[6-9]|[2-9][0-9])$ ]]; then
    info "host instance $DATABASE_HOST_INSTANCE is $host_version (ok)"
  else
    fail_check "host instance $DATABASE_HOST_INSTANCE is \"${host_version:-unreadable}\", not Postgres 16 or later."
  fi
  host_public="$(gcloud sql instances describe "$DATABASE_HOST_INSTANCE" \
    --project="$PROJECT" --format='value(settings.ipConfiguration.ipv4Enabled)' 2>/dev/null || true)"
  [[ $host_public == "True" ]] || fail_check "host instance $DATABASE_HOST_INSTANCE has no public IP; the small dev shape reaches it over /cloudsql."
fi

# Stop on a failed precondition before spending anything: no image is mirrored
# and no check job runs if the database can't host the upgrade.
if [[ $CHECK_FAILED == true ]]; then
  die "a precondition failed (above). Nothing was mirrored, backed up or changed. Fix it and run again."
fi

# 2b. Mirror the new runtime image into the deployment's Artifact Registry, so
# the read-only check job (and step 5) can pull it (Cloud Run can't pull from
# quay). The mirror keeps the release digest. This adds an image; it serves
# nothing until step 5.
step "Mirroring runtime ${TARGET} into Artifact Registry"
require_cmd docker
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null 2>&1 || true
docker buildx imagetools create --tag "${IMAGE_REPOSITORY}/runtime:${TARGET}" \
  "${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST}" \
  || die "couldn't mirror ${RUNTIME_REPO}:${TARGET}@${RUNTIME_DIGEST} into ${IMAGE_REPOSITORY}. Is 'kindgi auth registry' done and do you have push access?"
info "mirrored to $NEW_SERVER_IMAGE"

# 2c. The runtime's own read-only checks, run with the NEW image against the
# database, as ephemeral Cloud Run jobs (one per check, deleted on exit). The
# check name is baked into the job's args at create time, since `jobs execute`
# can't override them across gcloud versions. provider-keys, secret-scopes and
# mcp-header-credentials apply for 0.1.8 -> 0.1.10 (stored-secrets is a restore
# check; purged-tenants is multi-tenant only).
step "Running the new runtime's read-only checks (as jobs)"
check_stamp="$(date -u +%H%M%S)"
check_suffix_provider_keys="pk"
check_suffix_secret_scopes="ss"
check_suffix_mcp_header_credentials="mhc"
for check in provider-keys secret-scopes mcp-header-credentials; do
  suffix_var="check_suffix_${check//-/_}"
  job="${NAME_PREFIX}-upgchk-${check_stamp}-${!suffix_var}"
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
    # --wait returns non-zero if the task exits non-zero: 1 (findings) or 2
    # (couldn't run). Either fails the check.
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
sql_sa="$(gcloud sql instances describe "$DB_INSTANCE" --project="$PROJECT" \
  --format='value(serviceAccountEmailAddress)' 2>/dev/null || true)"
[[ -n $sql_sa ]] || die "couldn't read instance $DB_INSTANCE's service account; can't grant the export."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_ONLY}" \
  --member="serviceAccount:${sql_sa}" --role="roles/storage.objectAdmin" --quiet >/dev/null \
  || die "couldn't grant instance $DB_INSTANCE's service account write on gs://${BUCKET_ONLY}."

warn "The export is a point in time. Writes after it are not in the backup and are lost if you roll back. On a busy deployment, stop traffic first."
info "exporting to $EXPORT_URI"
gcloud sql export sql "$DB_INSTANCE" "$EXPORT_URI" \
  --project="$PROJECT" --database="$DATABASE_NAME" \
  || die "the export failed. Nothing has changed. Fix the cause and run again."
info "backup complete: $EXPORT_URI"

# --- step 4: the pack image (if any) ----------------------------------------

step "4. Pack image"
if [[ $HAS_PACK == true && -n $PACK_DIR ]]; then
  require_cmd kindgi
  info "rebuilding the pack from $PACK_DIR"
  ( cd "$PACK_DIR" && kindgi build --local --push --env dev ) \
    || die "the pack build failed. The runtime image is mirrored and the backup is taken; fix the pack and run again."
  envelope="${PACK_DIR%/}/.kindgi/build/deploy-envelope.json"
  [[ -f $envelope ]] || die "the pack build left no $envelope to read the new image from."
  NEW_PACK_IMAGE="$(jq -r '.image // .packImage // empty' "$envelope")"
  [[ -n $NEW_PACK_IMAGE ]] || die "couldn't read the new pack image from $envelope."
  info "new pack image $NEW_PACK_IMAGE"
elif [[ $HAS_PACK == true ]]; then
  warn "the deployment has a pack service, but no --pack-dir was given: the pack image is left unchanged. If 0.1.10 needs a pack rebuilt (e.g. to drop production-only installs or secretScopes), rebuild it with 'kindgi build --local --push' and run again with --pack-dir."
else
  info "no pack service (tenancy=$TENANCY); nothing to build."
fi

# --- step 5: plan and apply -------------------------------------------------

step "5. Terraform plan"
PLAN="$WORK/upgrade.tfplan"
plan_vars=(-var-file="$VAR_FILE" -var "server_image=$NEW_SERVER_IMAGE")
if [[ $HAS_PACK == true ]]; then plan_vars+=(-var "pack_image=$NEW_PACK_IMAGE"); fi
terraform plan "${plan_vars[@]}" -out="$PLAN" \
  || die "terraform plan failed. Nothing has changed."

printf '\n'
warn "Review the plan above. It points the server (and pack, if rebuilt) at the new image."
printf 'Apply this plan? Type yes to proceed: '
reply=""
IFS= read -r reply || reply=""
[[ $reply == "yes" ]] || die "not confirmed — nothing was applied. (The backup stays at $EXPORT_URI.)"

step "Applying"
if ! terraform apply "$PLAN"; then
  warn "terraform apply failed."
  print_go_back
  exit 1
fi

# After the new digests serve, write them into your tfvars so a later plain
# apply doesn't revert them.
warn "Set these in $VAR_FILE so a later apply keeps them:"
info "server_image = \"$NEW_SERVER_IMAGE\""
if [[ $HAS_PACK == true && -n $PACK_DIR ]]; then info "pack_image   = \"$NEW_PACK_IMAGE\""; fi

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
info "Backup kept at $EXPORT_URI"
exit 0
