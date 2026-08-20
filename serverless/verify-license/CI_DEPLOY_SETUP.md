# CI deploy setup for the license backend

`.github/workflows/deploy-license.yml` runs `scripts/deploy-license.sh`
automatically on every push to `main` that touches
`serverless/verify-license/**`. It authenticates to AWS via GitHub's OIDC
provider — no long-lived AWS access keys are stored in GitHub — but that
means an IAM role has to exist first, trusted specifically by this repo.
This is one-time AWS setup; nothing here runs automatically.

If any of this is already set up for other workflows in your AWS account,
skip the parts that already exist.

## 1. AWS IAM OIDC identity provider (one per AWS account)

Most accounts that already use GitHub Actions with OIDC have this. Check
first:

```bash
aws iam list-open-id-connect-providers
```

If `token.actions.githubusercontent.com` isn't listed, create it:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

(That thumbprint is GitHub's current OIDC root CA thumbprint. AWS no longer
strictly requires a correct value here — it accepts any well-formed
thumbprint for this provider — but this is the documented value; see AWS's
own GitHub Actions OIDC guide if it's since changed.)

## 2. IAM role this workflow assumes

Trust policy — scoped to this exact repo, and to `main` pushes only
(matching the workflow's own trigger), so no other repo or branch can
assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::641628981129:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:AryaLi1996/ruanjian123:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Permissions policy — what `sam build`/`sam deploy` actually needs for this
template: CloudFormation on the `ruanjian-license` stack, the SAM-managed S3
bucket (`--resolve-s3`), the Lambda function + its execution role
(`CAPABILITY_NAMED_IAM` — see `LicenseVerifierRole` in `template.yaml`), the
three DynamoDB tables, and CloudWatch Logs. Start narrow and widen only if a
deploy fails on a missing permission — this list is a starting point, not a
guarantee of completeness for every future template change:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": "cloudformation:*",
      "Resource": "arn:aws:cloudformation:us-east-1:641628981129:stack/ruanjian-license/*"
    },
    {
      "Sid": "CloudFormationChangeSetPreflight",
      "Effect": "Allow",
      "Action": ["cloudformation:ValidateTemplate", "cloudformation:DescribeStacks"],
      "Resource": "*"
    },
    {
      "Sid": "SamManagedBucket",
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": ["arn:aws:s3:::aws-sam-cli-managed-*", "arn:aws:s3:::aws-sam-cli-managed-*/*"]
    },
    {
      "Sid": "LambdaFunctionAndUrl",
      "Effect": "Allow",
      "Action": ["lambda:*"],
      "Resource": "arn:aws:lambda:us-east-1:641628981129:function:ruanjian-license-*"
    },
    {
      "Sid": "IamRoleForLambda",
      "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy",
                 "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:PassRole", "iam:TagRole"],
      "Resource": "arn:aws:iam::641628981129:role/ruanjian-license-*"
    },
    {
      "Sid": "DynamoDbTables",
      "Effect": "Allow",
      "Action": ["dynamodb:*"],
      "Resource": "arn:aws:dynamodb:us-east-1:641628981129:table/ruanjian-license-*"
    },
    {
      "Sid": "CloudWatchLogsForLambda",
      "Effect": "Allow",
      "Action": ["logs:*"],
      "Resource": "arn:aws:logs:us-east-1:641628981129:log-group:/aws/lambda/ruanjian-license-*"
    }
  ]
}
```

Adjust the `ruanjian-license-*` / `ruanjian-license/*` prefixes if you
override `STACK_NAME` away from the script's default.

## 3. GitHub repository secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret                  | Required? | Value                                                          |
|--------------------------|-----------|-----------------------------------------------------------------|
| `AWS_DEPLOY_ROLE_ARN`    | yes       | ARN of the role created in step 2                                |
| `LICENSE_SIGNING_SECRET` | yes       | The production HMAC signing secret (never the repo's dev default)|
| `STRIPE_API_KEY`         | optional  | Only if `PaymentProvider=stripe` / Stripe Checkout is enabled     |
| `STRIPE_WEBHOOK_SECRET`  | optional  | Only if the Stripe webhook is enabled                            |
| `LEMON_API_KEY`          | optional  | Only if `PaymentProvider=lemonsqueezy`                           |
| `SES_SENDER_EMAIL`       | optional  | Only to enable license-key delivery emails                       |

Leave an optional one unset entirely rather than setting it to an empty
string — `scripts/deploy-license.sh` only adds a `sam deploy`
`--parameter-overrides` entry for a secret that's actually non-empty, and an
explicitly-empty override is what caused the `StripeApiKey= is not a valid
format` failure this workflow was built to stop happening again.

## 4. Optional: require manual approval before deploying

The workflow already targets a GitHub Environment named `production`
(`environment: production`). With no protection rules configured for it,
that's a no-op. To require a human click before every deploy: Settings →
Environments → New environment → `production` → add required reviewers.
