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
          "token.actions.githubusercontent.com:sub": "repo:AryaLi1996@82909467/ruanjian123@1335383385:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

**Do not use the plain `repo:AryaLi1996/ruanjian123:ref:refs/heads/main` form**
— it will never match. This repo (or its owner account) has been renamed at
some point, and GitHub permanently stamps the stable numeric owner/repo IDs
into every OIDC `sub` claim it issues afterward
(`AryaLi1996@82909467`/`ruanjian123@1335383385` above) instead of the plain
names. This isn't a one-time transitional thing that reverts — it's what
every token from this repo will say going forward. The ID-stamped form above
is confirmed correct: it's copied directly from a real CloudTrail
`AssumeRoleWithWebIdentity` event's `userIdentity.userName`, not guessed. If
you ever need to re-derive it yourself (e.g. after another rename, or for a
different repo), the fastest way is to deliberately trigger a failing OIDC
assume-role attempt (any placeholder trust policy) and then read the actual
claim back out of CloudTrail:

```bash
aws cloudtrail lookup-events --region us-east-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 5 --query 'Events[*].Username' --output text
```

**Also do not add `environment: <name>` to the workflow's job** without
updating this trust policy to match — see the big comment at the top of
`.github/workflows/deploy-license.yml` for why: it changes the `sub` claim
shape from `...:ref:refs/heads/main` to `...:environment:<name>` even with
zero protection rules configured on that environment, silently breaking the
condition above. This exact mistake shipped once already and broke every
deploy until caught.

Permissions policy — what `sam build`/`sam deploy` actually needs for this
template: CloudFormation on the `ruanjian-license` stack, the SAM transform
macro that expands `Transform: AWS::Serverless-2016-10-31` into raw
CloudFormation, the SAM-managed S3 bucket (`--resolve-s3`), the Lambda
function + its execution role (`CAPABILITY_NAMED_IAM` — see
`LicenseVerifierRole` in `template.yaml`), the three DynamoDB tables, and
CloudWatch Logs. Start narrow and widen only if a deploy fails on a missing
permission — this list is a starting point, not a guarantee of completeness
for every future template change:

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
      "Sid": "SamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31"
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

**Don't drop the `SamTransform` statement, and note its `Resource` is in
account `aws`, not `641628981129`** — easy to typo away since every other
statement here is scoped to this account. Without it, `sam deploy` fails
with a confirmed-real error once it actually reaches the changeset step
(everything before that — OIDC auth, `sam build`, the S3 upload — succeeds
fine without it, so this one is easy to miss until you get that far):

```
Error: Failed to create changeset for the stack: ruanjian-license, ex: Waiter ChangeSetCreateComplete
failed: ... Reason: User: .../github-deploy-license-for-smooth-voice/GitHubActions is not authorized
to perform: cloudformation:CreateChangeSet on resource:
arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31 because no identity-based policy
allows the cloudformation:CreateChangeSet action
```

Any template using `Transform: AWS::Serverless-2016-10-31` (this one does,
line 2 of `template.yaml`) needs `cloudformation:CreateChangeSet` granted
separately on that AWS-owned transform macro ARN — granting it only on your
own stack ARN (the `CloudFormationStack` statement above) isn't enough,
because expanding the transform is a distinct permission check against a
resource CloudFormation doesn't own on your behalf.

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

The workflow does **not** target a GitHub Environment today — see the
comment at the top of `.github/workflows/deploy-license.yml` for why one
was deliberately removed (it broke OIDC role assumption, see §2 above). To
add a manual-approval gate:

1. Settings → Environments → New environment → e.g. `production` → add
   required reviewers.
2. Add `environment: production` back to the `deploy` job in
   `.github/workflows/deploy-license.yml`.
3. Add a second entry to the trust policy's `sub` condition (IAM
   `StringLike` accepts a list, matched with OR semantics) for the
   environment form of the claim, alongside the `ref:refs/heads/main` one:
   `"repo:AryaLi1996@82909467/ruanjian123@1335383385:environment:production"`.
   Skipping this step reproduces the exact breakage described in §2.
