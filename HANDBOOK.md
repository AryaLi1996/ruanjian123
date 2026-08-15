# Ruanjian — User Handbook

> **Version 0.1.0 · 2026**  
> AI Singing Voice Studio · Desktop Application for Windows & macOS

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Requirements](#2-system-requirements)
3. [Installation](#3-installation)
4. [First Launch & Onboarding](#4-first-launch--onboarding)
5. [Subscription & Licensing](#5-subscription--licensing)
6. [Model Training](#6-model-training)
7. [Cover Creation](#7-cover-creation)
8. [Audio Tools — Batch Separation](#8-audio-tools--batch-separation)
9. [Cloud Acceleration](#9-cloud-acceleration)
10. [Settings & Security](#10-settings--security)
11. [Troubleshooting](#11-troubleshooting)
12. [Frequently Asked Questions](#12-frequently-asked-questions)

---

## 1. Introduction

**Ruanjian** is a desktop AI singing voice studio that lets you:

| Feature | What it does |
|---|---|
| **Model Training** | Fine-tune an AI singer from your own dry vocal recordings (5–15 minutes of audio) |
| **Cover Creation** | Make the AI sing a song in the target singer's style, aligned to a reference vocal |
| **Audio Separation** | Split a mixed song into stems: vocals, lead, harmony, and accompaniment |
| **Cloud Acceleration** | Offload GPU-heavy training to a serverless cloud backend when local hardware is weak |

All AI processing runs **locally on your device** — your audio and models never leave your machine unless you explicitly choose Cloud Acceleration.

---

## 2. System Requirements

### Minimum (CPU mode)
| Component | Requirement |
|---|---|
| OS | Windows 10 x64 (21H2+) or macOS 12 Monterey+ |
| CPU | Intel Core i5 8th gen / AMD Ryzen 5 3000 / Apple M1 |
| RAM | 8 GB |
| Storage | 2 GB free (app) + 500 MB per trained model |
| Internet | Required for license activation; offline use supported after activation |

### Recommended (GPU mode)
| Component | Requirement |
|---|---|
| GPU | NVIDIA RTX 3060 (6 GB VRAM) · AMD RX 6700 · Apple Silicon (M1/M2/M3) |
| RAM | 16 GB |
| Storage | SSD with 10 GB free |

### Audio Material Requirements for Training
- **Standard mode**: 5 minutes of clean, dry (no reverb) vocal recordings
- **Professional mode**: 15 minutes of clean dry vocals
- Supported formats: WAV, FLAC, MP3, OGG, M4A
- Recommended: 44.1 kHz, 16-bit WAV, recorded in a quiet room

---

## 3. Installation

### Windows
1. Download `Ruanjian-0.1.0-win-x64-setup.exe` from the official website.
2. Double-click the installer.
3. If Windows Defender SmartScreen shows a warning, click **More info → Run anyway** (the app is not yet code-signed in early versions).
4. Choose installation directory (default: `%LocalAppData%\Programs\Ruanjian`).
5. Click **Install**. The app launches automatically on completion.

> **Note**: The installer bundles a portable Python runtime. You do **not** need to install Python separately.

### macOS
1. Download `Ruanjian-0.1.0-mac-universal.dmg` (works on both Intel and Apple Silicon).
2. Open the DMG and drag **Ruanjian** to the Applications folder.
3. On first launch, macOS may say "Ruanjian cannot be opened because Apple cannot check it for malicious software." If so:
   - Open **System Settings → Privacy & Security**.
   - Scroll down and click **Open Anyway** next to the Ruanjian entry.
4. Click **Open** in the confirmation dialog.

> **Note**: The app requires microphone permission for future voice input features. You may decline; it does not affect current functionality.

### Verifying the Installation
After launch, the onboarding wizard runs automatically. If you see the **Hardware Detection** step complete successfully, the engine is working correctly.

---

## 4. First Launch & Onboarding

When you open Ruanjian for the first time, a four-step wizard guides you through setup:

### Step 1 — Welcome
Displays a feature overview. Click **Get Started →** to proceed.

### Step 2 — Hardware Detection
The app automatically detects your GPU and acceleration framework:

| Result | Meaning |
|---|---|
| `CoreML` | Apple Silicon GPU — all features run fast locally |
| `CUDA` | NVIDIA GPU — fastest performance |
| `DirectML` | Windows GPU (AMD/Intel/NVIDIA) — good performance |
| `CPU` | No GPU detected — features work but training is slow; consider Cloud Acceleration |

Click **Continue →** to proceed.

### Step 3 — Model Warm-Up
The inference engine runs a quick matrix multiplication test. A latency under 1 ms confirms the engine is healthy. Click **Continue →** after the test completes.

### Step 4 — Ready
Click **Open Ruanjian** to enter the main application.

> The wizard runs only once. To re-run it, go to `%AppData%\Ruanjian` (Windows) or `~/Library/Application Support/Ruanjian` (macOS) and delete the `.initialized` file.

---

## 5. Subscription & Licensing

### Plans
Ruanjian requires an active monthly subscription ($9.90/month) to use AI features. A **free 30-day trial** is available.

### Activating a License

1. Click **💎 Subscription** in the left sidebar.
2. Click **Subscribe — $9.90 / month** to open the payment page in your browser.
3. Complete the payment. You will receive a license key (format: `RUANJIAN-XXXX-XXXX-XXXX`).
4. Paste the key into the **license key field** and click **Activate**.

**Demo trial** (no payment required): enter `RUANJIAN-DEMO-2026` as the license key to activate a free 30-day trial.

### Subscription Status
The Subscription page shows:
- **Status**: Active / Grace Period / Expired / Unlicensed
- **Valid until**: Expiration date
- **Days remaining**: Countdown to renewal

### Renewal
Click **Manage Subscription** on the Subscription page to open the customer portal in your browser where you can update payment methods or cancel.

### Grace Period
If your subscription expires and you cannot renew immediately:
- Features remain **fully functional for 3 days** after expiry (grace period).
- A yellow warning banner appears at the top of each page.
- After 3 days without renewal, core features are locked until you renew.

### Offline Use
If you have an active license and lose internet access:
- The app works normally using the locally cached license token.
- The grace period applies to offline scenarios too — if your license expires while offline, you have 3 days to reconnect and renew.

### Anti-Tamper Notice
The license system detects **system clock manipulation**. Setting your clock backward to extend a free trial will lock the app. Always use the correct system time.

---

## 6. Model Training

### Overview
Train an AI singer that mimics your vocal timbre. You provide dry vocal recordings; the app fine-tunes the base model using LoRA (Low-Rank Adaptation) — no full model retraining required.

### Step-by-Step: Standard Mode

1. Navigate to **🏋️ Model Training** in the sidebar.
2. **Model Info section**:
   - Enter a **Model Name** (e.g., "My Voice").
   - Click the **cover image box** to optionally set an album-art-style cover.
   - Set the number of **Epochs** (10 is fine for a quick test; 50 for better quality).
3. **Training Material section**:
   - Drag WAV/FLAC files into the dropzone, or click to browse.
   - You will see a **waveform preview** for each file.
   - Aim for **5+ minutes** of clean, dry vocals for Standard mode.
   - If no files are uploaded, the app uses synthetic test data (for demonstration only — quality will be poor).
4. **Training Mode section**:
   - Select **Standard** (LoRA rank-4, timbre encoder only).
5. Click **▶ Start Local Training**.

### Training Modes Compared

| | Standard | Professional |
|---|---|---|
| LoRA rank | 4 | 8 |
| Layers fine-tuned | Timbre encoder only | All linear layers |
| GPU VRAM needed | 2 GB | 6 GB |
| GPU time (typical) | ≤ 5 min | ≤ 90 min |
| CPU time (typical) | ≤ 20 min | ≤ 6 hours |
| Audio data needed | 5 min | 15 min |
| Best for | Quick results, demos | Production-quality timbre |

### Training Progress
During training, a real-time panel shows:
- **Progress bar** (0–100%)
- **Current epoch / total epochs**
- **Current loss** (lower is better; typical final loss: 0.0005–0.005)
- **ETA** (estimated time to completion)
- **Scrolling log** of epoch-by-epoch JSON data
- **Device** (cpu / cuda / mps)

### After Training
When training completes:
- A **result box** shows training stats (best loss, training time, model size).
- The app automatically synthesizes a **6-note demo** (Do–Re–Mi–Sol–La–Si) using the new model. Click **▶ Demo** to listen.
- The trained model appears in the **Your Models** card grid below the form.

### Model Card Actions

| Button | Action |
|---|---|
| **▶ Demo** | Play the auto-generated demo audio |
| **🔁** | Pre-fill the form with this model's settings for retraining |
| **🗑** | Delete the model from the list |

### Encrypting Models
Trained models are automatically encrypted with a machine-specific AES-256-GCM key. The `.enc` file **cannot be used on another computer**. To transfer a model:
1. Export the plaintext ONNX file before encrypting (a future export feature will be added).
2. The recipient must activate the model with their own Ruanjian installation.

---

## 7. Cover Creation

### Overview
The Cover Creation workflow transforms a song so the AI singer sings it, replacing the original vocalist while preserving the accompaniment.

### The 4-Step Wizard

#### Step 1 — Upload & Separate
1. Click the **song drop zone** or drag a WAV/FLAC file.
2. Choose a **separation mode**:
   - **Standard**: produces 2 stems — Vocals + Accompaniment
   - **Enhanced**: produces 3 stems — Lead (dry) + Harmony (dry) + Accompaniment
3. Click **🔊 Start Separation**.
4. After separation (typically 1–5 seconds per minute of audio), the **stems** appear with individual playback controls.
5. Click each stem's **play button** to listen. Use the **S (Solo)** button to isolate one stem.
6. If the stems sound acceptable, click **Next: Select Model →**.

> **Tip**: Enhanced mode produces cleaner stems and better cover quality. Use it when quality matters more than speed.

#### Step 2 — Select AI Singer Model
1. Click a **model card** to select the AI singer. The selected card highlights in purple.
2. If you haven't trained any models yet, you'll see a message directing you to Model Training.
3. Choose the **cover algorithm**:
   - **V1 — Fast** (DTW + WSOLA): uses pitch/energy alignment; ≤ 10% real-time; good quality
   - **V2 — High-Precision** (LSTM expression encoder): captures vibrato, dynamics, and breathiness; ≤ 50% real-time; best quality
4. Click **Next: Synthesize →**.

#### Step 3 — Synthesize & Mix
1. Click **🎤 Synthesize Cover**.
2. Wait for synthesis (typically 1–3 seconds for a 30-second clip).
3. When done, the **Mixing Console** appears with three tracks:
   - **AI Vocal** (purple) — the synthesized AI singer voice
   - **Orig. Harmony** (green) — the original backing/harmony vocals from the separated track
   - **Accomp.** (yellow) — the instrumental accompaniment
4. **Faders** (vertical sliders): drag up/down to adjust each track's volume.
5. **Effects**:
   - **Reverb** (0–100%): adds room reverb to the mix
   - **Lo / Mid / Hi** (−12 to +12 dB): three-band EQ for tone shaping
6. Click **▶** (play button) to preview the mix in real time.
7. Click **Next: Export →**.

**Mixing Tips**:
- Set AI Vocal to ~80%, Harmony to ~25–35%, Accompaniment to ~50–60% as a starting point.
- Add 10–20% Reverb to blend the AI voice with the accompaniment.
- If the AI voice sounds harsh, reduce Hi EQ by 2–4 dB.

#### Step 4 — Export Audio
1. Choose **Format**: WAV (lossless), FLAC (lossless compressed), or OGG (lossy, smaller file).
2. Click **⬇ Export Audio**.
3. The app renders the mix using the exact fader/EQ settings and saves the file.
4. The output path is displayed in the result box.

> **Note**: MP3 export requires ffmpeg on your system. Install ffmpeg and it will be detected automatically in a future update.

---

## 8. Audio Tools — Batch Separation

### Overview
Process multiple songs at once through source separation. Ideal for building instrumental backing tracks or extracting vocals from a collection.

### How to Use

1. Navigate to **🔊 Audio Tools** in the sidebar.
2. **Detect Device**: click to verify hardware acceleration is active.
3. **Drop zone**: drag multiple audio files (or click to browse). You can drop as many files as you like.
4. Each file appears as a row in the **queue list** showing:
   - File name
   - **Mode selector** (Standard / Enhanced) — changeable before processing
   - Status badge (Pending / Processing / Done / Error)
5. Optionally change individual files to different modes.
6. Click **▶ Process N** to start. Files are processed **one at a time** (sequential) to avoid memory overflow.

### Download Results
After processing:
- Per-file: click **⬇ Vocals**, **⬇ Lead**, **⬇ Accomp.** etc. to download each stem.
- All at once: click **⬇ Download All (N)** to download every stem from every completed file.

> **Note**: Downloading saves each stem as a WAV file. Large batches (50+ files) may take a moment as the app reads and streams each file from disk.

### Status Meanings
| Badge | Meaning |
|---|---|
| `● Pending` | Waiting to be processed |
| `⏳ 2.3s` | Currently processing — live elapsed time |
| `✓ 1.2s` | Done — elapsed time shown; download buttons active |
| `✕ Error` | Failed — hover over the badge to see the error |

---

## 9. Cloud Acceleration

### When to Use
Cloud Acceleration is recommended when:
- The app detects **CPU-only** hardware (no GPU)
- You want **Professional mode training** in under 10 minutes
- You are on a laptop with limited battery

### How to Activate
1. On the **Model Training** page, if CPU-only is detected, a blue **Cloud Acceleration** banner appears.
2. Click the banner to expand it.
3. Review the **cost estimate**:
   - Standard mode: ~$0.07
   - Professional mode: ~$3.60
4. Check **"I accept the estimated cost"** and click **☁️ Start Cloud Training**.

### What Happens
1. **Encrypt**: Your audio is encrypted with AES-256-GCM on your device before leaving.
2. **Upload**: Encrypted chunks upload to the cloud (progress shown).
3. **Train**: The cloud GPU trains the model (status: Preprocessing → Training → Exporting).
4. **Download**: The encrypted trained model is downloaded.
5. **Decrypt**: The model is decrypted locally — the encryption key never leaves your device.
6. **Done**: The model appears in Your Models list.

### Privacy Guarantee
- The encryption key is generated on your device and never transmitted to the server.
- The cloud provider never has access to unencrypted audio or models.
- Cloud job logs contain only hashed identifiers.

---

## 10. Settings & Security

### License File Location
| Platform | Path |
|---|---|
| Windows | `%AppData%\Ruanjian\license.enc` |
| macOS | `~/Library/Application Support/Ruanjian/license.enc` |

This file is encrypted with a machine-specific key. Copying it to another device will not activate that device.

### Model Storage Location
| Platform | Path |
|---|---|
| Windows | `%AppData%\Ruanjian\` (encrypted `.enc` files) |
| macOS | `~/Library/Application Support/Ruanjian/` |

### Auto-Updates
Ruanjian automatically checks for updates in the background. When an update is available:
1. A notification banner appears at the bottom of the left sidebar.
2. Click **⬇ Download** to download the update.
3. After download, click **Restart & Install** to apply it immediately.

You can continue using the app during the download. The update installs on the next restart.

### Data Privacy
- **Audio files**: processed locally; never sent to any server unless you use Cloud Acceleration.
- **Models**: stored encrypted on your device.
- **License token**: contains your user ID and expiry date only — no audio data.
- **Telemetry**: none collected in this version.

---

## 11. Troubleshooting

### App Won't Start

**Symptom**: Black screen or the app closes immediately.

**Solutions**:
1. Check the app log at:
   - Windows: `%AppData%\Ruanjian\logs\main.log`
   - macOS: `~/Library/Logs/Ruanjian/main.log`
2. Try uninstalling and reinstalling. Your models and license are preserved (stored in AppData, not the install directory).
3. On Windows: ensure Visual C++ Redistributable 2022 is installed.

---

### "Engine ready" never appears / Engine errors

**Symptom**: The status dot in the sidebar stays grey or shows an error.

**Solutions**:
1. Check that no other application is using the Python engine (another Ruanjian window).
2. On macOS: check **System Settings → Privacy & Security → Files and Folders** to ensure Ruanjian has access to the Downloads/Documents folder.
3. Run the onboarding wizard again by deleting `.initialized` (see First Launch section).
4. Check the engine log at `~/Library/Logs/Ruanjian/main.log` for Python errors.

---

### Training Fails Immediately

**Symptom**: Clicking "Start Training" shows an error in the progress log.

**Common Errors**:

| Error message | Fix |
|---|---|
| `ModuleNotFoundError: No module named 'torch'` | PyTorch not installed. Run `pip3 install torch --index-url https://download.pytorch.org/whl/cpu` in Terminal |
| `ModuleNotFoundError: No module named 'cryptography'` | Run `pip3 install cryptography` |
| `ONNX export failed` | Update numpy: `pip3 install "numpy>=1.26"` |
| `No audio data` | Make sure you uploaded at least one audio file, or that the synthetic fallback is enabled |

---

### Separation Produces Silence or Noise

**Symptom**: Stems are silent or contain mostly noise.

**Solutions**:
1. Ensure the input file is not corrupt — play it in another app first.
2. The separation engine supports WAV, FLAC, and OGG. MP3 may fail if ffmpeg is not installed.
3. For very short files (< 5 seconds), separation may not produce useful results.
4. Try **Standard mode** first — Enhanced mode can occasionally fail on mono recordings.

---

### Cover Synthesis Sounds Wrong

**Symptom**: The AI cover sounds off-pitch or robotic.

**Tips**:
1. Use **V2 High-Precision** mode for better expressiveness.
2. Ensure you have a **trained model** selected — do not use the untrained default model.
3. The reference vocal (from Step 1 separation) should be clean. Use Enhanced separation to get a clean Lead stem.
4. In the Mixing Console, lower the Hi EQ by 2–3 dB to reduce harshness.
5. Add 15% Reverb to blend the AI voice.

---

### License Activation Fails

**Symptom**: Entering a license key returns an error.

| Error | Fix |
|---|---|
| `"Server verification failed"` | Check your internet connection. The app needs to reach the verification server. |
| `"License key not found"` | Ensure you copied the key exactly — no extra spaces. Keys are case-sensitive. |
| `"Network request failed"` | Temporarily disable VPN or proxy and try again. |
| `"Invalid token from server"` | The signing secret may be misconfigured. Contact support. |

---

### Clock Tamper Lock

**Symptom**: The app shows "expired" even though you believe the subscription is active.

**Cause**: The anti-tamper system detected that the system clock was set backward.

**Fix**:
1. Restore your system clock to the correct time.
2. Click **Refresh** on the Subscription page to fetch a new token from the server.
3. If still locked, deactivate the license and re-enter your key.

---

### Separation is Very Slow

**Symptom**: A 3-minute song takes more than 30 seconds to separate.

**Solutions**:
1. Check hardware detection — CPU-only mode is expected to be slower.
2. Enable Cloud Acceleration for batch processing on CPU-only hardware.
3. Use **Standard** separation mode (faster than Enhanced).

---

### App Uses Excessive Disk Space

**Location of large files**:
- `engine/*.onnx` — AI models (5–50 MB each)
- `AppData/Ruanjian/training/` — uploaded audio for training (auto-created, can be deleted after training)
- `AppData/Ruanjian/model_*.enc` — trained models (encrypted)

You can safely delete the `training/` subdirectory after your models are trained.

---

## 12. Frequently Asked Questions

**Q: Does Ruanjian work offline?**  
A: Yes, after initial license activation. All AI processing is local. An internet connection is only needed to activate or renew your subscription.

**Q: Can I run Ruanjian on a machine without a GPU?**  
A: Yes. All features work in CPU mode. Training will take longer (20–360 min depending on mode). Use Cloud Acceleration for Professional training without a GPU.

**Q: How long does training take with my Apple M1?**  
A: The M1 uses CoreML acceleration. Standard training typically completes in 2–5 minutes; Professional in 20–45 minutes.

**Q: Can I share a trained model with someone else?**  
A: Encrypted models (`.enc`) are machine-locked and cannot be used on another device. Model portability/export to other devices will be added in a future update.

**Q: What audio format gives the best separation quality?**  
A: WAV (44.1 kHz, 16-bit stereo) gives the best results. FLAC is equally good. MP3 at 320 kbps is acceptable but lower bitrates reduce quality.

**Q: My voice sounds very different from the AI singer in covers. How do I improve it?**  
A: Collect more diverse vocal material covering your full pitch range. Include sustained notes, runs, and breathy passages. Professional mode with 15+ minutes of varied material produces significantly better results.

**Q: How many models can I train?**  
A: There is no hard limit. Each model is 200–600 KB encrypted. The app keeps all models accessible from the Your Models grid.

**Q: Can I use the app on multiple computers?**  
A: Yes, one subscription activates one device at a time. To switch devices, deactivate the license on the old device first (Subscription page → Deactivate), then activate on the new one.

**Q: Is my vocal data safe in the cloud during Cloud Acceleration?**  
A: Your audio is AES-256-GCM encrypted on your device before any data is uploaded. The cloud server processes only ciphertext and never has access to your original audio. The decryption key never leaves your device.

**Q: What is the "RUANJIAN-DEMO-2026" key?**  
A: It's a free trial key that creates a local 30-day license without requiring payment. It works without an internet connection and is intended for evaluation. It will stop working after the trial period.

---

*For additional support, visit https://ruanjian.app/support or email support@ruanjian.app*
