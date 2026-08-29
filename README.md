# SootheVoice — Developer README

> **Stack**: Electron 31 · Vite 5 · React 18 · TypeScript 5.6 · Python 3.11 · ONNX Runtime 1.28  
> **Repo created**: 2026-08-12

---

## Table of Contents

1. [Repository Structure](#1-repository-structure)
2. [Architecture Overview](#2-architecture-overview)
3. [Development Setup](#3-development-setup)
4. [Running in Development](#4-running-in-development)
5. [Building for Production](#5-building-for-production)
6. [Python Engine](#6-python-engine)
7. [IPC API Reference](#7-ipc-api-reference)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Subscription & License System](#9-subscription--license-system)
10. [Security Architecture](#10-security-architecture)
11. [CI / CD Pipeline](#11-ci--cd-pipeline)
12. [Adding New Engine Methods](#12-adding-new-engine-methods)
13. [Adding New UI Views](#13-adding-new-ui-views)
14. [Performance Targets & Benchmarks](#14-performance-targets--benchmarks)
15. [Troubleshooting (Developer)](#15-troubleshooting-developer)
16. [Known Limitations & Roadmap](#16-known-limitations--roadmap)

---

## 1. Repository Structure

```
ruanjian/
├── .github/
│   └── workflows/
│       └── ci.yml                   # GitHub Actions: test matrix + benchmark
├── build/
│   └── entitlements.mac.plist       # macOS hardened-runtime entitlements
├── engine/                          # Python AI engine (all ML logic)
│   ├── main.py                      # Engine entry point (JSON-in / JSON-out CLI)
│   ├── device_detector.py           # ONNX EP detection (CPU/CoreML/CUDA/DirectML)
│   ├── inference.py                 # MatMul latency test (ORT warm-up)
│   ├── synthesizer.py               # Micro-VITS singing voice synthesizer
│   ├── separation.py                # Overlap-add source separation
│   ├── cover_synthesis.py           # DTW+WSOLA (V1) and LSTM expression (V2) cover
│   ├── trainer.py                   # PyTorch LoRA/LoRA+ training utilities
│   ├── train_standard.py            # CLI: standard training
│   ├── train_professional.py        # CLI: professional training
│   ├── watermark.py                 # Blind watermark embed + verify
│   ├── model_crypto.py              # AES-256-GCM model file encryption
│   ├── sandbox.py                   # Python network sandbox (socket patching)
│   ├── _test_suite.py               # End-to-end test suite (T01–T10)
│   ├── _bench.py                    # Multi-iteration performance benchmark
│   ├── _test_security.py            # Security acceptance tests
│   ├── requirements.txt             # Python dependencies
│   └── *.onnx                       # Stub models (auto-generated on first run)
├── scripts/
│   ├── build.sh                     # Full production build (4 steps)
│   └── package-engine.sh            # PyInstaller standalone bundle
├── serverless/
│   └── verify-license/
│       └── handler.py               # AWS Lambda / Alibaba FC license verifier
├── src/
│   ├── main/                        # Electron main process (Node.js)
│   │   ├── index.ts                 # App entry: window, IPC handlers, lifecycle
│   │   ├── python-bridge.ts         # Spawn + communicate with Python engine
│   │   ├── model-crypto.ts          # Machine-bound AES-256-GCM key + file ops
│   │   ├── auto-updater.ts          # electron-updater wrapper
│   │   ├── subscription-monitor.ts  # License token verify + grace period
│   │   └── license-config.ts        # ← single file to change payment provider
│   ├── preload/
│   │   ├── index.ts                 # contextBridge: exposes window.engine.*
│   │   └── index.d.ts               # TypeScript types for main-process preload
│   └── renderer/                    # React UI (Vite + React 18)
│       ├── index.html
│       └── src/
│           ├── App.tsx              # Root: onboarding gate → Layout
│           ├── main.tsx             # React DOM root
│           ├── global.d.ts          # Window.engine type declaration
│           ├── vite-env.d.ts
│           ├── components/
│           │   ├── Layout.tsx        # Shell: Sidebar + SubscriptionGate + view router
│           │   ├── Sidebar.tsx       # Navigation + update banner + engine status
│           │   ├── SubscriptionGate.tsx  # Feature lock wrapper
│           │   ├── cover/
│           │   │   ├── StepWizard.tsx
│           │   │   ├── StemPlayer.tsx
│           │   │   ├── MixingConsole.tsx  # Web Audio API mixer
│           │   │   └── ExportPanel.tsx
│           │   ├── onboarding/
│           │   │   └── OnboardingFlow.tsx
│           │   └── training/
│           │       ├── AudioDropzone.tsx
│           │       ├── ModeSelector.tsx
│           │       ├── TrainingProgress.tsx
│           │       ├── AudioPlayer.tsx
│           │       └── ModelCard.tsx
│           ├── hooks/
│           │   └── useEngine.ts          # IPC call wrapper with busy/status state
│           ├── store/
│           │   ├── useAppStore.ts        # Active view, engine status, trained models
│           │   └── useSubscriptionStore.ts  # License state (mirrors main process)
│           ├── styles/
│           │   └── app.css              # All CSS (dark theme, components)
│           ├── utils/
│           │   ├── audio.ts             # PCM→WAV, waveform canvas, formatDuration
│           │   └── crypto.ts            # AES-256-GCM (Web Crypto API)
│           └── views/
│               ├── TrainingView.tsx
│               ├── CoverView.tsx
│               ├── AudioToolsView.tsx
│               └── SubscriptionView.tsx
├── electron-builder.js                  # Packaging config (extraResources, publish)
├── electron.vite.config.ts             # electron-vite build config
├── package.json
├── tsconfig.json
├── tsconfig.node.json                  # Main + preload TypeScript config
└── tsconfig.web.json                   # Renderer TypeScript config
```

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Renderer (Chromium)                                   │
│  React 18 · Zustand · Vite                                      │
│  window.engine.*  (contextBridge)                               │
└──────────────────┬──────────────────────────────────────────────┘
                   │ IPC (ipcRenderer.invoke / ipcMain.handle)
                   │ Events (ipcRenderer.on / webContents.send)
┌──────────────────▼──────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                                │
│  SubscriptionMonitor · ModelCrypto · AutoUpdater · FileSystem   │
└──────────────────┬──────────────────────────────────────────────┘
                   │ child_process.spawn (JSON payload via argv[1])
                   │ stdout: JSON lines (progress + final result)
                   │ stderr: diagnostics (discarded by bridge)
┌──────────────────▼──────────────────────────────────────────────┐
│  Python Engine (sandboxed subprocess)                           │
│  ONNX Runtime · NumPy · soundfile · torch (training only)       │
│  sandbox.py patches socket to block outbound network           │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Python subprocess per call | Isolates crashes; no global state leaks between calls; easy sandbox |
| JSON over stdout | Simple, language-agnostic, supports streaming progress (one line per epoch) |
| ONNX Runtime | Hardware-accelerated inference without CUDA requirement; supports CPU/CoreML/DirectML |
| electron-vite | Handles main + preload + renderer build in one config; HMR in dev |
| Zustand | Minimal boilerplate; direct selector subscriptions; no Redux ceremony |
| contextBridge (sandbox: false) | Needed for Web Audio API and file:// access; mitigated by explicit allow-list |
| Machine-bound model key | Models cannot be extracted from one machine and used on another |

---

## 3. Development Setup

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20.x LTS | https://nodejs.org |
| Python | 3.11 or 3.12 | https://python.org or `pyenv` |
| npm | 10+ | bundled with Node |

### Clone and Install

```bash
git clone https://github.com/your-org/ruanjian.git
cd ruanjian

# Node dependencies
npm install --cache "$TMPDIR/npm-cache"

# Python dependencies (core)
python3 -m pip install numpy>=1.26 onnx>=1.16 onnxruntime>=1.18 soundfile>=0.12 cryptography>=42

# Python dependencies (training — optional, heavy)
python3 -m pip install torch --index-url https://download.pytorch.org/whl/cpu
```

### Environment Notes

- The project uses **pyenv** on macOS. Verify `python3 -c "import onnxruntime"` works before running the app.
- If using the macOS system Python (3.11 at `/Library/Frameworks/Python.framework/Versions/3.11`), install packages with the full path:  
  `/Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m pip install ...`
- For Windows: the dev build uses system Python. The production build bundles a PyInstaller executable.

---

## 4. Running in Development

```bash
# Start Electron + Vite dev server (hot reload for renderer)
npm run dev
```

This runs `electron-vite dev` which:
1. Starts a Vite dev server for the renderer on `http://localhost:5173`
2. Compiles main + preload with esbuild (watching for changes)
3. Launches Electron pointing to the dev server URL

### Dev-Mode Shortcuts

| Action | How |
|---|---|
| Reload renderer | `Ctrl+R` / `Cmd+R` in the Electron window |
| Open DevTools | `F12` or right-click → Inspect |
| Hard reload + clear cache | `Ctrl+Shift+R` |
| Test Python engine directly | `cd engine && python3 main.py '{"method":"ping","args":[]}'` |

### Subscription in Dev Mode
The subscription system is **active in dev mode**. To bypass it for UI development:
1. Enter `RUANJIAN-DEMO-2026` on the Subscription page — this creates a local 30-day token without hitting any server.
2. Or: delete `~/.../Application Support/ruanjian/license.enc` to reset to unlicensed state for testing.

---

## 5. Building for Production

### Quick Build (no Python bundle)
```bash
npm run build           # electron-vite build + electron-builder
npm run build:unpack    # same but outputs unpacked directory (faster, for testing)
```

### Full Production Build (with Python bundle)
```bash
bash scripts/build.sh
```

This runs 4 steps:
1. `npm ci` — clean install
2. `scripts/package-engine.sh` — PyInstaller standalone bundle → `resources/engine-dist/`
3. `electron-vite build` — compile renderer + main + preload
4. `electron-builder` — package installer

### Output Files
```
dist/
├── SootheVoice-0.1.0.dmg                    # macOS installer
├── SootheVoice-0.1.0-win-x64-setup.exe      # Windows NSIS installer
├── SootheVoice-0.1.0-linux-x86_64.AppImage  # Linux AppImage
└── latest.yml / latest-mac.yml           # electron-updater manifest
```

### Code Signing
- **macOS**: Set `CSC_LINK` and `CSC_KEY_PASSWORD` env vars with your Developer ID certificate.
- **Windows**: Set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` with your code-signing cert (`.pfx`).
- Without signing, macOS shows a Gatekeeper warning and Windows shows SmartScreen.

### Auto-Update Configuration
Set these env vars before building to configure the update server:
```bash
export GITHUB_OWNER=your-github-org
export GITHUB_REPO=ruanjian
```
Or edit `electron-builder.js` → `publish[0].owner/repo`.

---

## 6. Python Engine

### Entry Point

`engine/main.py` reads `sys.argv[1]` as a JSON payload:

```json
{ "method": "ping", "args": ["hello"] }
```

and writes a JSON result to stdout:

```json
{ "pong": "hello", "status": "ok" }
```

For streaming methods (e.g., `train_model`), multiple JSON lines are emitted — one per epoch — before the final result line. The TypeScript bridge reads the **last** non-empty JSON line as the final result.

### Adding a New Method

1. Add a handler function in `engine/main.py`:
```python
def my_new_method(args):
    params = args[0] if args and isinstance(args[0], dict) else {}
    # ... do work ...
    return {"result": "value"}
```

2. Register it in the `HANDLERS` dict:
```python
HANDLERS = {
    ...
    "my_new_method": my_new_method,
}
```

3. Call from TypeScript:
```typescript
const result = await window.engine.call('my_new_method', { param: 'value' })
```

### Sandbox
`sandbox.py` is imported at the top of `main.py` and patches `socket.socket` to block `AF_INET`/`AF_INET6` connections. This prevents the engine from making outbound network calls even if a dependency tries to phone home.

- `AF_UNIX` is **allowed** (needed for CoreML/CUDA local IPC).
- The sandbox is applied **before** any other imports.
- To debug sandbox issues: temporarily comment out `import sandbox; _sb.apply()` in `main.py`.

### ONNX Models
All ONNX models are **stub models** created programmatically on first run. Real models from production training replace these files.

| File | Purpose | Created by |
|---|---|---|
| `model.onnx` | Default synthesis model | `synthesizer.build_stub_model()` |
| `model_standard.onnx` | After standard training | `trainer.export_to_onnx()` |
| `model_professional.onnx` | After professional training | `trainer.export_to_onnx()` |
| `demucs_nano.onnx` | Standard separation | `separation._build_fir_separator()` |
| `sep_main.onnx` | Enhanced separation stage 1 | `separation._build_fir_separator()` |
| `vocal_harmony_split.onnx` | Enhanced separation stage 2 | `separation._build_vocal_harmony_split()` |
| `dereverb.onnx` | Enhanced separation stage 3 | `separation._build_dereverb()` |
| `expression_encoder.onnx` | V2 cover LSTM encoder | `cover_synthesis._build_expression_encoder()` |
| `watermark_embed.onnx` | Watermark embedding | `watermark.build_watermark_model()` |

---

## 7. IPC API Reference

All IPC is exposed via `window.engine.*` in the renderer. The preload (`src/preload/index.ts`) maps these to `ipcRenderer.invoke` calls.

### Engine Call Methods

| Method | Signature | Description |
|---|---|---|
| `call` | `(method, ...args) → Promise<unknown>` | One-shot engine call; resolves with last JSON line |
| `stream` | `(method, ...args) → Promise<unknown>` | Streaming call; emits `engine:progress` events per line |
| `onProgress` | `(cb) → unsubscribe` | Subscribe to streaming progress; returns cleanup fn |
| `saveTrainingFiles` | `(files[]) → Promise<string>` | Save `{name, buffer}[]` to userData; returns dir path |
| `readFile` | `(path) → Promise<ArrayBuffer>` | Read local file via IPC (bypasses web security) |

### Model Security Methods

| Method | Signature | Description |
|---|---|---|
| `encryptModel` | `(path) → {encPath, sizeBytes}` | Encrypt `.onnx` → `.enc` with machine key |
| `decryptVerify` | `(path) → {decrypted, error?}` | Decrypt `.enc` and verify it loads in ORT |
| `getModelKeyHex` | `() → string` | Return 64-char hex key for passing to Python engine |

### App Lifecycle Methods

| Method | Signature | Description |
|---|---|---|
| `isFirstLaunch` | `() → Promise<boolean>` | True if `userData/.initialized` absent |
| `markInitialized` | `() → Promise<void>` | Create `userData/.initialized` |

### Auto-Updater Methods

| Method | Signature | Description |
|---|---|---|
| `updaterDownload` | `() → void` | Trigger update download |
| `updaterQuitInstall` | `() → void` | Quit and install downloaded update |
| `onUpdaterEvent` | `(cb) → unsubscribe` | Subscribe to all updater events |

**Updater events**: `updater:checking`, `updater:available`, `updater:not-available`, `updater:progress`, `updater:downloaded`, `updater:error`

### License / Subscription Methods

| Method | Signature | Description |
|---|---|---|
| `getLicenseState` | `() → SubscriptionState` | Current license status and payload |
| `activateLicense` | `(key) → ActivationResult` | Verify key, store token, update state |
| `deactivateLicense` | `() → void` | Delete local token; reset to unlicensed |
| `refreshLicense` | `() → void` | Re-verify with server; update local token |
| `onLicenseStateChange` | `(cb) → unsubscribe` | Subscribe to pushed state changes |

### Engine Method Reference (Python `HANDLERS`)

```
ping                 →  {pong, status}
detect_device        →  {ep, provider, providers, platform, python,
                         torch_available, cuda_available, mps_available,
                         gpu_available, gpu_name, training_device, detail}
check_environment    →  {passed, checks: [{id, status, label, detail, fix}],
                         device, platform, python, missing}
test_inference       →  {passed, ep, elapsed_ms, output_shape, max_abs_error}
synthesize           →  {duration_sec, elapsed_ms, ep, n_frames, sample_rate, rms, ...}
                        (+ audio: float[] when include_audio=true)
benchmark_synthesis  →  {target_duration_sec, actual_duration_sec, elapsed_sec, real_time_ratio, passed}
separate             →  {mode, stems: {name: path}, elapsed_sec, duration_sec, rt_ratio, crosstalk_db, passed}
synthesize_cover     →  {output_path, ai_vocal_path, mode, duration_sec, elapsed_sec, rt_ratio, vibrato_depth, passed}
export_audio         →  {output_path, size_bytes, format, duration_sec}
train_model          →  streaming: {epoch, loss, ...} lines  +  final {status, output_path, best_loss, ...}
watermark_embed      →  {audio: float[], uid, timestamp, snr_db, samples}
watermark_verify     →  {detected, correlation, uid, timestamp, confidence}
encrypt_model        →  {enc_path, size_bytes, encrypted}
decrypt_model        →  {decrypted, enc_path, inputs, outputs}  or  {decrypted: false, error}
```

---

## 8. Frontend Architecture

### State Management

Two Zustand stores:

**`useAppStore`** (global app state):
- `activeView`: which page is showing
- `selectedModel`: path to currently selected ONNX
- `engineBusy` / `engineStatus`: shown in sidebar status dot
- `trainedModels[]`: model list persisted in Zustand (in-memory, not localStorage)

**`useSubscriptionStore`** (license state, mirrors main process):
- `status`: `loading | unlicensed | active | grace_period | expired | invalid`
- `payload`: decoded license token data
- `expiresAt`, `daysRemaining`, `graceDaysLeft`
- `_init()`: hydrates from `getLicenseState()` and subscribes to push events

### Routing
There is no React Router. Active view is controlled by `useAppStore.activeView`. Layout.tsx switches between view components.

Current views: `training | cover | audio-tools | subscription`

### Adding a New View
1. Create `src/renderer/src/views/MyView.tsx`
2. Add the view key to `ActiveView` in `useAppStore.ts`
3. Add a nav item in `Sidebar.tsx` `NAV_ITEMS` array
4. Add the route in `Layout.tsx`

### `useEngine` Hook
```typescript
const { call } = useEngine()
// Automatically sets engineBusy=true and engineStatus='running: method'
// Resets on completion or error
const result = await call('detect_device')
```

---

## 9. Subscription & License System

### Token Format
```
base64url({"alg":"HS256","typ":"LICENSE"}) . base64url(payload) . hmac_sha256_hex
```

**Payload fields**:
```typescript
{
  userId:     string    // provider customer ID
  planId:     'monthly' | 'annual' | 'trial'
  licenseKey: string    // the key the user entered
  expiresAt:  number    // Unix seconds
  issuedAt:   number    // Unix seconds
  features:   string[]  // ['training','synthesis','separation','cover']
}
```

### Signing Secret
The HMAC-SHA256 signing secret is defined in `license-config.ts` as `signingSecret`. This **must match** the `LICENSE_SIGNING_SECRET` environment variable on the serverless function.

**Production checklist**:
- [ ] Generate a random 256-bit secret: `openssl rand -hex 32`
- [ ] Set in app: `process.env.LICENSE_SIGNING_SECRET`
- [ ] Set in Lambda/FC: `LICENSE_SIGNING_SECRET` env var
- [ ] Never commit the production secret to git

### Local Persistence
The token is AES-256-GCM encrypted with the machine-bound key from `model-crypto.ts` and stored at:
- `userData/license.enc`

The max-observed-timestamp (clock tamper detection) is stored at:
- `userData/.license_ts` (8-byte big-endian uint64)

### Status Machine
```
unlicensed → (activate) → active
active     → (expiry)   → grace_period → (grace expires) → expired
any state  → (clock tampered) → expired
expired    → (refresh/reactivate) → active
```

### Serverless Function
`serverless/verify-license/handler.py` serves two routes on one Function URL, dispatched by path:

**`POST /`** — license verification  
**Request**: `{ licenseKey: string, appVersion: string }`  
**Response (success)**: `{ valid: true, token: string, expiresIn: number }`  
**Response (failure)**: `{ valid: false, error: string }`

**`POST /stripe-webhook`** — Stripe webhook (only relevant when `PAYMENT_PROVIDER=stripe`).
On `checkout.session.completed`, generates a license key and writes it to the new
subscription's `metadata.license_key`, which is what `/` looks up via Stripe's Search
API. Requires `STRIPE_WEBHOOK_SECRET` (from Stripe Dashboard → Webhooks) — see
[DEV_GUIDE.md](DEV_GUIDE.md#24-deploy-to-aws-lambda) for setup.

To switch payment providers, update only the `_check_payment_provider()` function body.

**Deployment**:
```bash
# AWS Lambda (Python 3.11 runtime)
zip function.zip handler.py
aws lambda create-function \
  --function-name ruanjian-verify-license \
  --runtime python3.11 \
  --handler handler.handler \
  --zip-file fileb://function.zip \
  --environment "Variables={LICENSE_SIGNING_SECRET=your_secret}"

# Alibaba Cloud FC (same code, different deploy command)
s deploy  # via Serverless Devs
```

---

## 10. Security Architecture

### Python Engine Sandboxing
`engine/sandbox.py` patches `socket.socket` before any imports:
- Blocks `AF_INET` and `AF_INET6` family sockets
- Allows `AF_UNIX` (for CoreML/local ORT provider communication)
- Removes HTTP proxy environment variables

Applied in `engine/main.py` at the very top, before other imports.

### Model File Encryption
`src/main/model-crypto.ts`:
- Key derived from `SHA-256(random_seed || machine_fingerprint || app_salt)`
- `random_seed` (16 bytes) stored at `userData/keys/model.key`
- `machine_fingerprint` = `hostname | platform-arch | cpu_model`
- Key regenerated each run → same device always gets the same key
- Copying `model.key` + `model.enc` to another machine → different fingerprint → key mismatch → AES-GCM auth failure

### Watermarking
`engine/watermark.py`:
- Spread-spectrum blind watermark
- Embedding: `audio += 0.001 × (uid_hash @ fixed_random_matrix)` (~−60 dBFS, inaudible)
- Verification: normalized cross-correlation of audio vs expected pattern
- Threshold: 0.12 (empirically separates watermarked from non-watermarked)
- The `fixed_random_matrix` is seeded deterministically (seed `0x57415445`)

### License Token Security
- Timing-safe comparison (`timingSafeEqual`) prevents timing attacks on HMAC
- Clock tamper detection via max-observed-timestamp file
- Local token encrypted with machine-bound key (prevents token file sharing)
- Grace period absorbs 3 days of offline/network-failure use

---

## 11. CI / CD Pipeline

Two workflows cover the two halves of the app: `ci.yml` for the Python
engine, `app-check.yml` for the Electron/React application. `ci.yml` is
scoped to `engine/**` changes and needs heavy Python/ML deps;
`app-check.yml` runs on every push/PR regardless of what changed, since a
broken TypeScript build or failing unit test can land in any commit.

### `.github/workflows/ci.yml` — engine (triggers on `engine/**` changes)

#### `test` (runs on every push/PR)
- Matrix: `ubuntu-22.04` × `macos-14` × Python `3.11/3.12`
- Installs CPU-only PyTorch
- Runs `python engine/_test_suite.py --fast --skip training`
- Runs `python engine/_test_security.py` (watermark round-trip, model
  encryption, sandbox network block — see T09/T10 below plus the sandbox
  check)
- Uploads JSON report artifacts

#### `benchmark-full` (main branch pushes only)
- Ubuntu 22.04, Python 3.11
- Runs full test suite + benchmark (30-second audio)
- Uploads reports with 90-day retention
- Prints performance summary table

### `.github/workflows/app-check.yml` — application (runs on every push/PR)
- Ubuntu, Node 24
- `npm ci`
- `npm run typecheck` — main/preload (`tsconfig.node.json`) + renderer (`tsconfig.web.json`)
- `npm test` — vitest unit suite (`src/renderer/src/**/*.test.{ts,tsx}`)
- `npx electron-vite build` — compiles main/preload/renderer to catch build breakage

It does not run `electron-builder` packaging (code signing/installers) —
see `build-windows.yml` / `build-windows-nsis.yml` / `build-macos-dmg.yml`
(all manually triggered) for that.

### Test IDs and Coverage

| ID | Module | Key assertion |
|---|---|---|
| T01 | Device detection | EP in valid set |
| T02 | ONNX inference | latency < 1 ms (CPU) |
| T03 | Synthesis | RT ratio < 30% (CPU) |
| T04 | Standard separation | 4-min equiv < 10s; reconstruction > −40 dB |
| T05 | Enhanced separation | 4-min equiv < 60s; 3 stems returned |
| T06 | Cover V1 | RT ratio < 10% |
| T07 | Cover V2 | RT ratio < 50%; vibrato > 0 |
| T08 | Standard training | completes < 1200s (skipped without torch) |
| T09 | Watermark | SNR > 40 dB; correct UID detected; wrong UID rejected |
| T10 | Model encryption | bytes match; wrong key rejected; 28-byte overhead |

### Running Tests Locally
```bash
# Fast CI mode (< 60 s total)
npm run test:engine

# Specific tests
cd engine
python3 _test_suite.py --fast --skip training --skip cover

# Full benchmark (30s audio, 3 iterations each)
python3 _bench.py --iters 3 --dur 30 --output bench.json

# Security tests only
python3 _test_security.py
```

---

## 12. Adding New Engine Methods

### Step 1 — Python handler
```python
# engine/main.py

def my_feature(args):
    import numpy as np
    params = args[0] if args and isinstance(args[0], dict) else {}
    value  = params.get("value", 42)
    # ... computation ...
    return {"result": float(value * 2)}

HANDLERS = {
    ...
    "my_feature": my_feature,
}
```

### Step 2 — TypeScript call
No changes to IPC infrastructure needed. Call directly:
```typescript
const result = await window.engine.call('my_feature', { value: 7 })
// result → { result: 14 }
```

### Step 3 — Streaming (optional)
If the method emits multiple progress lines, use `stream`:
```python
# Python: print progress lines before the final result
def my_streaming_method(args):
    import json, time
    for i in range(10):
        print(json.dumps({"step": i, "percent": i * 10}), flush=True)
        time.sleep(0.1)
    return {"done": True}
```

```typescript
// Subscribe before calling
const unsub = window.engine.onProgress((data) => {
  console.log('Progress:', data)
})
const result = await window.engine.stream('my_streaming_method', {})
unsub()
```

### Step 4 — Test
Add a test case in `engine/_test_suite.py`:
```python
def test_tXX_my_feature(targets: dict) -> TestResult:
    r = _make_result("TXX", "My feature")
    try:
        result = my_feature([{"value": 7}])
        r["metrics"] = {"result": result["result"]}
        r["passed"]  = result["result"] == 14
    except Exception as e:
        r["errors"].append(str(e))
    return r
```

---

## 13. Adding New UI Views

```typescript
// 1. src/renderer/src/store/useAppStore.ts
export type ActiveView = 'training' | 'cover' | 'audio-tools' | 'subscription' | 'my-view'

// 2. src/renderer/src/views/MyView.tsx
export function MyView(): JSX.Element {
  return <div>...</div>
}

// 3. src/renderer/src/components/Sidebar.tsx
const NAV_ITEMS = [
  ...
  { view: 'my-view', icon: '🔧', label: 'My Feature' },
]

// 4. src/renderer/src/components/Layout.tsx
import { MyView } from '../views/MyView'

const view = 
  activeView === 'my-view' ? <MyView /> :
  ...  // existing routes
```

Views wrapped in `<SubscriptionGate>` are automatically gated. The Subscription page itself is exempt (rendered outside the gate in Layout.tsx).

---

## 14. Performance Targets & Benchmarks

All targets measured on a CPU-only system (Intel Core i5, no GPU):

| Operation | Audio Duration | Target | Typical |
|---|---|---|---|
| ONNX MatMul inference | — | ≤ 1 ms | 0.02 ms |
| Voice synthesis | 30 s | ≤ 30% RT | 0.5% RT |
| Standard separation | 4 min equiv | ≤ 10 s | 0.9 s |
| Enhanced separation | 4 min equiv | ≤ 60 s | 1.2 s |
| Cover V1 (DTW+WSOLA) | 30 s | ≤ 10% RT | 0.7% RT |
| Cover V2 (LSTM expr.) | 30 s | ≤ 50% RT | 0.3% RT |
| Standard training | 5 min data | ≤ 1200 s | 0.4 s (stub model) |
| Watermark embed (1 s audio) | — | imperceptible (SNR > 40 dB) | 54 dB |
| Model encrypt/decrypt | 527 KB | — | < 5 ms |

**Note**: Timing with stub models is near-instantaneous. Production models will be larger and slower. Benchmarks should be re-run with real trained ONNX models before shipping.

---

## 15. Troubleshooting (Developer)

### TypeScript Errors After Changes
```bash
npm run typecheck
```
The project uses project references (`tsconfig.json` → `tsconfig.node.json` + `tsconfig.web.json`). Run both to catch issues in main and renderer simultaneously.

### IPC Call Returns Nothing / Times Out
1. Verify the Python engine handles the method: `python3 engine/main.py '{"method":"your_method","args":[]}'`
2. Check for Python exceptions — they go to stderr, which python-bridge captures in the rejection message.
3. In dev mode, open DevTools → Console to see the IPC error.

### Engine Spawns But Returns Empty Result
`callPythonEngine` takes the **last non-empty JSON line** from stdout. If your handler prints non-JSON text before the result, the parser will fail. Always use `json.dumps(result)` for output.

### Sandbox Blocks ONNX Runtime on macOS
If you see `PermissionError: Engine sandbox: network socket blocked` in stderr, ORT is trying to use `AF_INET` for provider initialization. Check:
- The `AF_UNIX` allow-list in `sandbox.py` is correct.
- Try running without the sandbox to confirm: comment out `_sb.apply()` in `main.py`.
- CoreML provider uses `AF_UNIX`; CUDA uses direct driver access — neither should need `AF_INET`.

### electron-vite Build Fails
```bash
npm run typecheck    # identify type errors first
npx electron-vite build 2>&1 | head -50
```
Common causes:
- Missing import in `tsconfig.node.json` includes list
- Circular imports between main and preload modules

### PyInstaller Bundle Missing Dependency
If the packaged app fails with `ModuleNotFoundError`, add the missing module to `package-engine.sh`:
```bash
pyinstaller main.py \
  ...
  --hidden-import my_missing_module \
  ...
```

### Subscription Monitor Not Initializing
The monitor calls `await monitor.initialize()` before the window is created. If it hangs:
1. Check `userData/license.enc` permissions (mode `0o600`).
2. The `model-crypto.ts` `getModelKey()` reads `userData/keys/model.key` — ensure `userData` is writable.
3. In dev mode, a freshly installed app will have no key file and create one on first run.

---

## 16. Known Limitations & Roadmap

### Current Limitations

| Area | Limitation | Planned Fix |
|---|---|---|
| Audio formats | MP3 not supported by soundfile | Add ffmpeg optional dependency |
| Model export | Trained models are machine-locked | Add encrypted export + device transfer |
| Separation quality | Stub FIR models produce simple frequency splits | Replace with real Demucs-nano weights |
| Synthesis quality | Stub ONNX models use random weights | Train real Micro-VITS weights |
| Watermark capacity | Only 32-bit UID vector | Extend to embed full user ID |
| Multi-device license | 1 device per key | Implement device registration API |
| macOS sandbox-exec | Not implemented (Python-level only) | Add `sandbox-exec` wrapper on macOS |
| Windows Defender | No code signing in early builds | Purchase EV code-signing cert |

### Roadmap (Planned)

- **v0.2**: Real Micro-VITS trained weights; Demucs-nano separation model
- **v0.3**: MIDI score input for synthesis; harmony generation
- **v0.4**: Mobile companion app (iOS/Android stem player)
- **v0.5**: Multi-device license (up to 3 devices); model export/import
- **v1.0**: Professional training with 90%+ timbre accuracy; production code signing

---

## Contributing

1. Fork the repo and create a feature branch: `git checkout -b feat/my-feature`
2. Run `npm run typecheck` and `npm run test:engine` before committing.
3. Follow existing code style — no docstrings on obvious functions, one-line comments only.
4. Do not commit `.onnx`, `.enc`, or `node_modules/` files.
5. Open a PR against `develop` with a clear description of changes.

### Commit Convention
```
feat: add stereo synthesis support
fix: prevent training crash on empty audio
perf: vectorise DTW inner loop
test: add T11 cover synthesis quality check
```

---

*Internal repository. All rights reserved © 2026 SootheVoice.*
