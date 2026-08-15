import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { AudioDropzone } from '../components/training/AudioDropzone'
import { ModeSelector, type TrainingMode } from '../components/training/ModeSelector'
import { TrainingProgress, type ProgressData } from '../components/training/TrainingProgress'
import { AudioPlayer } from '../components/training/AudioPlayer'
import { ModelCard } from '../components/training/ModelCard'
import { CloudPanel } from '../components/cloud/CloudPanel'

type Phase = 'idle' | 'training' | 'finalizing' | 'done'

/** Progress lines are capped so a long professional run can't grow the DOM without bound. */
const MAX_LOG_LINES = 200

interface TrainingResult {
  status:           string
  output_path:      string
  epochs:           number
  best_loss:        number
  trainable_params: number
  elapsed_sec:      number
  model_bytes:      number
  device:           string
}

export function TrainingView(): JSX.Element {
  const { t } = useTranslation()
  // ── form state ───────────────────────────────────────────
  const [modelName,   setModelName]   = useState('')
  const [coverUrl,    setCoverUrl]    = useState<string | null>(null)
  const [audioFiles,  setAudioFiles]  = useState<File[]>([])
  const [mode,        setMode]        = useState<TrainingMode>('standard')
  const [epochs,      setEpochs]      = useState(10)

  // ── Cloud acceleration ───────────────────────────────────
  // Detect if local hardware is CPU-only; show cloud banner if so
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
  const generateDemo = useCallback(async (onnxPath: string): Promise<string | null> => {
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
      return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
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

    try {
      const res = await window.engine.stream('train_model', {
        mode, epochs, batch: 16,
      }) as TrainingResult

      // Leave the training view before doing post-processing so the progress
      // component and its log nodes are unmounted and can be collected.
      setPhase('finalizing')
      setLogs([])
      setResult(res)

      const demo = await generateDemo(res.output_path)
      setDemoUrl(demo)

      const id = crypto.randomUUID()
      addModel({
        id,
        name:         modelName.trim() || `Model ${id.slice(0, 6)}`,
        coverDataUrl: coverUrl,
        mode,
        trainedAt:    Date.now(),
        onnxPath:     res.output_path,
        demoAudioUrl: demo,
        epochs:       res.epochs,
        bestLoss:     res.best_loss,
      })

      setPhase('done')
    } catch (err) {
      setError(String(err))
      setPhase('idle')
    } finally {
      setEngineBusy(false)
      setEngineStatus(t('status.idle'))
    }
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

          {/* Cloud acceleration — shown when local hardware is CPU-only */}
          {deviceEp === 'CPU' && phase === 'idle' && (
            <CloudPanel
              mode={mode}
              epochs={epochs}
              audioFiles={audioFiles}
              localModelPath={`engine/model_${mode}.onnx`}
              onModelReady={(path) => {
                setSelectedModel(path)
                // Surface the cloud-trained model into the Zustand store
                const id = crypto.randomUUID()
                addModel({
                  id,
                  name:         `${modelName.trim() || 'Cloud'} (cloud)`,
                  coverDataUrl: coverUrl,
                  mode,
                  trainedAt:    Date.now(),
                  onnxPath:     path,
                  demoAudioUrl: null,
                  epochs,
                  bestLoss:     0,
                })
              }}
            />
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
                  onDelete={() => removeModel(m.id)}
                  onRetrain={() => handleRetrain(m)}
                  onPlay={() => setPlayingModelId(playingModelId === m.id ? null : m.id)}
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
