import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { notify } from '../store/useNotificationStore'
import { AudioDropzone } from '../components/training/AudioDropzone'
import { ModeSelector, type TrainingMode } from '../components/training/ModeSelector'
import { TrainingProgress, type ProgressData } from '../components/training/TrainingProgress'
import { AudioPlayer } from '../components/training/AudioPlayer'
import { ModelCard } from '../components/training/ModelCard'

type Phase = 'idle' | 'training' | 'finalizing' | 'done'

/** Progress lines are capped so a long professional run can't grow the DOM without bound. */
const MAX_LOG_LINES = 200

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
  const [audioFiles,  setAudioFiles]  = useState<File[]>([])
  const [mode,        setMode]        = useState<TrainingMode>('standard')
  const [epochs,      setEpochs]      = useState(10)

  // ── Hardware detection ────────────────────────────────────
  // Detect if local hardware is CPU-only so we can warn that training (which
  // always runs locally — there is no cloud backend) will be slower.
  const [deviceEp, setDeviceEp] = useState<string | null>(null)
  useEffect(() => {
    window.engine.call('detect_device')
      .then((res) => setDeviceEp((res as Record<string, unknown>).ep as string))
      .catch(() => {})
  }, [])

  // ── training state ───────────────────────────────────────
  const [phase,       setPhase]       = useState<Phase>('idle')
  const [progress,    setProgress]    = useState<ProgressData | null>(null)
  const [logs,        setLogs]        = useState<string[]>([])
  const [result,      setResult]      = useState<TrainingResult | null>(null)
  const [demoUrl,     setDemoUrl]     = useState<string | null>(null)
  const [error,       setError]       = useState<string | null>(null)

  // ── model list state (player overlay) ────────────────────
  const [playingModelId, setPlayingModelId] = useState<string | null>(null)

  const trainedModels  = useAppStore((s) => s.trainedModels)
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
      const data = raw as ProgressData
      setProgress(data)
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
  async function handleTrain(): Promise<void> {
    if (!modelName.trim()) { setError(t('training.name')); return }
    setError(null)
    setLogs([])
    setProgress(null)
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
          audioFiles.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() }))
        )
        dataDir = await window.engine.saveTrainingFiles(files)
      }

      const res = await window.engine.stream('train_model', {
        mode, epochs, batch: 16, model_id: id,
        ...(dataDir ? { data_dir: dataDir } : {}),
      }) as TrainingResult

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
    } catch (err) {
      setError(String(err))
      setPhase('idle')
      notify({
        category: 'taskFailure',
        titleKey: 'notification.training.failed.title',
        messageKey: 'notification.training.failed.message',
        messageParams: { message: String(err) },
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

  // ── delete a model card ───────────────────────────────────
  function handleDelete(m: typeof trainedModels[0]): void {
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
    setLogs([])
    setResult(null)
    setDemoUrl(null)
    setError(null)
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
                  <label>{t('training.name')}</label>
                  <input
                    className="input"
                    placeholder={t('training.namePlaceholder')}
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    maxLength={50}
                  />
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

          {error && <div className="error-banner">{error}</div>}

          {/* All training runs locally — there is no cloud backend. This is
              just a heads-up so a CPU-only user isn't surprised by the time,
              which the mode cards above already spell out (cpuTime). */}
          {deviceEp === 'CPU' && phase === 'idle' && (
            <div className="cpu-notice">
              ⚠ No GPU detected — training will run on this machine's CPU and take
              noticeably longer (see the estimated times above).
            </div>
          )}

          <button className="btn btn-primary" style={{ width: '100%', padding: 12 }} onClick={handleTrain}>
            ▶ {t('training.start')}
          </button>
        </>
      )}

      {/* ── Progress phase ────────────────────────────────── */}
      {phase === 'training' && (
        <div className="card">
          <div className="card-title">{t('training.training')}</div>
          <TrainingProgress progress={progress} logs={logs} mode={mode} />
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

            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={handleReset}>{t('training.trainAnother')}</button>
            </div>
          </div>
        </>
      )}

      {/* ── Model list ────────────────────────────────────── */}
      {trainedModels.length > 0 && (
        <div className="card" style={{ marginTop: 32 }}>
          <div className="card-title">{t('training.models', { count: trainedModels.length })}</div>
          <div className="model-grid">
            {trainedModels.map((m) => (
              <div key={m.id}>
                <ModelCard
                  model={m}
                  onDelete={() => handleDelete(m)}
                  onRetrain={() => handleRetrain(m)}
                  onPlay={() => void handlePlay(m)}
                />
                {playingModelId === m.id && m.demoAudioUrl && (
                  <div style={{ marginTop: 8 }}>
                    <AudioPlayer src={m.demoAudioUrl} title={`${m.name} · demo`} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
