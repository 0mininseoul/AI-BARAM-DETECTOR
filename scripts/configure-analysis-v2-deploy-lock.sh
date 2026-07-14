#!/usr/bin/env bash
set -euo pipefail

readonly STORAGE_API="storage.googleapis.com"
readonly OBJECT_ROLE="roles/storage.objectUser"
readonly LIFECYCLE_JSON='{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}'

mode="apply"
reconcile_iam="false"
bucket_created="false"
lifecycle_file=""
policy_file=""

usage() {
  cat <<'USAGE'
Usage: configure-analysis-v2-deploy-lock.sh [--dry-run | --check] [--reconcile-iam]

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION
  ANALYSIS_V2_DEPLOYER_IAM_MEMBER
  ANALYSIS_V2_DEPLOY_LOCK_BUCKET

ANALYSIS_V2_DEPLOY_LOCK_BUCKET must be generated once with a persistent
128-bit random hexadecimal suffix. Runtime identities are intentionally not
granted access. Existing unexpected IAM requires --reconcile-iam.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

print_command() {
  printf '[dry-run]'
  printf ' %q' "$@"
  printf '\n'
}

run_mutation() {
  if [[ "$mode" == "dry-run" ]]; then
    print_command "$@"
  else
    "$@"
  fi
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "missing required environment variable: $name"
}

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9.-]{4,28}[a-z0-9]$ ]] \
    || die "ANALYSIS_V2_TASKS_PROJECT is invalid"
}

validate_location() {
  [[ "$1" =~ ^[a-z]+-[a-z]+[0-9]$ ]] \
    || die "ANALYSIS_V2_TASKS_CLOUD_RUN_REGION is invalid"
}

validate_member() {
  [[ "$1" =~ ^(user|serviceAccount|group):[^[:space:]]+$ ]] \
    || die "ANALYSIS_V2_DEPLOYER_IAM_MEMBER must be a user, serviceAccount, or group member"
}

validate_bucket() {
  local bucket="$1"
  local random_suffix="${bucket##*-}"
  [[ "$bucket" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]] \
    || die "ANALYSIS_V2_DEPLOY_LOCK_BUCKET is invalid"
  [[ "$random_suffix" =~ ^[a-f0-9]{32}$ ]] \
    || die "ANALYSIS_V2_DEPLOY_LOCK_BUCKET must end with a persistent 128-bit lowercase hexadecimal suffix"
}

api_enabled() {
  local enabled
  enabled="$(gcloud services list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --enabled \
    "--filter=config.name=$STORAGE_API" \
    '--format=value(config.name)')"
  [[ "$enabled" == "$STORAGE_API" ]]
}

ensure_api() {
  if api_enabled; then
    log "verified: $STORAGE_API is enabled"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "$STORAGE_API is not enabled"
  run_mutation gcloud services enable "$STORAGE_API" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" --quiet
}

bucket_json() {
  gcloud storage buckets describe "gs://$deploy_lock_bucket" \
    --raw --format=json 2>/dev/null
}

bucket_identity_is_exact() {
  local config="$1"
  local location_upper
  location_upper="$(printf '%s' "$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" | tr '[:lower:]' '[:upper:]')"
  jq -e \
    --arg location "$location_upper" \
    --arg project_number "$project_number" '
      (.location | ascii_upcase) == $location
        and (.projectNumber | tostring) == $project_number
    ' <<<"$config" >/dev/null
}

