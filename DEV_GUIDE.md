# SootheVoice — Testing & Developer Operations Guide

> Exact commands for running locally, testing every layer, deploying the serverless function, and producing signed installers.

---

## Quick Reference

```bash
# Run the app in dev mode
npm run dev

# Type-check all TypeScript
npm run typecheck

# Run engine tests (fast, no training)
npm run test:engine

# Build an unsigned installer
npm run build

# Full production build (with PyInstaller bundle)
bash scripts/build.sh
```

---

## 1. Running the App Locally

### 1.1 Prerequisites

Install these before anything else.

```bash
# Node.js 20 LTS — check version
node --version    # must be >= 20
npm  --version    # must be >= 10

# Python 3.11 or 3.12 — check version
python3 --version # must be 3.11.x or 3.12.x

# Confirm Python path (important on macOS with pyenv)
which python3
python3 -c "import sys; print(sys.executable)"
```

### 1.2 Install All Dependencies

```bash
# Clone and enter the project
git clone https://github.com/your-org/ruanjian.git
cd ruanjian

# Node packages (use temp cache if ~/.npm is permission-locked)
npm install --cache "$TMPDIR/npm-cache"

# Core Python packages
python3 -m pip install \
  "numpy>=1.26" \
  "onnx>=1.16" \
  "onnxruntime>=1.18" \
  "soundfile>=0.12" \
  "cryptography>=42"

# PyTorch (CPU-only, ~200 MB — skip if you don't need training)
python3 -m pip install torch \
  --index-url https://download.pytorch.org/whl/cpu

# Verify the engine works before starting the app
python3 engine/main.py '{"method":"ping","args":["hello"]}'
# Expected: {"pong": "hello", "status": "ok"}
```

> **macOS pyenv note**: if `which python3` shows a pyenv shim but packages aren't found,
> install to the active interpreter explicitly:
> ```bash
> /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m pip install ...
> ```

### 1.3 Start the Dev Server

```bash
npm run dev
```

This command:
1. Starts a **Vite dev server** at `http://localhost:5173` (renderer hot-reload)
2. Compiles **main + preload** via esbuild (watches for changes)
3. Launches **Electron** pointing to the dev server

Expected output:
```
  VITE v5.x  ready in 300ms
  ➜  Local:   http://localhost:5173/
[electron] App ready
```

The Electron window opens automatically. Changes to `src/renderer/` hot-reload instantly. Changes to `src/main/` require pressing `Ctrl+R` to reload.

### 1.4 Useful Dev Shortcuts

| Action | Shortcut |
|---|---|
| Open DevTools (renderer) | `F12` or right-click → Inspect |
| Reload renderer | `Ctrl+R` / `Cmd+R` |
| Hard reload (clears cache) | `Ctrl+Shift+R` |
| Reload main process | Kill and re-run `npm run dev` |

### 1.5 Activate the Demo License

On first launch the subscription gate will show "Subscribe to Unlock". To bypass it during development:

1. Click **💎 Subscription** in the sidebar.
2. Enter license key: `RUANJIAN-DEMO-2026`
3. Click **Activate**.

This creates a local 30-day token signed with the dev secret — no network call required.

To reset to "unlicensed" state:
```bash
# macOS
rm ~/Library/Application\ Support/Electron/license.enc 2>/dev/null || true
# Linux/Windows equivalent: delete userData/license.enc
```

### 1.6 Environment Variables (Dev)

Create a `.env` file in the project root (never commit it):

```ini
# License verification endpoint (optional — demo key bypasses this in dev)
LICENSE_URL=http://localhost:3001/verify

# Override HMAC signing secret (must match the serverless function)
LICENSE_SIGNING_SECRET=ruanjian-dev-signing-secret-v1-change-in-production

# Checkout page URL shown in the subscription UI
CHECKOUT_URL=https://ruanjian.app/subscribe
```

`electron-vite` automatically loads `.env` for the main process. Prefix with `VITE_` for renderer access.

---

## 2. Running the Serverless Function Locally

The license verification function (`serverless/verify-license/handler.py`) runs as an AWS Lambda or Alibaba FC function in production. During development you can run it locally in two ways.

