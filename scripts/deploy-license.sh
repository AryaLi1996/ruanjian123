#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$ROOT/serverless/verify-license"
STACK_NAME="${STACK_NAME:-ruanjian-license}"
AWS_REGION="${AWS_REGION:-us-east-1}"
EXPECTED_ACCOUNT="641628981129"

# PLAN_ONLY=true turns this into a read-only preview: it builds and uploads
# the artifacts, creates a CloudFormation change-set and prints it, but never
# executes it and never deletes anything. That's what the deploy workflow's
# `plan` job runs, behind an IAM role that lacks ExecuteChangeSet entirely —
# so a reviewer sees the exact resource diff *before* approving the `apply`
# job that performs it (see .github/workflows/deploy-license.yml and
# serverless/verify-license/CI_DEPLOY_SETUP.md).
#
# The un-executed change-sets this leaves behind are inert: they hold no
# resources, cost nothing, and are superseded by the next one. CloudFormation
# caps them at 3600 per stack, so prune them occasionally if this runs a lot.
PLAN_ONLY="${PLAN_ONLY:-false}"

if [[ -z "${LICENSE_SIGNING_SECRET:-}" && -n "${LICENSE_SIGNING_SECRET_FILE:-}" ]]; then
  LICENSE_SIGNING_SECRET="$(<"$LICENSE_SIGNING_SECRET_FILE")"
fi

if [[ -z "${LICENSE_SIGNING_SECRET:-}" && -t 0 ]]; then
  read -r -s -p "License signing secret (input hidden): " LICENSE_SIGNING_SECRET
  printf '\n'
fi

if [[ -z "${LICENSE_SIGNING_SECRET:-}" ]]; then
  echo "Set LICENSE_SIGNING_SECRET or LICENSE_SIGNING_SECRET_FILE; do not commit it" >&2
  exit 1
fi

if ! command -v sam >/dev/null 2>&1; then
  echo "SAM CLI is required: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" >&2
  exit 1
fi

identity="$(aws sts get-caller-identity --output json)"
account="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin)["Account"])')"
if [[ "$account" != "$EXPECTED_ACCOUNT" ]]; then
  echo "Refusing deployment: AWS account $account is not $EXPECTED_ACCOUNT" >&2
  exit 1
fi

# REVIEW_IN_PROGRESS and ROLLBACK_COMPLETE stacks cannot be updated.
# They contain no usable deployment outputs, so remove them before retrying.
# Skipped entirely in plan mode: deleting a stack is the single most
# destructive thing this script does, and a preview must not do it — the
# plan role has no DeleteStack permission either way, so attempting it there
# would just fail the preview with an access-denied instead of the accurate
# "this stack can't be updated" message the apply job will produce.
if [[ "$PLAN_ONLY" != "true" ]]; then
stack_status="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || true)"
if [[ "$stack_status" == "REVIEW_IN_PROGRESS" || "$stack_status" == "ROLLBACK_COMPLETE" || "$stack_status" == "CREATE_FAILED" ]]; then
  echo "Cleaning up unusable $STACK_NAME stack in status $stack_status..."
  aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$AWS_REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$AWS_REGION"
fi
fi

cd "$TEMPLATE_DIR"
sam build --template-file template.yaml

# Always-present overrides first. The optional secrets below are appended
# only when actually set: `sam deploy --parameter-overrides` shorthand
# syntax (KeyN=ValueN, space-separated) rejects an explicitly-empty value
# like "StripeApiKey=" outright — "is not a valid format" — before any AWS
# call happens, even though an *omitted* key is perfectly fine and just
# leaves template.yaml's own Default: '' in effect (the same end state).
overrides=(
  "LicenseSigningSecret=$LICENSE_SIGNING_SECRET"
  "PaymentProvider=${PAYMENT_PROVIDER:-custom}"
  "MockMode=${MOCK_MODE:-false}"
  "ExpiryDays=${EXPIRY_DAYS:-30}"
)
[[ -n "${STRIPE_API_KEY:-}" ]]        && overrides+=("StripeApiKey=$STRIPE_API_KEY")
[[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]] && overrides+=("StripeWebhookSecret=$STRIPE_WEBHOOK_SECRET")
[[ -n "${LEMON_API_KEY:-}" ]]         && overrides+=("LemonApiKey=$LEMON_API_KEY")
[[ -n "${SES_SENDER_EMAIL:-}" ]]      && overrides+=("SesSenderEmail=$SES_SENDER_EMAIL")

# --no-execute-changeset makes `sam deploy` stop after creating and printing
# the change-set; --no-confirm-changeset skips the interactive prompt and
# executes it. Exactly one of the two applies.
if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "PLAN_ONLY=true — creating a change-set for review; nothing will be applied."
  execute_flag=(--no-execute-changeset)
else
  execute_flag=(--no-confirm-changeset)
fi

# `--no-fail-on-empty-changeset` covers an empty change-set on the apply path,
# but *not* the plan path: with `--no-execute-changeset`, sam deploy prints
# "Error: No changes to deploy" and exits 1 regardless of that flag. Which
# means any push touching serverless/verify-license/** that does not alter the
# deployed template — a doc, a test, migrate_app_id.py — fails the plan job
# even though nothing is wrong. A deploy pipeline that goes red for a
# no-op is a pipeline people learn to ignore, so the output is inspected and
# that one case is reported as what it is.
deploy_log=$(mktemp)
trap 'rm -f "$deploy_log"' EXIT

set +e
sam deploy \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_NAMED_IAM \
  "${execute_flag[@]}" \
  --parameter-overrides "${overrides[@]}" 2>&1 | tee "$deploy_log"
deploy_status=${PIPESTATUS[0]}
set -e

# Matched on sam's own wording. Narrow on purpose: anything else that exits
# non-zero is still a failure, and a future sam that stops emitting this
# reverts to failing loudly rather than passing silently.
no_changes=false
if [[ $deploy_status -ne 0 ]] \
   && grep -qiF "No changes to deploy" "$deploy_log"; then
  no_changes=true
  deploy_status=0
fi

if [[ $deploy_status -ne 0 ]]; then
  echo "Deployment failed. Recent CloudFormation events:" >&2
  aws cloudformation describe-stack-events \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --max-items 20 \
    --query 'StackEvents[].{LogicalId:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}' \
    --output table >&2 || true
  exit 1
fi

if [[ "$no_changes" == "true" ]]; then
  echo
  echo "The deployed stack already matches this template — nothing to change."
  echo "Treating an empty change-set as success: the commit that triggered this"
  echo "run touched serverless/verify-license/** without altering the template."
  exit 0
fi

# Nothing was applied in plan mode, so the stack outputs would describe the
# *current* deployment, not the previewed one — misleading in a review log.
if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "Change-set created above. Approve the 'apply' job to execute it."
  exit 0
fi

sam list stack-outputs --stack-name "$STACK_NAME" --region "$AWS_REGION"
