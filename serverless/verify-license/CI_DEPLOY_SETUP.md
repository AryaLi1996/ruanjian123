# CI deploy setup for the license backend

`.github/workflows/deploy-license.yml` runs `scripts/deploy-license.sh` on
every push to `main` that touches `serverless/verify-license/**`, and on a
manual `workflow_dispatch`. It authenticates to AWS via GitHub's OIDC
provider — no long-lived AWS access keys are stored in GitHub — but that
means IAM roles have to exist first, trusted specifically by this repo.
This is one-time AWS setup; nothing here runs automatically.

The workflow is split into three jobs so that no single job holds both the
ability to see production and the ability to change it:

| Job | AWS role | Can it change production? | Gate |
|---|---|---|---|
| `test`  | none — no `id-token` permission at all | no | — |
| `plan`  | `AWS_PLAN_ROLE_ARN` (§2a) — no `ExecuteChangeSet`, no `DeleteStack`, no DynamoDB data plane | **no** | — |
| `apply` | `AWS_DEPLOY_ROLE_ARN` (§2b) | yes | `production` environment reviewers |

`plan` prints the exact CloudFormation change-set; a reviewer reads it and
then releases `apply`. So set up **both** roles below — the workflow will
fail at `plan` if only the deploy role exists.

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

## 2. IAM roles this workflow assumes

Two roles, one per AWS-touching job. They differ **only** in their
permission policy and in the `sub` their trust policy accepts; everything
else below is shared.

### 2a. Trust policies

Scoped to this exact repo, and to the GitHub Environment the job names, so
no other repo, branch or job can assume either role. Create the same shape
twice, changing only the `environment:` suffix — `license-plan` for the
plan role, `production` for the deploy role:

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
          "token.actions.githubusercontent.com:sub": "repo:AryaLi1996@82909467/ruanjian123@1335383385:environment:production"
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

**The `environment:` form does not encode the branch.** A `sub` of
`...:ref:refs/heads/main` pinned deploys to `main` in IAM itself; the
`...:environment:production` form does not — it says which environment the
job named, not which ref it ran from. Since the workflow can now be started
by `workflow_dispatch` from any branch, that pinning has to be restored on
the GitHub side instead: in **Settings → Environments → `production` (and
`license-plan`) → Deployment branches**, select *Selected branches* and
allow `main` only. Without that, a dispatch from any branch in this repo
gets a matching `sub` and assumes the role. Do not skip it — it is the only
thing enforcing "production is deployed from `main`" once these roles are
in place.

**Renaming an environment in the workflow means editing the trust policy in
the same change** — see the big comment at the top of
`.github/workflows/deploy-license.yml`. Naming an environment changes the
`sub` claim shape even with zero protection rules configured, and this
exact mistake shipped once already (as `environment: production` on a
`ref:`-form trust policy) and broke every deploy until caught.

**Migration order matters.** If these roles currently trust the
`ref:refs/heads/main` form, add the `environment:` entry *before* merging
the workflow change, not after — IAM `StringLike` accepts a list, matched
with OR semantics, so both can be live at once:

```json
"token.actions.githubusercontent.com:sub": [
  "repo:AryaLi1996@82909467/ruanjian123@1335383385:ref:refs/heads/main",
  "repo:AryaLi1996@82909467/ruanjian123@1335383385:environment:production"
]
```

Once a run has gone green on the new workflow, drop the `ref:` entry — with
the environment form live, leaving it in means any `main` push can still
assume the role from a job that names no environment at all, bypassing the
approval gate.

### 2b. Permissions policy — deploy role (`AWS_DEPLOY_ROLE_ARN`)

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
      "Action": ["s3:CreateBucket", "s3:GetBucketLocation", "s3:GetBucketPolicy",
                 "s3:PutBucketPolicy", "s3:PutBucketTagging", "s3:PutBucketVersioning",
                 "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock",
                 "s3:ListBucket", "s3:GetObject", "s3:PutObject"],
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
      "Sid": "DynamoDbTablesControlPlaneOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeTable",
                 "dynamodb:UpdateTable", "dynamodb:DescribeTimeToLive",
                 "dynamodb:UpdateTimeToLive", "dynamodb:DescribeContinuousBackups",
                 "dynamodb:UpdateContinuousBackups", "dynamodb:TagResource",
                 "dynamodb:UntagResource", "dynamodb:ListTagsOfResource"],
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

