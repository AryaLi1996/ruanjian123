#!/usr/bin/env bash
set -euo pipefail

# Deploys serverless/cloud-inpaint. Deliberately the same shape as
# deploy-license.sh beside it — same plan/apply split, same treatment of an
# empty change-set — so whoever has operated one has already operated the
# other. The differences are noted where they occur.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$ROOT/serverless/cloud-inpaint"
STACK_NAME="${STACK_NAME:-shuyin-cloud-inpaint}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# The same account the licence service deploys to. The guard is here anyway,
# and is worth as much as it ever was: it stops a mis-set profile or a role in
# somebody's personal account from creating a second, live inference endpoint
# nobody is watching the bill for.
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-641628981129}"

# PLAN_ONLY=true turns this into a read-only preview: it builds and uploads the
# artifacts, creates a CloudFormation change-set and prints it, but never
# executes it and never deletes anything. That is what the deploy workflow's
# `plan` job runs, behind an IAM role that lacks ExecuteChangeSet entirely.
PLAN_ONLY="${PLAN_ONLY:-false}"

if [[ -z "${FILL_SIGNING_SECRET:-}" && -n "${FILL_SIGNING_SECRET_FILE:-}" ]]; then
  FILL_SIGNING_SECRET="$(<"$FILL_SIGNING_SECRET_FILE")"
fi

if [[ -z "${FILL_SIGNING_SECRET:-}" && -t 0 ]]; then
  read -r -s -p "Fill signing secret (input hidden): " FILL_SIGNING_SECRET
  printf '\n'
fi

if [[ -z "${FILL_SIGNING_SECRET:-}" ]]; then
  echo "Set FILL_SIGNING_SECRET or FILL_SIGNING_SECRET_FILE; do not commit it" >&2
  exit 1
fi