bucket_controls_are_exact() {
  local config="$1"
  jq -e '
      .iamConfiguration.uniformBucketLevelAccess.enabled == true
        and .iamConfiguration.publicAccessPrevention == "enforced"
        and (.versioning.enabled // false) == false
        and (.billing.requesterPays // false) == false
        and (.retentionPolicy? == null)
        and (.defaultEventBasedHold // false) == false
        and ((.softDeletePolicy.retentionDurationSeconds // "0") | tonumber) == 0
        and ((.lifecycle.rule // []) | length) == 1
        and .lifecycle.rule[0].action.type == "Delete"
        and (.lifecycle.rule[0].condition.age | tonumber) == 1
        and ((.lifecycle.rule[0].condition | keys | sort) == ["age"])
    ' <<<"$config" >/dev/null
}

bucket_is_exact() {
  local config="$1"
  bucket_identity_is_exact "$config" && bucket_controls_are_exact "$config"
}

write_lifecycle_file() {
  lifecycle_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-deploy-lock-lifecycle.XXXXXX")"
  printf '%s\n' "$LIFECYCLE_JSON" >"$lifecycle_file"
}

ensure_bucket() {
  local config=""
  if config="$(bucket_json)"; then
    bucket_identity_is_exact "$config" \
      || die "deploy-lock bucket belongs to another project or location; refusing to mutate it"
    if bucket_is_exact "$config"; then
      log "verified: deploy-lock bucket ownership and security controls are exact"
      return 0
    fi
    [[ "$mode" != "check" ]] || die "deploy-lock bucket configuration has drifted"
  else
    [[ "$mode" != "check" ]] || die "deploy-lock bucket does not exist or is not visible"
    run_mutation gcloud storage buckets create "gs://$deploy_lock_bucket" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      "--location=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
      --uniform-bucket-level-access \
      --public-access-prevention \
      --soft-delete-duration=0 \
      --quiet
    bucket_created="true"
  fi

  [[ -n "$lifecycle_file" ]] || write_lifecycle_file
  run_mutation gcloud storage buckets update "gs://$deploy_lock_bucket" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --no-versioning \
    --no-requester-pays \
    --clear-soft-delete \
    "--lifecycle-file=$lifecycle_file" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    config="$(bucket_json)" || die "deploy-lock bucket was not observable after apply"
    bucket_is_exact "$config" || die "deploy-lock bucket controls were not applied"
  fi
}

bucket_policy() {
  gcloud storage buckets get-iam-policy "gs://$deploy_lock_bucket" --format=json
}

policy_is_exact() {
  local policy="$1"
  jq -e --arg member "$ANALYSIS_V2_DEPLOYER_IAM_MEMBER" --arg role "$OBJECT_ROLE" '
    ((.bindings // []) | length) == 1
      and .bindings[0].role == $role
      and (.bindings[0].condition? == null)
      and .bindings[0].members == [$member]
  ' <<<"$policy" >/dev/null
}

write_policy_file() {
  local policy="$1"
  policy_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-deploy-lock-iam.XXXXXX")"
  jq --arg member "$ANALYSIS_V2_DEPLOYER_IAM_MEMBER" --arg role "$OBJECT_ROLE" '
    .bindings = [{"role": $role, "members": [$member]}]
  ' <<<"$policy" >"$policy_file"
}

ensure_bucket_iam() {
  local binding_count
  local policy
  if [[ "$mode" == "dry-run" ]] && ! policy="$(bucket_policy 2>/dev/null)"; then
    log "[dry-run] deploy-lock bucket IAM will contain only the deployer objectUser binding"
    return 0
  fi
  policy="${policy:-$(bucket_policy)}"
  if policy_is_exact "$policy"; then
    log "verified: only the configured deployer can access deploy locks"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "deploy-lock bucket IAM is not exact"
  binding_count="$(jq -r '(.bindings // []) | length' <<<"$policy")"
  if [[ "$bucket_created" != "true" && "$binding_count" != "0" \
    && "$reconcile_iam" != "true" ]]; then
    die "deploy-lock bucket IAM has unexpected bindings; inspect or use --reconcile-iam"
  fi
  write_policy_file "$policy"
  run_mutation gcloud storage buckets set-iam-policy \
    "gs://$deploy_lock_bucket" "$policy_file" --quiet
  if [[ "$mode" == "apply" ]]; then
    policy="$(bucket_policy)"
    policy_is_exact "$policy" || die "deploy-lock bucket IAM was not applied"
  fi
}

cleanup() {
  [[ -z "$lifecycle_file" ]] || rm -f "$lifecycle_file"
  [[ -z "$policy_file" ]] || rm -f "$policy_file"
}
trap cleanup EXIT

while (($# > 0)); do
  case "$1" in
    --dry-run)
      [[ "$mode" == "apply" ]] || die "choose only one mode"
      mode="dry-run"
      ;;
    --check)
      [[ "$mode" == "apply" ]] || die "choose only one mode"
      mode="check"
      ;;
    --reconcile-iam)
      reconcile_iam="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

for name in \
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION \
  ANALYSIS_V2_DEPLOYER_IAM_MEMBER \
  ANALYSIS_V2_DEPLOY_LOCK_BUCKET; do
  required_env "$name"
done
validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_location "$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
validate_member "$ANALYSIS_V2_DEPLOYER_IAM_MEMBER"
validate_bucket "$ANALYSIS_V2_DEPLOY_LOCK_BUCKET"
command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -n "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)" ]] \
  || die "gcloud has no active authenticated account"
readonly deploy_lock_bucket="$ANALYSIS_V2_DEPLOY_LOCK_BUCKET"
readonly project_number="$(gcloud projects describe "$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(projectNumber)')"
[[ "$project_number" =~ ^[0-9]+$ ]] || die "could not resolve project number"

ensure_api
ensure_bucket
ensure_bucket_iam

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Analysis V2 deploy-lock coordination bucket verified"
fi