**Why `DynamoDbTablesControlPlaneOnly` is not `dynamodb:*`.** Deploying
only ever creates and updates tables; it never reads or writes rows.
`dynamodb:*` on those table ARNs additionally granted `Scan`, `GetItem`,
`Query` and `DeleteItem` — i.e. anything able to run this workflow could
have exfiltrated every license, order and trial record, or emptied them,
without touching the Lambda at all. The Lambda's own execution role
(`LicenseVerifierRole` in `template.yaml`) is the one that legitimately
holds data-plane access, and it is already narrow
(`GetItem`/`PutItem`/`UpdateItem`/`Query`). `DeleteTable` stays because
CloudFormation needs it to roll back a failed create. `s3:*` was narrowed
for the same reason — it included `DeleteBucket` on the artifact bucket.

`lambda:*` and `logs:*` are still wildcards, though scoped to the
`ruanjian-license-*` ARN prefix. Narrowing them is a reasonable follow-up;
neither exposes customer data, which is why the DynamoDB statement was the
one worth fixing first.

### 2c. Permissions policy — plan role (`AWS_PLAN_ROLE_ARN`)

Same trust policy shape as §2a but with `:environment:license-plan`, and a
permission policy that can produce a change-set and nothing else. The
absence of `cloudformation:ExecuteChangeSet`, `DeleteStack`, `UpdateStack`
and `CreateStack` is the entire point — do not add them "to make the plan
job more useful":

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ChangeSetPreviewOnly",
      "Effect": "Allow",
      "Action": ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
                 "cloudformation:ListChangeSets", "cloudformation:DescribeStacks",
                 "cloudformation:DescribeStackEvents", "cloudformation:GetTemplateSummary"],
      "Resource": "arn:aws:cloudformation:us-east-1:641628981129:stack/ruanjian-license/*"
    },
    {
      "Sid": "CloudFormationPreflight",
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
      "Sid": "SamManagedBucketUploadOnly",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::aws-sam-cli-managed-*", "arn:aws:s3:::aws-sam-cli-managed-*/*"]
    },
    {
      "Sid": "ReadDeployedShape",
      "Effect": "Allow",
      "Action": ["lambda:GetFunction", "lambda:GetFunctionConfiguration",
                 "lambda:GetFunctionUrlConfig", "dynamodb:DescribeTable", "iam:GetRole"],
      "Resource": "*"
    }
  ]
}
```

Two things to expect the first time you use it:

- **`s3:CreateBucket` is deliberately absent.** With `--resolve-s3`, SAM
  creates the managed artifact bucket if it does not exist — so on a brand
  new account the plan job fails until one `apply` run (or a local
  `scripts/deploy-license.sh`) has created it. That is the intended
  trade-off: a preview role should not be able to create buckets.
- **`iam:PassRole` is absent too.** CloudFormation checks it when a
  change-set is *executed*, not created, so a plan should not need it. If a
  plan ever fails with a `PassRole` denial, add it scoped to
  `arn:aws:iam::641628981129:role/ruanjian-license-*` — that is still far
  short of being able to apply anything.

`ReadDeployedShape` is `Resource: "*"` because these are read-only
describe/get calls that CloudFormation makes while diffing, and several of
them (notably `iam:GetRole`) reject ARN-scoped policies less predictably
than they should. If you prefer, scope `lambda:*`/`dynamodb:DescribeTable`
to the `ruanjian-license-*` prefixes and widen only if a plan fails.

## 3. GitHub Environments and their secrets

Create both environments first — Settings → Environments → New environment:

| Environment    | Protection rules                                                        |
|----------------|-------------------------------------------------------------------------|
| `license-plan` | Deployment branches: **Selected branches → `main`**. No reviewers — this is a secret boundary, not a gate; requiring approval here would only mean approving twice. |
| `production`   | Deployment branches: **Selected branches → `main`**, **plus required reviewers**. This is the approval gate: until a reviewer releases the run, `AWS_DEPLOY_ROLE_ARN` is never issued and nothing is applied. |

Then add the secrets **on each environment** (Environment secrets), not as
repository secrets:

| Secret                  | `license-plan` | `production` | Value                                                          |
|--------------------------|----------------|--------------|-----------------------------------------------------------------|
| `AWS_PLAN_ROLE_ARN`      | yes            | —            | ARN of the plan role (§2c)                                       |
| `AWS_DEPLOY_ROLE_ARN`    | —              | yes          | ARN of the deploy role (§2b)                                     |
| `LICENSE_SIGNING_SECRET` | yes            | yes          | The production HMAC signing secret (never the repo's dev default)|
| `STRIPE_API_KEY`         | optional       | optional     | Only if `PaymentProvider=stripe` / Stripe Checkout is enabled     |
| `STRIPE_WEBHOOK_SECRET`  | optional       | optional     | Only if the Stripe webhook is enabled                            |
| `LEMON_API_KEY`          | optional       | optional     | Only if `PaymentProvider=lemonsqueezy`                           |
| `SES_SENDER_EMAIL`       | optional       | optional     | Only to enable license-key delivery emails                       |

**Why environment secrets rather than repository secrets.** A repository
secret is readable by *any* workflow in this repo, including one added or
edited in a branch — so `LICENSE_SIGNING_SECRET`, the key that mints valid
licenses, was one new workflow file away from being printed. Scoped to an
environment, only a job that names that environment can read it, and
`production` additionally requires a reviewer. **Delete the old repository
copies** once the environment ones are in place; leaving them defeats the
change.

**Why `plan` needs the signing secret at all.** `template.yaml`'s
`LicenseSigningSecret` parameter is `NoEcho: true` with `MinLength: 32`, so
a change-set cannot reuse or read back the deployed value. Passing a dummy
would make every plan show a spurious parameter change and mark dependent
resources as modified — the diff would be noise, which defeats the point of
having a reviewer read it. The plan role cannot execute anything, so the
secret's presence there does not let that job ship a deploy.

Leave an optional one unset entirely rather than setting it to an empty
string — `scripts/deploy-license.sh` only adds a `sam deploy`
`--parameter-overrides` entry for a secret that's actually non-empty, and an
explicitly-empty override is what caused the `StripeApiKey= is not a valid
format` failure this workflow was built to stop happening again.

## 4. Rollout order

Every step here is on the AWS/GitHub side and has to be done by a human
with those consoles. Getting the order wrong breaks deploys rather than
losing anything, but it does break them:

1. **Create the plan role** (§2a trust policy with `:environment:license-plan`,
   §2c permission policy).
2. **Add `:environment:production` to the existing deploy role's trust
   policy**, *alongside* its current `ref:refs/heads/main` entry (§2a shows
   the two-entry list). Do this before merging the workflow change.
3. **Narrow the deploy role's permission policy** to the §2b version
   (`dynamodb` control plane, scoped `s3`). Safe to do at any point; it
   removes only permissions deploying never used.
4. **Create both environments** with their branch restrictions and
   `production`'s reviewers, and add the environment secrets (§3).
5. **Merge the workflow change.** The first run stops at `apply` waiting
   for a reviewer — that is the gate working.
6. **After a green run**, delete the repository-level copies of the secrets
   and drop the `ref:refs/heads/main` entry from the deploy role's trust
   policy. Until you do, a job naming no environment can still assume it
   and bypass the gate.

## 5. What this setup does and does not protect against

Worth being explicit, because "requires approval" invites more confidence
than it earns:

- **Protected:** an automated or accidental push cannot silently change
  production; the credential that can is only issued after a human releases
  the run. CI can no longer read or delete customer license/trial/order
  rows. The license-signing key is no longer readable by every workflow in
  the repo.
- **Not protected:** anyone who can approve a `production` run can deploy
  anything, including a change-set that differs from what they read — the
  `apply` job recomputes its own change-set rather than executing the one
  `plan` printed. Same commit and parameters, so the same diff in practice,
  but it is a trust-the-inputs design, not a cryptographic one. Anyone with
  repo write access can still edit this workflow in a PR; branch protection
  on `main` (and a `CODEOWNERS` entry on `.github/workflows/`) is what
  covers that, and neither is configured in this repo today.