# template.yaml's MinLength, checked here so the failure names the problem
# instead of arriving as a CloudFormation parameter validation error several
# minutes into a build.
if (( ${#FILL_SIGNING_SECRET} < 32 )); then
  echo "FILL_SIGNING_SECRET must be at least 32 characters (got ${#FILL_SIGNING_SECRET})" >&2
  exit 1
fi

if ! command -v sam >/dev/null 2>&1; then
  echo "SAM CLI is required: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" >&2
  exit 1
fi

# Unlike the licence stack, this one is a container image: `sam build` runs a
# real `docker build`, so a machine without a daemon fails here rather than
# halfway through an upload.
if ! docker info >/dev/null 2>&1; then
  echo "A running Docker daemon is required: this stack builds a container image" >&2
  exit 1
fi

identity="$(aws sts get-caller-identity --output json)"
account="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin)["Account"])')"
if [[ "$account" != "$EXPECTED_ACCOUNT" ]]; then
  echo "Refusing deployment: AWS account $account is not $EXPECTED_ACCOUNT" >&2
  exit 1
fi

# REVIEW_IN_PROGRESS and ROLLBACK_COMPLETE stacks cannot be updated. They hold
# no usable outputs, so they have to go before a retry can work.
#
# The status is read in both modes; only the deletion is withheld from plan
# mode, because deleting a stack is the most destructive thing this script
# does and a preview must not do it. Reading it in plan mode is what stops the
# second deadlock this pipeline has had.
#
# The first was `--resolve-image-repos` (see below). This one is the same
# shape and was hiding one block further up: a failed *create* leaves the
# stack in ROLLBACK_COMPLETE, CreateChangeSet then refuses it outright, so
# `plan` fails — and `apply`, the only job allowed to delete it, never runs,
# because it waits on `plan`. The pipeline could not recover from its own
# first failed deployment without somebody deleting the stack by hand.
stack_status="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || true)"

stack_unusable=false
if [[ "$stack_status" == "REVIEW_IN_PROGRESS" || "$stack_status" == "ROLLBACK_COMPLETE" || "$stack_status" == "CREATE_FAILED" ]]; then
  stack_unusable=true
fi

if [[ "$stack_unusable" == "true" && "$PLAN_ONLY" != "true" ]]; then
  echo "Cleaning up unusable $STACK_NAME stack in status $stack_status..."
  aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$AWS_REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$AWS_REGION"
fi

# Where the built image goes.
#
# Named explicitly rather than left to `sam deploy --resolve-image-repos`,
# which does not simply create an ECR repository: it creates a *second*
# CloudFormation stack, `<stack>-<hash>-CompanionStack`, to hold one. That
# broke the pipeline in two ways at once. The plan role has no
# `cloudformation:CreateStack` — being unable to create anything is the whole
# point of it — and the deploy role's policy is scoped to this stack's own
# ARN, which the companion's name does not match. Worse, it deadlocks: `plan`
# cannot pass until the companion exists, and `apply` only runs after `plan`
# passes.
#
# One repository, created once by hand (see CI_DEPLOY_SETUP.md), removes all
# of that. The URI is derived rather than configured — the account and region
# are already here, and a fourth thing to keep in step is a fourth thing to
# get wrong.
IMAGE_REPO_NAME="${IMAGE_REPO_NAME:-$STACK_NAME}"
IMAGE_REPO="${IMAGE_REPO:-${EXPECTED_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${IMAGE_REPO_NAME}}"

if ! aws ecr describe-repositories --repository-names "$IMAGE_REPO_NAME" \
     --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "ECR repository '$IMAGE_REPO_NAME' does not exist in $AWS_REGION." >&2
  echo "It is created once, by hand — neither role here is allowed to:" >&2
  echo "  aws ecr create-repository --repository-name $IMAGE_REPO_NAME --region $AWS_REGION" >&2
  echo "See serverless/verify-license/CI_DEPLOY_SETUP.md section 2d." >&2
  exit 1
fi

cd "$TEMPLATE_DIR"
sam build --template-file template.yaml

overrides=(
  "FillSigningSecret=$FILL_SIGNING_SECRET"
  "FillAppId=${FILL_APP_ID:-shuyin}"
  "MaxFramesPerJob=${MAX_FRAMES_PER_JOB:-240}"
  "MemorySize=${MEMORY_SIZE:-10240}"
  "ReservedConcurrency=${RESERVED_CONCURRENCY:-4}"
)

# Nothing can be planned against a stack CloudFormation will not update, and
# the build above has already done the useful half of a plan — it proves the
# image still builds, which is what a broken Dockerfile would fail at. Say
# what the apply will do and stop, rather than failing on a CreateChangeSet
# that was never going to be accepted.
#
# There is no change-set for the reviewer to read in this case, and that is
# honest: the stack is being deleted and made again, so every resource in it
# is new. The reviewer is approving exactly that.
if [[ "$PLAN_ONLY" == "true" && "$stack_unusable" == "true" ]]; then
  echo
  echo "The $STACK_NAME stack is in $stack_status, which CloudFormation cannot"
  echo "update — the result of an earlier deployment that failed and rolled back."
  echo "There is no change-set to preview: approving 'apply' will delete this"
  echo "stack and create it again from scratch."
  echo
  echo "The container image built successfully, so the deployment itself is not"
  echo "known to be broken."
  exit 0
fi

if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "PLAN_ONLY=true — creating a change-set for review; nothing will be applied."
  execute_flag=(--no-execute-changeset)
else
  execute_flag=(--no-confirm-changeset)
fi

# `--no-fail-on-empty-changeset` covers the apply path but not the plan path:
# with `--no-execute-changeset`, sam prints "Error: No changes to deploy" and
# exits 1 regardless. Any push touching services/cloud-inpaint/** that does not
# alter the deployed shape — a doc, a test — would fail the plan job with
# nothing wrong, and a pipeline that goes red for a no-op is one people learn
# to ignore. So the output is inspected and that case reported as what it is.
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
  --image-repository "$IMAGE_REPO" \
  --capabilities CAPABILITY_NAMED_IAM \
  "${execute_flag[@]}" \
  --parameter-overrides "${overrides[@]}" 2>&1 | tee "$deploy_log"
deploy_status=${PIPESTATUS[0]}
set -e

no_changes=false
if [[ $deploy_status -ne 0 ]] && grep -qiF "No changes to deploy" "$deploy_log"; then
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
  exit 0
fi

if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "Change-set created above. Approve the 'apply' job to execute it."
  exit 0
fi

sam list stack-outputs --stack-name "$STACK_NAME" --region "$AWS_REGION"

echo
echo "That InpaintUrl is what fill/quota hands the app. deploy-license.sh looks"
echo "it up from this stack's outputs, so there is nothing to copy by hand."