### 2.1 Direct Python (simplest — no AWS tools needed)

```bash
cd serverless/verify-license

# Enable mock mode so any key is accepted
export MOCK_MODE=true
export LICENSE_SIGNING_SECRET=ruanjian-dev-signing-secret-v1-change-in-production

# Run a simulated invocation inline
python3 - <<'EOF'
import json, os
os.environ["MOCK_MODE"] = "true"
os.environ["LICENSE_SIGNING_SECRET"] = "ruanjian-dev-signing-secret-v1-change-in-production"

from handler import handler

# Simulate a POST /verify request
event = {
    "httpMethod": "POST",
    "body": json.dumps({"licenseKey": "RUANJIAN-TEST-ABCD-1234", "appVersion": "0.1.0"})
}
result = handler(event, None)
print(json.dumps(json.loads(result["body"]), indent=2))
EOF
```

Expected output:
```json
{
  "valid": true,
  "token": "eyJhbGc...<token>...",
  "expiresIn": 2592000
}
```

### 2.2 Simple HTTP Server (lets the Electron app call it)

```bash
cd serverless/verify-license

# Install a minimal HTTP wrapper (one-time)
python3 -m pip install flask

# Run the local server on port 3001
MOCK_MODE=true \
LICENSE_SIGNING_SECRET=ruanjian-dev-signing-secret-v1-change-in-production \
python3 -c "
from flask import Flask, request, jsonify
from handler import handler
import json

app = Flask(__name__)

@app.route('/verify', methods=['POST', 'OPTIONS'])
def verify():
    event = {'httpMethod': request.method, 'body': request.get_data(as_text=True)}
    res   = handler(event, None)
    return app.response_class(res['body'], status=res['statusCode'],
                               mimetype='application/json')

app.run(port=3001, debug=True)
"
```

Then set in `.env`:
```ini
LICENSE_URL=http://localhost:3001/verify
```

Restart `npm run dev`. Now entering any license key activates the app.

### 2.3 Test the Local Endpoint with curl

```bash
curl -s -X POST http://localhost:3001/verify \
  -H "Content-Type: application/json" \
  -d '{"licenseKey":"RUANJIAN-ANY-KEY-WORKS","appVersion":"0.1.0"}' \
  | python3 -m json.tool
```

### 2.4 Deploy to AWS Lambda

```bash
cd serverless/verify-license

# Package
zip function.zip handler.py

# Create the function (first time only)
aws lambda create-function \
  --function-name ruanjian-verify-license \
  --runtime python3.11 \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-basic \
  --handler handler.handler \
  --zip-file fileb://function.zip \
  --environment Variables="{
    LICENSE_SIGNING_SECRET=REPLACE_WITH_REAL_SECRET,
    PAYMENT_PROVIDER=custom,
    MOCK_MODE=false
  }" \
  --timeout 10

# Update code (subsequent deploys)
aws lambda update-function-code \
  --function-name ruanjian-verify-license \
  --zip-file fileb://function.zip

# Add a public URL (Lambda Function URL — no API Gateway needed)
aws lambda create-function-url-config \
  --function-name ruanjian-verify-license \
  --auth-type NONE \
  --cors '{"AllowOrigins":["*"],"AllowMethods":["POST"]}'

# Get the public URL
aws lambda get-function-url-config \
  --function-name ruanjian-verify-license \
  --query FunctionUrl --output text
```

Set the returned URL in `src/main/license-config.ts`:
```typescript
verificationUrl: 'https://XXXX.lambda-url.us-east-1.on.aws/verify'
```

#### Enabling real Stripe payment verification

By default `PAYMENT_PROVIDER=custom` accepts any sufficiently long license key —
fine for local dev, not a real payment check. To verify actual Stripe
subscriptions:

1. Redeploy (or `update-function-configuration`) with:
   ```
   PAYMENT_PROVIDER=stripe
   STRIPE_API_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...   # from the webhook you create in step 2
   ```
