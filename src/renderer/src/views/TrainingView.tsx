import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore, type TrainedModel } from '../store/useAppStore'
import { notify, useNotificationStore } from '../store/useNotificationStore'
import { playCompletionChime } from '../utils/sound'
import { AudioDropzone, type TrainingUpload } from '../components/training/AudioDropzone'
import { ModeSelector, type TrainingMode } from '../components/training/ModeSelector'
import { TrainingProgress, type ProgressData } from '../components/training/TrainingProgress'
import { AudioPlayer } from '../components/training/AudioPlayer'
import { ModelCard } from '../components/training/ModelCard'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { TrainingPreflightDialog } from '../components/training/TrainingPreflightDialog'
import { EnvironmentCheck } from '../components/training/EnvironmentCheck'
import { DeviceSelector } from '../components/training/DeviceSelector'
import { EngineLogPanel } from '../components/training/EngineLogPanel'
import type { EngineDeviceInfo, EngineLogEntry, EnvironmentReport } from '../global'
import {
  describeDevice, engineDeviceFor, resolveDeviceMode, summarizeReport, type DeviceMode,
} from '../utils/environmentCheck'
import { describeError } from '../utils/errorMessage'
import { checkTrainingInputs, type PreflightResult } from '../utils/trainingPreflight'
import { classifyTrainingFailure } from '../utils/trainingError'

type Phase = 'idle' | 'training' | 'finalizing' | 'done'

/** Progress lines are capped so a long professional run can't grow the DOM without bound. */
const MAX_LOG_LINES = 200

/**
 * Raw engine output is far chattier than progress JSON (every stage line and
 * 5s heartbeat lands here), and it accumulates from app start rather than per
 * run, so it gets its own, larger cap.
 */
const MAX_ENGINE_LOG_ENTRIES = 500

/**
 * Ticket P2: silence budget for a professional-mode run that will happen on
 * the CPU. The engine reports progress once per epoch (engine/trainer.py) and
 * preprocesses the whole upload before the first one, so on a laptop CPU it
 * routinely stays quiet for longer than the bridge's 5-minute default and is
 * killed as "hung" while working correctly. The user has explicitly accepted
 * the slow path by this point; give it room instead of a false diagnosis.
 */
const CPU_PROFESSIONAL_STALL_TIMEOUT_MS = 30 * 60_000

interface DataQualityReport {
  n_files:          number
  duration_sec:     number
  min_required_sec: number
  duration_ok:      boolean
  snr_db:           number | null
  snr_ok:           boolean
  warnings:         string[]
  passed:           boolean
}

interface TrainingResult {
  status:           string
  output_path:      string
  epochs:           number
  best_loss:        number
  trainable_params: number
  elapsed_sec:      number
  model_bytes:      number
  device:           string
  // Ticket 48: objective proxy for how faithfully the exported model
  // reproduces its training material, plus a plain-language warning when
  // it's low (insufficient/noisy data). Optional because older cached
  // results (or a synthetic-data run) may not carry them.
  quality_score?:   number
  quality_warning?: string | null
  data_quality?:    DataQualityReport
}

