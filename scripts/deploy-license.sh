#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$ROOT/serverless/verify-license"
STACK_NAME="${STACK_NAME:-ruanjian-license}"
AWS_REGION="${AWS_REGION:-us-east-1}"
EXPECTED_ACCOUNT="641628981129"

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

cd "$TEMPLATE_DIR"
sam build --template-file template.yaml
if ! sam deploy \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-confirm-changeset \
  --parameter-overrides \
    "LicenseSigningSecret=$LICENSE_SIGNING_SECRET" \
    "PaymentProvider=${PAYMENT_PROVIDER:-custom}" \
    "MockMode=${MOCK_MODE:-false}" \
    "ExpiryDays=${EXPIRY_DAYS:-30}" \
    "StripeApiKey=${STRIPE_API_KEY:-}" \
    "StripeWebhookSecret=${STRIPE_WEBHOOK_SECRET:-}" \
    "LemonApiKey=${LEMON_API_KEY:-}" \
    "SesSenderEmail=${SES_SENDER_EMAIL:-}"; then
  echo "Deployment failed. Recent CloudFormation events:" >&2
  aws cloudformation describe-stack-events \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --max-items 20 \
    --query 'StackEvents[].{LogicalId:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}' \
    --output table >&2 || true
  exit 1
fi

sam list stack-outputs --stack-name "$STACK_NAME" --region "$AWS_REGION"