2. In the Stripe Dashboard → Developers → Webhooks, add an endpoint pointing
   at `<your-function-url>/stripe-webhook`, listening for
   `checkout.session.completed`. Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET` above.
3. That's it — the same Lambda now handles both routes by path:
   - `POST <function-url>/` (or `/verify`) → license verification, checks the
     key against Stripe via the Search API
   - `POST <function-url>/stripe-webhook` → on checkout completion, generates
     a license key and writes it to the new subscription's `metadata.license_key`

#### Emailing the license key to the customer

The webhook above stores the key in Stripe; it doesn't tell the customer what
it is. `_send_license_key_email()` in `handler.py` does that via SES, and is
a no-op — not an error — until you configure it:

1. In the SES console, [verify a sender identity](https://console.aws.amazon.com/ses/home#/verified-identities)
   (a single email address is fine to start; verifying a whole domain scales
   better). New AWS accounts start in the **SES sandbox**, which can only send
   to *other verified addresses* — [request production access](https://console.aws.amazon.com/ses/home#/account)
   before relying on this for real customers.
2. Redeploy with `SES_SENDER_EMAIL=you@yourdomain.com` added to the
   environment variables from the previous section. The Lambda's IAM role
   (`serverless/verify-license/template.yaml`, if using SAM — see below) is
   already scoped to allow `ses:SendEmail` **only** `From` that exact
   address, so it doesn't need a separate policy update — the address you set
   here is the identity the role trusts.
3. Trigger a test checkout; check CloudWatch Logs for the `LicenseVerifier`
   function if the email doesn't arrive — `_send_license_key_email()`
   swallows SES errors (bad/unverified sender, sandbox restrictions, etc.) so
   the webhook always still returns 200 and the key is never lost even if the
   email fails, but nothing surfaces the failure reason outside the logs.

If you'd rather not use SES, swap the body of `_send_license_key_email()` for
another provider (Postmark, SendGrid, ...) — same shape as swapping payment
providers in `_check_payment_provider()`.

#### SAM deployment reference

`serverless/verify-license/template.yaml` is the source of truth for every
parameter/env var mentioned above (`PaymentProvider`, `StripeApiKey`,
`StripeWebhookSecret`, `SesSenderEmail`, ...) if you deploy via
`sam deploy` / §2.7 instead of raw `aws lambda` commands.

### 2.5 Deploy to Alibaba Cloud Function Compute

```bash
cd serverless/verify-license

# Install Serverless Devs CLI
npm install -g @serverless-devs/s

# Create s.yaml (one-time)
cat > s.yaml <<'YAML'
edition: 3.0.0
name: ruanjian-license
access: default
resources:
  verify-license:
    component: fc3
    props:
      region: cn-hangzhou
      functionName: ruanjian-verify-license
      runtime: python3.11
      handler: handler.handler
      timeout: 10
      environmentVariables:
        LICENSE_SIGNING_SECRET: REPLACE_WITH_REAL_SECRET
        MOCK_MODE: "false"
      triggers:
        - triggerType: http
          triggerName: httpTrigger
          qualifier: LATEST
          triggerConfig:
            authType: anonymous
            methods: [POST]
YAML

s deploy
```

### 2.6 Test the Deployed Endpoint

```bash
# Replace with your real endpoint URL
ENDPOINT="https://your-function-url.example.com/verify"

curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"licenseKey":"RUANJIAN-REAL-KEY-HERE","appVersion":"0.1.0"}' \
  | python3 -m json.tool
```

### 2.7 Deploy with the SAM Template

The deployable template is [serverless/verify-license/template.yaml](serverless/verify-license/template.yaml). It creates:

- `LicenseVerifier`: Python 3.11 ARM64 Lambda serving both `/` (license verification) and `/stripe-webhook`
- `LicenseVerifierRole`: least-privilege role — CloudWatch Logs, plus `ses:SendEmail` conditioned to only the configured `SesSenderEmail`
- A public Lambda Function URL for the verifier; this is the sole HTTP entry point
- CORS support for `POST`; Lambda Function URLs handle preflight `OPTIONS` requests automatically

The deployment script refuses to run unless the active AWS identity belongs to account `641628981129`.
Configure AWS credentials locally first; never put access keys or the signing secret in the repository.

```bash
aws configure
aws sts get-caller-identity