export function TrainingView(): JSX.Element {
  const { t } = useTranslation()
  // ── form state ───────────────────────────────────────────
  const [modelName,   setModelName]   = useState('')
  const [coverUrl,    setCoverUrl]    = useState<string | null>(null)
  const [audioFiles,  setAudioFiles]  = useState<TrainingUpload[]>([])
  const [mode,        setMode]        = useState<TrainingMode>('standard')
  const [epochs,      setEpochs]      = useState(10)

  // ── Environment self-check & hardware detection (Tickets T2/T3) ──
  // One call answers both: env_check.py runs the full checklist (Python,
  // dependencies, RAM, disk, writability) *and* returns detect_device()'s
  // result, so the device shown in the UI is the device the pre-flight
  // actually observed rather than a second, separately-timed probe.
  const [envReport,  setEnvReport]  = useState<EnvironmentReport | null>(null)
  const [envLoading, setEnvLoading] = useState(true)
  const [envError,   setEnvError]   = useState<string | null>(null)
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('cpu')
  // Set once from the first check so a re-run (e.g. after installing torch)
  // doesn't silently override a choice the user has since made by hand.
  const deviceModeInitialized = useRef(false)

  const device: EngineDeviceInfo | null = envReport?.device ?? null
  const envSummary = summarizeReport(envReport)

  const runEnvCheck = useCallback(async (): Promise<void> => {
    setEnvLoading(true)
    setEnvError(null)
    try {
      const report = await window.engine.checkEnvironment()
      setEnvReport(report)
      if (!deviceModeInitialized.current) {
        deviceModeInitialized.current = true
        setDeviceMode(resolveDeviceMode(report.device))
      }
    } catch (err) {
      setEnvError(String(err))
      setEnvReport(null)
    } finally {
      setEnvLoading(false)
    }
  }, [])

  useEffect(() => { void runEnvCheck() }, [runEnvCheck])

  // ── Raw engine output (Ticket T1/T3) ─────────────────────
  // Subscribed for the whole time this view is mounted, not just during a
  // run: the output that matters most — an engine that never starts — arrives
  // before any run is under way.
  const [engineLogs, setEngineLogs] = useState<EngineLogEntry[]>([])
  useEffect(() => window.engine.onEngineLog((entry) => {
    setEngineLogs((prev) => {
      const next = [...prev, entry]
      return next.length > MAX_ENGINE_LOG_ENTRIES ? next.slice(-MAX_ENGINE_LOG_ENTRIES) : next
    })
  }), [])

  // ── training state ───────────────────────────────────────
  const [phase,       setPhase]       = useState<Phase>('idle')
  const [cancelling,  setCancelling]  = useState(false)
  // Ticket P1: the local self-check the user acknowledges before a run starts.
  // It replaces the bare CPU confirmation: the slowdown is now one row on a
  // checklist that also covers the silent data limits (see
  // utils/trainingPreflight.ts), so one dialog answers "why did nothing
  // happen?" for every one of them.
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  // The model queued for deletion, held until the user confirms (Ticket UI-11).
  const [pendingDelete, setPendingDelete] = useState<TrainedModel | null>(null)
  const [progress,    setProgress]    = useState<ProgressData | null>(null)
  // Ticket T1: non-fatal notices the engine reports mid-run (e.g. data
  // loading degraded to a single process). They are shown as their own
  // banner rather than as progress — a notice carries no epoch or percent,
  // so treating it as a progress update would blank the progress bar.
  const [notices,     setNotices]     = useState<string[]>([])
  const [logs,        setLogs]        = useState<string[]>([])
  const [result,      setResult]      = useState<TrainingResult | null>(null)
  const [demoUrl,     setDemoUrl]     = useState<string | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  // Ticket P3: the engine's own words behind a localized explanation, shown
  // in a collapsible panel rather than as the headline.
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  // Ticket T1/T2: the model-name check is a field-level problem, so it is
  // reported on the field (and focused) instead of only in the page-wide
  // banner sitting a screen further down, where a failed click read as the
  // button doing nothing at all.
  const [nameError,   setNameError]   = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // ── model list state (player overlay) ────────────────────
  const [playingModelId, setPlayingModelId] = useState<string | null>(null)

  const trainedModels  = useAppStore((s) => s.trainedModels)
  // Ticket UI-11's 应用模型: the app already tracks which model inference
  // should use, so "apply" is exactly setting it — no new state needed.
  const selectedModel  = useAppStore((s) => s.selectedModel)
  const setSelectedModel = useAppStore((s) => s.setSelectedModel)
  const addModel       = useAppStore((s) => s.addModel)
  const removeModel    = useAppStore((s) => s.removeModel)
  const updateModelDemo = useAppStore((s) => s.updateModelDemo)
  const setEngineBusy  = useAppStore((s) => s.setEngineBusy)
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)
  const retrainParamsRef = useRef<{ mode: TrainingMode; epochs: number } | null>(null)

  // ── subscribe to engine:progress while training ──────────
  useEffect(() => {
    if (phase !== 'training') return
    const unsub = window.engine.onProgress((raw) => {
      const data = raw as ProgressData & { type?: string; message?: string }
      // Only real progress drives the progress bar (Ticket T1/T2): the engine
      // also emits warning notices on this channel, and anything unrecognised
      // is logged rather than trusted to have the progress fields.
      if (data.status === 'training' || data.status === 'done') setProgress(data)
      else if (data.type === 'notice' && typeof data.message === 'string') {
        const message = data.message
        setNotices((prev) => (prev.includes(message) ? prev : [...prev, message]))
      }
      // Professional runs emit thousands of lines; keep the tail so the DOM stays small.
      setLogs((prev) => {
        const next = [...prev, JSON.stringify(data)]
        return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
      })
    })
    return unsub
  }, [phase])

  // ── cover image picker ────────────────────────────────────
  function handleCoverPick(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => setCoverUrl(reader.result as string)
    reader.readAsDataURL(f)
  }

  // ── generate demo audio from newly trained model ─────────
  const generateDemo = useCallback(async (onnxPath: string): Promise<{ path: string; url: string } | null> => {
    try {
      // The engine writes a WAV and returns its path — sending raw PCM over IPC
      // serialises tens of thousands of numbers and can take down the renderer.
      const res = await window.engine.call('synthesize', {
        phonemes:      ['d', 'o', 'r', 'e', 'm', 'i'],
        f0_hz:         [294, 330, 370, 392, 440, 494],
        durations_sec: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        model_path:    onnxPath,
        save_audio:    true,
      }) as { audio_path?: string }
      if (!res.audio_path) return null
      const buf = await window.engine.readFile(res.audio_path)
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
      return { path: res.audio_path, url }
    } catch {
      return null
    }
  }, [])

  // ── start training ────────────────────────────────────────
  /**
   * Everything the pre-flight needs to know about the current form, in the
   * shape checkTrainingInputs() takes.
   */
  function runPreflight(forMode: TrainingMode = mode): PreflightResult {
    return checkTrainingInputs({
      files: audioFiles.map((u) => ({
        name: u.file.name, sizeBytes: u.file.size, duration: u.duration,
      })),
      mode: forMode,
      deviceMode,
      device,
      // Older engine builds don't report this; null means "couldn't tell",
      // which the check reports as a warning rather than inventing a number.
      availableRamGb: envReport?.available_ram_gb ?? null,
    })
  }

  /**
   * Gate keeper for the start button: name present, environment green, then
   * the local self-check (Ticket P1) — data problems and the CPU slowdown
   * alike are shown as one acknowledgeable checklist before the engine is
   * started at all. The run itself is in runTraining below.
   */
  function handleTrain(): void {
    setError(null)
    setErrorDetail(null)
    setNameError(null)
    if (!modelName.trim()) {
      // Ticket T1: this used to set the *label* ('模型名称 *') as the error and
      // stop there. The click looked like it did nothing — the banner is at the
      // bottom of a long form, and what it showed was an asterisk, not a
      // reason. Now the message says what to do, and the field that needs
      // fixing is scrolled to and focused so the click has a visible effect.
      setNameError(t('training.nameRequired'))
      nameInputRef.current?.focus()
      nameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (!envSummary.canTrain) { setError(t('envCheck.blocked')); return }
    setPreflight(runPreflight())
  }

  async function runTraining(): Promise<void> {
    setError(null)
    setErrorDetail(null)
    setNameError(null)
    setLogs([])
    setProgress(null)
    setNotices([])
    setResult(null)
    setDemoUrl(null)
    setPhase('training')
    setEngineBusy(true)
    setEngineStatus(t('status.training', { mode: t(`training.${mode}`) }))

    // Generated up front (not after training) and passed through as model_id
    // so the engine writes this run's weights to a file of its own — without
    // it, every "standard" (or "professional") run lands on the same fixed
    // model_<mode>.onnx and silently overwrites whatever the last one wrote,
    // while older model cards in the library keep pointing at that same path.
    const id = crypto.randomUUID()

    try {
      // Ticket 48: the dropzone only ever collected these File objects into
      // renderer state — nothing wrote them to disk or told the engine
      // about them, so every "trained" model was silently fine-tuned on
      // synthetic dummy sine-wave audio (VocalDataset's CI fallback)
      // instead of the singer's actual voice, regardless of what the user
      // uploaded here. That's the root cause behind the reported timbre
      // mismatch: the model never saw the real training material at all.
      // saveTrainingFiles() writes the uploaded buffers to a per-session
      // directory under userData and returns its path for data_dir below.
      let dataDir: string | undefined
      if (audioFiles.length > 0) {
        const files = await Promise.all(
          audioFiles.map(async ({ file }) => ({ name: file.name, buffer: await file.arrayBuffer() }))
        )
        dataDir = await window.engine.saveTrainingFiles(files)
      }

      const engineDevice = engineDeviceFor(deviceMode, device)
      const res = await window.engine.stream('train_model', {
        mode, epochs, batch: 16, model_id: id,
        // Ticket T2: the device is decided here, not re-detected in the
        // engine, so what the progress panel shows is what the run uses.
        device: engineDevice,
        ...(dataDir ? { data_dir: dataDir } : {}),
      }, mode === 'professional' && engineDevice === 'cpu'
        ? { stallTimeoutMs: CPU_PROFESSIONAL_STALL_TIMEOUT_MS }
        : undefined,
      ) as TrainingResult

      // Leave the training view before doing post-processing so the progress
      // component and its log nodes are unmounted and can be collected.
      setPhase('finalizing')
      setLogs([])
      setResult(res)

      const demo = await generateDemo(res.output_path)
      setDemoUrl(demo?.url ?? null)

      addModel({
        id,
        name:          modelName.trim() || `Model ${id.slice(0, 6)}`,
        coverDataUrl:  coverUrl,
        mode,
        trainedAt:     Date.now(),
        onnxPath:      res.output_path,
        demoAudioUrl:  demo?.url ?? null,
        demoAudioPath: demo?.path ?? null,
        epochs:        res.epochs,
        bestLoss:      res.best_loss,
        qualityScore:   res.quality_score,
        qualityWarning: res.quality_warning ?? null,
      })

      setPhase('done')
      // Ticket 35 §5: fires even if the user has since navigated away from
      // Model Training, since it's an app-wide notification, not local state.
      notify({
        category: 'taskCompletion',
        titleKey: 'notification.training.complete.title',
        messageKey: 'notification.training.complete.message',
        messageParams: { modelName: modelName.trim() || `Model ${id.slice(0, 6)}` },
        action: { type: 'view', view: 'training' },
      })
      // Ticket 21: audible cue on completion, mirroring the taskCompletion
      // toast/history suppression so muting that category also mutes the chime.
      if (useNotificationStore.getState().preferences.categoriesEnabled.taskCompletion) {
        playCompletionChime()
      }
    } catch (err) {
      // A user-requested stop isn't a failure: the bridge rejects a killed
      // run with this sentinel so it can be told apart from a crash, and it
      // shouldn't raise an error banner or a failure notification.
      if (String(err).includes('ENGINE_CANCELLED')) {
        setPhase('idle')
        setLogs((prev) => [...prev, t('training.cancelled')])
        return
      }
      // Ticket T2: surface what the engine actually said (disk full, dataset
      // unreadable, missing Python) rather than Electron's IPC wrapper around it.
      // Ticket P3: and where that sentence is a known failure mode, lead with
      // what to do about it — the raw text stays available below it.
      const raw     = describeError(err, t('training.failed'))
      const failure = classifyTrainingFailure(raw)
      const message = failure.messageKey ? t(failure.messageKey) : raw
      setError(message)
      setErrorDetail(failure.messageKey ? failure.detail : null)
      setPhase('idle')
      notify({
        category: 'taskFailure',
        titleKey: 'notification.training.failed.title',
        messageKey: 'notification.training.failed.message',
        messageParams: { message },
        action: { type: 'view', view: 'training' },
      })
    } finally {
      setEngineBusy(false)
      setEngineStatus(t('status.idle'))
    }
  }

  // ── play a model's demo audio ─────────────────────────────
  // After a restart demoAudioUrl is null (blob URLs don't survive reload —
  // see useModelLibrary), but demoAudioPath is durable. Regenerate the blob
  // URL lazily, only when the user actually presses Play.
  async function handlePlay(m: typeof trainedModels[0]): Promise<void> {
    if (playingModelId === m.id) { setPlayingModelId(null); return }
    if (!m.demoAudioUrl && m.demoAudioPath) {
      try {
        const buf = await window.engine.readFile(m.demoAudioPath)
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
        updateModelDemo(m.id, url)
      } catch {
        // Demo file may have been moved/deleted outside the app; ModelCard's
        // disabled state already reflects demoAudioPath being unusable next render.
      }
    }
    setPlayingModelId(m.id)
  }

  async function handleCancelTraining(): Promise<void> {
    setCancelling(true)
    try {
      await window.engine.cancelStream()
      // The phase transition is left to handleTrain's catch: the kill makes
      // the in-flight stream reject, and unwinding it there keeps one exit
      // path for the run instead of two racing to reset the same state.
    } catch (err) {
      setError(describeError(err, t('training.failed')))
    } finally {
      setCancelling(false)
    }
  }

  // ── download (encrypt + save-as) a model card ─────────────
  // Takes the two fields it actually needs rather than a whole model card,
  // so the just-finished run (Ticket UI-10 §5) can reuse it without
  // fabricating one.
  async function handleDownload(onnxPath: string, name: string): Promise<void> {
    try {
      const saved = await window.engine.downloadModel(onnxPath, name)
      if (!saved) return // user cancelled the save dialog
      notify({
        category: 'taskCompletion',
        titleKey: 'notification.training.downloaded.title',
        messageKey: 'notification.training.downloaded.message',
        messageParams: { modelName: name },
      })
    } catch (err) {
      notify({
        category: 'taskFailure',
        titleKey: 'notification.training.downloadFailed.title',
        messageKey: 'notification.training.downloadFailed.message',
        messageParams: { message: String(err) },
      })
    }
  }

  // ── delete a model card ───────────────────────────────────
  function handleDelete(m: TrainedModel): void {
    if (playingModelId === m.id) setPlayingModelId(null)
    if (m.demoAudioUrl) URL.revokeObjectURL(m.demoAudioUrl)
    removeModel(m.id)
    // Best-effort; scoped server-side to the app's own data dir, so this is a
    // no-op (not an error) for anything outside it. Each model now has its
    // own onnxPath/demoAudioPath (see engine/main.py's model_id), so this
    // can't delete a file another model card still relies on.
    void window.engine.deleteDataFile(m.onnxPath)
    if (m.demoAudioPath) void window.engine.deleteDataFile(m.demoAudioPath)
  }

  // ── retrain from a model card ─────────────────────────────
  function handleRetrain(m: typeof trainedModels[0]): void {
    setModelName(m.name)
    setCoverUrl(m.coverDataUrl)
    setMode(m.mode)
    setEpochs(m.epochs)
    setPhase('idle')
    setResult(null)
    setDemoUrl(null)
    setError(null)
    setErrorDetail(null)
    setNameError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── reset to form ─────────────────────────────────────────
  function handleReset(): void {
    setPhase('idle')
    setModelName('')
    setCoverUrl(null)
    setAudioFiles([])
    setMode('standard')
    setEpochs(10)
    setProgress(null)
    setNotices([])
    setLogs([])
    setResult(null)
    setDemoUrl(null)
    setError(null)
    setErrorDetail(null)
    setNameError(null)
  }

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('training.title')}</h1>
        <p className="view-desc">{t('training.description')}</p>
      </div>

      {/* ── Training form (idle phase) ────────────────────── */}
      {phase === 'idle' && (
        <>
          <div className="card">
            <div className="card-title">{t('training.info')}</div>

            <div className="row">
              {/* Cover image */}
              <div style={{ flexShrink: 0 }}>
                <label className="cover-picker" title="Click to set cover image">
                  {coverUrl
                    ? <img src={coverUrl} alt="cover" className="cover-img" />
                    : <span className="cover-placeholder">🎤</span>}
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleCoverPick} />
                </label>
              </div>

              {/* Name + epochs */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="training-model-name">{t('training.name')}</label>
                  <input
                    id="training-model-name"
                    ref={nameInputRef}
                    className={`input${nameError ? ' invalid' : ''}`}
                    placeholder={t('training.namePlaceholder')}
                    value={modelName}
                    // Ticket T3: editing the name is the fix for this error, so
                    // the red field and the stale start-up banner clear as soon
                    // as the user types — otherwise a corrected name still looks
                    // rejected.
                    onChange={(e) => {
                      setModelName(e.target.value)
                      if (nameError) setNameError(null)
                      if (error) { setError(null); setErrorDetail(null) }
                    }}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={nameError ? 'training-model-name-error' : undefined}
                    maxLength={50}
                  />
                  {nameError && (
                    <p id="training-model-name-error" className="field-error" role="alert">
                      {nameError}
                    </p>
                  )}
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>{t('training.epochs')}</label>
                  <input
                    className="input"
                    type="number" min={1} max={200}
                    value={epochs}
                    onChange={(e) => setEpochs(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">{t('training.material')}</div>
            <AudioDropzone onFilesChange={setAudioFiles} />
            {audioFiles.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                {t('training.noFiles')}
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-title">{t('training.mode')}</div>
            <ModeSelector value={mode} onChange={setMode} />
          </div>

          {/* Ticket T2: all training runs locally — there is no cloud backend
              — so the device is a real choice with real consequences. The
              selector states what was detected, disables GPU when torch can't
              use one, and carries the slowdown warning the mode cards only
              implied through their GPU/CPU time estimates. */}
          <div className="card">
            <div className="card-title">{t('training.deviceMode')}</div>
            <DeviceSelector device={device} value={deviceMode} onChange={setDeviceMode} />
          </div>

          {/* Ticket T3: the pre-flight checklist, and the gate on the button below. */}
          <div className="card">
            <div className="card-title">{t('envCheck.title')}</div>
            <EnvironmentCheck
              report={envReport}
              loading={envLoading}
              error={envError}
              onRerun={() => void runEnvCheck()}
            />
            <EngineLogPanel entries={engineLogs} />
          </div>

          {error && (
            <div className="error-banner" role="alert">
              <div>{error}</div>
              {errorDetail && (
                <details className="error-detail">
                  <summary>{t('training.error.showDetail')}</summary>
                  <pre className="error-detail-body">{errorDetail}</pre>
                </details>
              )}
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: '100%', padding: 12 }}
            onClick={handleTrain}
            disabled={envLoading || !envSummary.canTrain}
            title={envSummary.canTrain ? undefined : t('envCheck.blocked')}
          >
            ▶ {t('training.start')}
          </button>
          {!envLoading && !envSummary.canTrain && (
            <p className="env-check-blocked-hint">{t('envCheck.blocked')}</p>
          )}
        </>
      )}

      {/* ── Progress phase ────────────────────────────────── */}
      {phase === 'training' && (
        <div className="card">
          <div className="card-title">{t('training.training')}</div>
          {notices.length > 0 && (
            <div className="training-notices" role="status">
              {notices.map((message, i) => (
                <p key={i} className="training-notice">⚠ {message}</p>
              ))}
            </div>
          )}
          <TrainingProgress
            progress={progress}
            logs={logs}
            mode={mode}
            // Until the engine's first progress line arrives, the run's device
            // is still known — it's the one the user just confirmed — so show
            // that rather than an empty badge (Ticket T2).
            deviceLabel={progress?.device
              ? progress.device.toUpperCase()
              : describeDevice(engineDeviceFor(deviceMode, device) === 'cpu' ? null : device)}
            onCancel={() => void handleCancelTraining()}
            cancelling={cancelling}
          />
          <EngineLogPanel entries={engineLogs} defaultOpen />
        </div>
      )}

      {/* ── Finalizing phase ──────────────────────────────── */}
      {phase === 'finalizing' && (
        <div className="card">
          <div className="card-title">{t('training.finalizing')}</div>
          <p className="view-desc">{t('training.finalizingDesc')}</p>
        </div>
      )}

      {/* ── Done phase ────────────────────────────────────── */}
      {phase === 'done' && result && (
        <>
          <div className="card">
            <div className="card-title" style={{ color: 'var(--success)' }}>{t('training.complete')}</div>

            {/* Ticket 48 §7: low similarity between the exported model and its
                training material means the voice likely won't resemble the
                singer — surface that plainly instead of letting a bad model
                look identical to a good one in the UI. */}
            {result.quality_warning && (
              <div className="cpu-notice" style={{ marginBottom: 12 }}>
                ⚠ {result.quality_warning}
              </div>
            )}
            {result.data_quality?.warnings.map((w, i) => (
              <div key={i} className="cpu-notice" style={{ marginBottom: 12 }}>
                ⚠ {w}
              </div>
            ))}

            <div className="result-box">
              {JSON.stringify({ ...result, output_path: result.output_path.split('/').pop() }, null, 2)}
            </div>

            {demoUrl && (
              <div style={{ marginTop: 16 }}>
                <div className="card-title" style={{ marginBottom: 12 }}>{t('training.audition')}</div>
                <AudioPlayer src={demoUrl} title={`${modelName} · demo`} />
              </div>
            )}

            {/* Ticket UI-10 §5: the download shows up on completion rather
                than making the user hunt for the new card in the library. */}
            <div className="row" style={{ marginTop: 16 }}>
              <button
                className="btn btn-primary tc-download-btn"
                onClick={() => void handleDownload(result.output_path, modelName.trim() || 'model')}
              >
                ⬇ {t('training.download')}
              </button>
              <button className="btn btn-ghost" onClick={handleReset}>{t('training.trainAnother')}</button>
            </div>
          </div>
        </>
      )}

      {/* ── Model list ────────────────────────────────────── */}
      {phase === 'idle' && (
        <div className="card" style={{ marginTop: 32 }}>
          <div className="card-title">{t('training.models', { count: trainedModels.length })}</div>

          {/* Ticket UI-11 §5: the section stays put when empty and says what
              to do next, rather than vanishing and leaving the page looking
              like the library doesn't exist. */}
          {trainedModels.length === 0 ? (
            <div className="mc-empty">
              <div className="mc-empty-art" aria-hidden="true">🎤</div>
              <p className="mc-empty-text">{t('training.emptyLibrary')}</p>
            </div>
          ) : (
          <div className="model-grid">
            {trainedModels.map((m) => (
              <div key={m.id}>
                <ModelCard
                  model={m}
                  applied={selectedModel === m.onnxPath}
                  playing={playingModelId === m.id}
                  onApply={() => setSelectedModel(m.onnxPath)}
                  onDelete={() => setPendingDelete(m)}
                  onRetrain={() => handleRetrain(m)}
                  onPlay={() => void handlePlay(m)}
                  onDownload={() => void handleDownload(m.onnxPath, m.name)}
                />
                {playingModelId === m.id && m.demoAudioUrl && (
                  <div style={{ marginTop: 8 }}>
                    <AudioPlayer src={m.demoAudioUrl} title={`${m.name} · demo`} />
                  </div>
                )}
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {/* Ticket P1/P2: the local self-check, acknowledged before the engine
          is started. Blockers disable the confirm button; a professional run
          heading for the CPU also gets a one-click way out. */}
      {preflight && (
        <TrainingPreflightDialog
          result={preflight}
          onSwitchToStandard={preflight.cpuProfessional
            ? () => { setMode('standard'); setPreflight(runPreflight('standard')) }
            : undefined}
          onConfirm={() => { setPreflight(null); void runTraining() }}
          onCancel={() => setPreflight(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          danger
          title={t('training.deleteTitle')}
          message={t('training.deleteConfirm', { name: pendingDelete.name })}
          confirmLabel={t('training.delete')}
          onConfirm={() => { handleDelete(pendingDelete); setPendingDelete(null) }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  )
}