export AWS_REGION=us-east-1
export LICENSE_SIGNING_SECRET="$(openssl rand -hex 32)"
export PAYMENT_PROVIDER=custom
export MOCK_MODE=false
# To enable real Stripe verification + license-key email (see §2.4 above), also set:
# export PAYMENT_PROVIDER=stripe
# export STRIPE_API_KEY=sk_live_...
# export STRIPE_WEBHOOK_SECRET=whsec_...
# export SES_SENDER_EMAIL=you@yourdomain.com

chmod +x scripts/deploy-license.sh
scripts/deploy-license.sh
```

The script runs `sam build`, deploys with `CAPABILITY_NAMED_IAM`, and prints the Function URL. Set that URL as `verificationUrl` in [src/main/license-config.ts](src/main/license-config.ts), then rebuild the desktop app. The handler accepts the Function URL root and `/verify` path.

For an interactive deployment, copy [serverless/verify-license/samconfig.toml.example](serverless/verify-license/samconfig.toml.example) to `samconfig.toml` and run:

```bash
cd serverless/verify-license
sam build
sam deploy --guided --capabilities CAPABILITY_NAMED_IAM
```

`samconfig.toml` is intentionally not committed because it may contain environment-specific values.

### 2.7.1 CI deployment

[`.github/workflows/deploy-license.yml`](.github/workflows/deploy-license.yml) runs the same `scripts/deploy-license.sh` on every push to `main` that touches `serverless/verify-license/**`, and on a manual `workflow_dispatch`, authenticating to AWS via GitHub OIDC (no long-lived keys stored in GitHub). It runs as three jobs of increasing privilege — `test` (no AWS access at all) → `plan` (a role that can create a change-set but has no `ExecuteChangeSet`, `DeleteStack` or DynamoDB data-plane access, so it prints the exact diff and cannot apply it) → `apply` (gated on the `production` environment's required reviewers). It needs one-time AWS IAM + GitHub Environment setup first — two roles, two environments, environment-scoped secrets — see [`serverless/verify-license/CI_DEPLOY_SETUP.md`](serverless/verify-license/CI_DEPLOY_SETUP.md) for the exact trust policies, permission policies, secrets, and the order to apply them in. Until that's configured, the workflow runs and fails cleanly at the credentials step rather than silently deploying nothing.

---

## 3. Testing

### 3.1 TypeScript Type Check

Checks all three TypeScript configs (root, node/main, web/renderer) — no compilation output, just errors.

```bash
npm run typecheck
```

Zero errors means the codebase is type-safe. Run this before every commit.

### 3.2 Engine Unit & Integration Tests

The test suite (`engine/_test_suite.py`) covers 10 test cases (T01–T10) across all engine modules.

```bash
# Fast mode — 5-second audio, skips training (~30 s total)
npm run test:engine

# Equivalent direct command with more control
cd engine
python3 _test_suite.py --fast --skip training

# Run everything including training (slow — ~2 min)
python3 _test_suite.py

# Run specific categories
python3 _test_suite.py --fast --skip training --skip cover --skip separation

# Save JSON report
python3 _test_suite.py --fast --skip training --output report.json
cat report.json | python3 -m json.tool
```

**Test IDs at a glance:**

| ID | What it tests | Pass condition |
|---|---|---|
| T01 | Device detection | EP is in {CPU, CoreML, CUDA, DirectML} |
| T02 | ONNX inference latency | < 1 ms on CPU |
| T03 | Voice synthesis RT ratio | < 30% real-time on CPU |
| T04 | Standard separation | 4-min equiv < 10 s; crosstalk > −40 dB |
| T05 | Enhanced separation | 4-min equiv < 60 s; 3 stems |
| T06 | Cover V1 (DTW+WSOLA) | RT ratio < 10% |
| T07 | Cover V2 (LSTM expr.) | RT ratio < 50%; vibrato depth > 0 |
| T08 | Standard LoRA training | completes < 1200 s |
| T09 | Watermark round-trip | SNR > 40 dB; correct UID detected |
| T10 | AES model encryption | decrypt matches original; wrong key rejected |

### 3.3 Security Tests

```bash
cd engine
python3 _test_security.py
```

Tests:
1. **Watermark** — embed a blind watermark in a 1-second sine wave, verify it, reject a wrong UID
2. **Model encryption** — encrypt model.onnx, decrypt with correct key (bytes match), reject wrong key
3. **Sandbox** — `AF_INET` socket creation raises `PermissionError` after `sandbox.apply()`

### 3.4 Performance Benchmark

```bash
# Quick benchmark — 1 iteration, 5-second audio
npm run bench:engine

# Full benchmark — 3 iterations, 30-second audio, all modules
cd engine
python3 _bench.py --iters 3 --dur 30 --output bench.json

# Selective modules
python3 _bench.py --iters 3 --dur 10 --only synthesis,sep

# View results
python3 -c "
import json
r = json.load(open('bench.json'))
for b in r['results']:
    print(f\"{b['name']:<35} mean={b['mean']:.3f}s  p95={b['p95']:.3f}s\")
"
```

### 3.5 Test the Python Engine Manually

Any engine method can be called directly from the command line:

```bash
cd engine

# Ping
python3 main.py '{"method":"ping","args":["hello"]}'

# Device detection (ONNX Runtime EP + the PyTorch device training will use)
python3 main.py '{"method":"detect_device","args":[]}'

# Pre-flight environment self-check (Python, dependencies, GPU, RAM, disk)
python3 main.py '{"method":"check_environment","args":[]}'

# Any call can be run with stage diagnostics + a liveness heartbeat on stderr.
# The Electron bridge passes this for every call and streams the output into
# the Training view's engine-log panel.
python3 main.py --verbose '{"method":"check_environment","args":[]}'

# Quick inference
python3 main.py '{"method":"test_inference","args":[]}'

# Synthesize 3 s of audio (Do-Re-Mi scale)
python3 main.py '{"method":"synthesize","args":[{
  "phonemes":["d","o","r","e","m","i"],
  "f0_hz":[294,330,370,392,440,494],
  "durations_sec":[0.5,0.5,0.5,0.5,0.5,0.5]
}]}'

# Standard separation (generates synthetic 30-second audio internally)
python3 main.py '{"method":"separate","args":[{"mode":"standard","duration_sec":30}]}'

# Watermark embed + verify
python3 main.py '{"method":"watermark_embed","args":[{
  "audio":[0.1,0.2,0.3],
  "uid":"test_user",
  "timestamp":1700000000
}]}'
```

### 3.6 CI Simulation (GitHub Actions locally)

Run the same matrix that CI runs, without pushing:

```bash
# Fast test (same as CI)
cd engine
python3 _test_suite.py --fast --skip training --output ci-report.json

# Check pass/fail
python3 -c "
import json, sys
r = json.load(open('ci-report.json'))
print(f\"Passed: {r['summary']['passed']}/{r['summary']['total']}\")
sys.exit(0 if r['summary']['failed'] == 0 else 1)
"
```

### 3.7 Testing the Subscription System

```bash
# Reset to unlicensed state
rm ~/Library/Application\ Support/Electron/license.enc 2>/dev/null; \
rm ~/Library/Application\ Support/Electron/.license_ts 2>/dev/null; \
rm ~/Library/Application\ Support/Electron/.initialized 2>/dev/null

# Start the app — should show subscribe screen
npm run dev

# In the app: enter RUANJIAN-DEMO-2026 → 30-day license activates

# Simulate clock-forward expiry by temporarily modifying the token:
python3 - <<'EOF'
import base64, json, hmac, hashlib

SECRET = "ruanjian-dev-signing-secret-v1-change-in-production"
# Read the encrypted license file and inspect it
import os
p = os.path.expanduser("~/Library/Application Support/Electron/license.enc")
print("License file exists:", os.path.exists(p))
EOF
```

---

## 4. Building Installers

### 4.1 Quick Build (Development / Testing)

Builds the app without the PyInstaller Python bundle. The installer expects Python to already be installed on the target machine. Use for internal testing only.

```bash
# Build and package (creates installer in dist/)
npm run build

# Build unpacked directory (faster, no installer — just test if it launches)
npm run build:unpack
```

Output:
```
dist/
├── mac-universal/SootheVoice.app     (unpacked, --dir mode)
└── SootheVoice-0.1.0-mac.dmg        (full build)
```

### 4.2 Full Production Build (includes Python bundle)

This is the build users install. It embeds a standalone Python executable so no system Python is needed.

```bash
bash scripts/build.sh
```

**What happens internally:**
1. `npm ci` — clean dependency install
2. `scripts/package-engine.sh` — PyInstaller bundles `engine/main.py` + all `.onnx` + deps → `resources/engine-dist/ruanjian-engine/`
3. `npx electron-vite build` — compiles TypeScript main + preload + renderer
4. `npx electron-builder` — packages everything into platform installers

**Time estimates:**
- macOS arm64: ~8 min (PyInstaller 3 min + signing 2 min + DMG 3 min)
- Windows x64: ~12 min (on a Windows machine or via cross-compile)

### 4.3 Building Only for macOS (DMG)

```bash
# Universal DMG (x64 + arm64 in one file)
npm run build:mac-universal

# arm64 only (faster for local testing on Apple Silicon)
npm run build:mac-arm64

# x64 only
npm run build:mac-x64
```

Each command runs `electron-vite build` before `electron-builder`. Do not run
`npx electron-builder` by itself unless `out/main/index.js` already exists.

Output: `dist/SootheVoice-0.1.0-mac-universal.dmg` (~120 MB)

### 4.4 Building Only for Windows (EXE)

> **Important**: `electron-vite build` must always run first — it produces `out/main/index.js`
> which electron-builder packages into the asar. Running `electron-builder` alone will fail with
> *"Application entry file does not exist"*.

#### Option A — Portable EXE (build from macOS or Linux — recommended)

The `portable` target produces a single self-contained `.exe` that runs without installation.
NSIS is **not involved**, so no Wine is needed and the file is never corrupt.

```bash
# Compile TypeScript first (always required)
npx electron-vite build

# Build portable exe (works on macOS / Linux / Windows)
npm run build:win-portable
# output: dist/SootheVoice-0.1.0-win-x64.exe
```

#### Option B — NSIS Installer (must build on Windows or with Wine)

NSIS requires `makensis` to run. On macOS/Linux that needs Wine. Without it electron-builder
produces a **silently corrupt installer** that shows the _"NSIS integrity check failed"_ error
when run on Windows.

```bash
# On a real Windows machine (PowerShell)
npx electron-vite build
npm run build:win-nsis
# output: dist/SootheVoice-0.1.0-win-x64-setup.exe

# From macOS — install Wine first, then build
brew install --cask wine-stable
npx electron-vite build
npm run build:win-nsis
```

#### Option C — Build NSIS on CI (most reliable)

Use the GitHub Actions workflow (`.github/workflows/ci.yml`) which runs on a
`windows-latest` runner — no Wine needed, always produces a valid installer.

```yaml
# Add to ci.yml jobs:
build-windows:
  runs-on: windows-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v5
      with: { node-version: '20' }
    - run: npm ci
    - run: npm run build:win-nsis
    - uses: actions/upload-artifact@v4
      with:
        name: win-installer
        path: dist/*.exe
```

Output sizes:
- Portable: ~80 MB (no Python) / ~250 MB (with Python bundle)
- NSIS installer: ~same size + wrapper overhead

### 4.5 Building for Linux (AppImage + deb)

```bash
npx electron-builder --linux AppImage deb --x64
```

Output:
```
dist/SootheVoice-0.1.0-linux-x86_64.AppImage
dist/SootheVoice-0.1.0-linux-amd64.deb
```

### 4.6 Setting Up Code Signing

#### macOS (Developer ID)
```bash
# Set env vars (get from Xcode / developer.apple.com)
export CSC_LINK="path/to/Developer_ID_Application.p12"
export CSC_KEY_PASSWORD="your_cert_password"
export APPLE_ID="your@apple.id"
export APPLE_ID_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_TEAM_ID="XXXXXXXXXX"

# Build and notarize
npx electron-builder --mac dmg --universal
```

Notarization happens automatically if `afterSign` hook is configured. Without signing, macOS shows Gatekeeper warnings.

#### Windows (EV Code Signing)
```bash
# Env vars (from your cert provider, e.g. DigiCert, Sectigo)
export WIN_CSC_LINK="path/to/certificate.pfx"
export WIN_CSC_KEY_PASSWORD="your_cert_password"

npx electron-builder --win nsis --x64
```

#### Verify the Signed Build
```bash
# macOS
spctl --assess --verbose dist/mac-universal/SootheVoice.app

# macOS DMG
spctl --assess --verbose dist/SootheVoice-0.1.0-mac-universal.dmg

# Windows (run in PowerShell)
Get-AuthenticodeSignature "dist\SootheVoice-0.1.0-win-x64-setup.exe" | Select-Object Status
```

### 4.7 Auto-Update Artifacts

The auto-updater needs these files published alongside the installer:

| File | Purpose |
|---|---|
| `latest-mac.yml` | macOS update manifest |
| `latest.yml` | Windows update manifest |
| `latest-linux.yml` | Linux update manifest |

These are created automatically by `electron-builder` when the `publish` config is set. Upload them to GitHub Releases:

```bash
# Tag and push to trigger a release
git tag v0.1.0
git push origin v0.1.0

# Or upload manually via GitHub CLI
gh release create v0.1.0 \
  dist/SootheVoice-0.1.0-mac-universal.dmg \
  dist/SootheVoice-0.1.0-win-x64-setup.exe \
  dist/latest-mac.yml \
  dist/latest.yml \
  --title "SootheVoice v0.1.0" \
  --notes "Initial release"
```

### 4.8 Configure Update Server

Edit `electron-builder.js` publish section:
```js
publish: [{
  provider: 'github',
  owner:    'your-github-org',   // or set GITHUB_OWNER env var
  repo:     'ruanjian',          // or set GITHUB_REPO env var
  releaseType: 'release',
}]
```

For a private S3 bucket instead:
```js
publish: [{
  provider: 'generic',
  url: 'https://updates.ruanjian.app',
}]
```

---

## 5. Common Workflows

### Full Dev-to-Release Checklist

```bash
# 1. Ensure all tests pass
npm run typecheck
npm run test:engine

# 2. Update version in package.json
#    (edit "version": "0.1.0" → "0.2.0")

# 3. Commit
git add -A
git commit -m "chore: release v0.2.0"
git tag v0.2.0

# 4. Full production build
bash scripts/build.sh

# 5. Test the installer locally
open dist/SootheVoice-0.2.0-mac-universal.dmg   # macOS
# or: dist/SootheVoice-0.2.0-win-x64-setup.exe  # Windows

# 6. Publish release
git push origin main --tags
gh release create v0.2.0 dist/* --title "v0.2.0"
```

### Rebuild Python Bundle Only

If you change engine Python files but not the renderer/main TypeScript:

```bash
bash scripts/package-engine.sh
npx electron-builder
```

### Rebuild Renderer Only (Fast Iteration)

```bash
npx electron-vite build --mode renderer
npx electron-builder --dir   # unpack only
```

### Reset Everything

```bash
# Delete all build artifacts
rm -rf out/ dist/ resources/engine-dist/

# Delete Python cache
find engine -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
find engine -name '*.pyc' -delete 2>/dev/null || true

# Reinstall Node deps
rm -rf node_modules/
npm install --cache "$TMPDIR/npm-cache"
```

---

## 6. Troubleshooting Build Issues

### `npm run dev` — Electron window doesn't open

```bash
# Check if the port 5173 is already in use
lsof -i :5173

# Kill the occupying process
kill -9 $(lsof -t -i :5173)
```

### `electron-vite build` — TypeScript errors

```bash
npm run typecheck 2>&1 | head -40
```

Fix all errors before re-running the build. The most common cause is a type missing from `global.d.ts` after adding new IPC methods.

### PyInstaller — `ModuleNotFoundError` in packaged app

Add the missing module to `scripts/package-engine.sh`:
```bash
pyinstaller main.py \
  ...
  --hidden-import missing_module_name \
  ...
```

Then rebuild:
```bash
bash scripts/package-engine.sh
npx electron-builder
```

### PyInstaller — build itself fails

```bash
# Check PyInstaller is installed
python3 -m PyInstaller --version

# Re-install if missing
python3 -m pip install pyinstaller

# Run with verbose output to see which import fails
cd engine
python3 -m PyInstaller main.py --onedir --name ruanjian-engine --log-level DEBUG 2>&1 | tail -50
```

### `electron-builder` — DMG creation fails on macOS

```bash
# Install create-dmg if missing
brew install create-dmg

# Or use electron-builder's built-in (already included)
# If the error is about hdiutil, repair disk permissions:
diskutil repairPermissions /
```

### Windows EXE not signed / SmartScreen warning

This is expected for development builds without an EV code-signing certificate. Users can click "More info → Run anyway". For production, purchase a code-signing cert and set `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.

### NSIS Error — "Installer integrity check has failed"

```
NSIS Error: installer integrity check has failed. Common causes include
incomplete download and damaged media.
```

**Cause**: NSIS installers built on macOS or Linux without Wine are silently
corrupt. `electron-builder` calls `makensis` to compile the installer script;
on macOS that requires Wine to run the Windows binary. Without Wine, the output
`.exe` is incomplete and Windows NSIS rejects it at launch.

**Fix A — use the portable target (no Wine needed)**:
```bash
npx electron-vite build
npm run build:win-portable   # produces a single-exe, no NSIS
```

**Fix B — install Wine, then build NSIS**:
```bash
brew install --cask wine-stable   # macOS only, ~1 GB download
npx electron-vite build
npm run build:win-nsis
```

**Fix C — build on a real Windows machine or GitHub Actions**:
Add a `windows-latest` job to `.github/workflows/ci.yml` (see section 4.4).

**Verify Wine is found before building**:
```bash
which wine            # must print a path, e.g. /usr/local/bin/wine
wine --version        # must not error
```

### License endpoint not reachable in packaged app

The packaged app's `net.request` goes through Electron's networking stack, which respects the system proxy. If requests fail:
1. Check the endpoint URL in `src/main/license-config.ts`.
2. Ensure the Lambda/FC function URL is HTTPS (required in packaged apps).
3. Test with `curl` from the same machine.

### Blank / invisible window on Windows 10 VM

**Symptom**: App launches (visible in Task Manager) but no window appears, or window appears white/black and unresponsive.

**Cause**: Electron's GPU process (Chromium compositor) crashes inside a hypervisor (VMware, VirtualBox, Hyper-V, Parallels) because the VM's virtual GPU doesn't support the required DirectX / OpenGL level. The `ready-to-show` event never fires so the window stays hidden.

**Already fixed in `src/main/index.ts`** (as of this commit):
- `app.disableHardwareAcceleration()` — forces CPU (SwiftShader) compositing; GPU crash impossible
- `app.commandLine.appendSwitch('no-sandbox')` — removes Chromium job-object sandbox that conflicts with some hypervisors
- `app.commandLine.appendSwitch('use-angle', 'swiftshader')` — SwANGLE software renderer for Windows when D3D is unavailable
- 5-second fallback `setTimeout(() => win.show(), 5000)` — shows the window even if `ready-to-show` never fires

**If the window still doesn't appear after rebuilding:**
```bash
# 1. Confirm the fixes were compiled
grep -c "disableHardwareAcceleration\|swiftshader" out/main/index.js
# Must be > 0

# 2. Check the Electron log inside the VM
# Windows: %AppData%\ruanjian\logs\main.log
# Look for: "GPU process" or "crashed" lines

# 3. Run from the command line to see stderr
"C:\Program Files\SootheVoice\SootheVoice.exe" 2>&1 | more
# Look for: "DXGI", "d3d", "swiftshader" messages

# 4. Force software rendering via env var as a last resort
set LIBGL_ALWAYS_SOFTWARE=1
"C:\Program Files\SootheVoice\SootheVoice.exe"
```

**VM-specific notes:**
| VM | Known fix |
|---|---|
| VMware Workstation | Enable **3D acceleration** in VM settings → Display |
| VirtualBox | Install **VirtualBox Guest Additions** and enable 3D acceleration |
| Hyper-V | Enable **Enhanced Session** mode; disable Hyper-V video driver |
| Parallels | Update to Parallels Tools; set Display → Use video memory for best performance |
