import { useEffect, useState } from 'react'
import { useCloudAcceleration, estimateCost, type CloudPhase } from '../../hooks/useCloudAcceleration'
import { formatDuration } from '../../utils/audio'

interface Props {
  mode:            'standard' | 'professional'
  epochs:          number
  audioFiles:      File[]
  localModelPath:  string   // fallback / result model path
  onModelReady?:   (path: string) => void
}

// Badge copy per phase
const PHASE_LABELS: Record<CloudPhase, string> = {
  idle:          'Idle',
  encrypting:    'Encrypting material…',
  uploading:     'Uploading encrypted chunks…',
  queued:        'Queued — waiting for GPU slot',
  preprocessing: 'Preprocessing audio…',
  training:      'Training on cloud GPU…',
  exporting:     'Exporting ONNX model…',
  downloading:   'Downloading encrypted model…',
  decrypting:    'Decrypting model locally…',
  done:          'Done',
  error:         'Error',
}

const ACTIVE_PHASES: Set<CloudPhase> = new Set([
  'encrypting', 'uploading', 'queued',
  'preprocessing', 'training', 'exporting',
  'downloading', 'decrypting',
])

export function CloudPanel({ mode, epochs, audioFiles, localModelPath, onModelReady }: Props): JSX.Element {
  const { state, start, cancel, reset } = useCloudAcceleration()
  const [expanded, setExpanded] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const cost    = estimateCost(mode)
  const isActive = ACTIVE_PHASES.has(state.phase)
  const totalMB = audioFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024

  useEffect(() => {
    if (state.phase === 'done' && state.resultPath) {
      onModelReady?.(state.resultPath)
    }
  }, [state.phase, state.resultPath, onModelReady])

  async function handleStart(): Promise<void> {
    await start(audioFiles, mode, epochs, localModelPath)
  }

  // Compute a unified 0-100 overall progress
  const overallPct = (() => {
    if (state.phase === 'idle' || state.phase === 'error') return 0
    if (state.phase === 'done') return 100
    if (state.phase === 'encrypting') return 2
    if (state.phase === 'uploading')  return 2 + state.uploadPct * 0.28   // 2–30%
    if (state.phase === 'queued')     return 30
    // cloud task phases: 30–85%
    if (['preprocessing', 'training', 'exporting'].includes(state.phase))
      return 30 + state.taskPct * 0.55
    if (state.phase === 'downloading') return 86
    if (state.phase === 'decrypting')  return 96
    return 0
  })()

  if (!expanded && state.phase === 'idle') {
    // Collapsed teaser banner
    return (
      <div className="cloud-teaser" onClick={() => setExpanded(true)} role="button" tabIndex={0}>
        <span className="cloud-teaser-icon">☁️</span>
        <div>
          <div className="cloud-teaser-title">No GPU detected — training will be slow</div>
          <div className="cloud-teaser-sub">Use cloud acceleration · est. ${cost.totalUSD} USD</div>
        </div>
        <span className="cloud-teaser-arrow">›</span>
      </div>
    )
  }

  return (
    <div className="cloud-panel">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="cloud-panel-header">
        <span style={{ fontSize: 18 }}>☁️</span>
        <div>
          <div className="cloud-panel-title">Cloud Acceleration</div>
          <div className="cloud-panel-sub">Alibaba Cloud FC / AWS Lambda · Reserved GPU</div>
        </div>
        {state.phase === 'idle' && (
          <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12 }}
            onClick={() => setExpanded(false)}>▾ Collapse</button>
        )}
        {isActive && (
          <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--danger)' }}
            onClick={cancel}>Cancel</button>
        )}
        {(state.phase === 'done' || state.phase === 'error') && (
          <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12 }}
            onClick={reset}>Reset</button>
        )}
      </div>

      {/* ── Cost estimate (idle only) ───────────────────────── */}
      {state.phase === 'idle' && (
        <div className="cost-card">
          <div className="cost-row">
            <span>Mode</span>
            <strong>{mode === 'standard' ? 'Standard' : 'Professional'} · {epochs} epochs</strong>
          </div>
          <div className="cost-row">
            <span>Material</span>
            <strong>{totalMB > 0 ? `${totalMB.toFixed(1)} MB` : 'synthetic demo'}</strong>
          </div>
          <div className="cost-row">
            <span>Provider</span>
            <strong>{cost.provider.split(' / ')[0]}</strong>
          </div>
          <div className="cost-row">
            <span>GPU instance</span>
            <strong>${cost.ratePerHour.toFixed(2)} / hour</strong>
          </div>
          <div className="cost-row">
            <span>Estimated hours</span>
            <strong>~{cost.gpuHours} h</strong>
          </div>
          <div className="cost-row cost-total">
            <span>Estimated cost</span>
            <strong className="cost-amount">${cost.totalUSD.toFixed(2)} USD</strong>
          </div>

          <div className="cost-disclaimer">
            ⚠ Material is AES-256-GCM encrypted before upload. Your model stays private.
          </div>

          <label className="cost-confirm-row">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I accept the estimated cost</span>
          </label>

          <button className="btn btn-primary" style={{ width: '100%', marginTop: 12 }}
            onClick={handleStart} disabled={!confirmed}>
            ☁️ Start Cloud Training
          </button>
        </div>
      )}

      {/* ── Active progress ─────────────────────────────────── */}
      {(isActive || state.phase === 'done') && (
        <div className="cloud-progress-section">
          {/* Overall bar */}
          <div className="progress-track" style={{ marginBottom: 8 }}>
            <div className="progress-fill" style={{ width: `${overallPct}%` }} />
            <span className="progress-pct">{Math.round(overallPct)}%</span>
          </div>

          {/* Phase badge + elapsed */}
          <div className="cloud-status-row">
            <span className={`cloud-badge phase-${state.phase}`}>
              {state.phase === 'done' ? '✓' : '⏳'} {PHASE_LABELS[state.phase]}
            </span>
            {state.elapsedSec > 0 && (
              <span className="cloud-elapsed">{formatDuration(state.elapsedSec)}</span>
            )}
          </div>

          {/* Upload sub-bar */}
          {state.phase === 'uploading' && (
            <div className="cloud-sub-progress">
              <span>Upload</span>
              <div className="mini-track">
                <div className="mini-fill" style={{ width: `${state.uploadPct}%` }} />
              </div>
              <span>{state.uploadPct}%</span>
            </div>
          )}

          {/* Task sub-bar */}
          {['preprocessing', 'training', 'exporting'].includes(state.phase) && (
            <div className="cloud-sub-progress">
              <span>GPU task</span>
              <div className="mini-track">
                <div className="mini-fill" style={{ width: `${state.taskPct}%` }} />
              </div>
              <span>{Math.round(state.taskPct)}%</span>
            </div>
          )}

          {/* Task ID */}
          {state.taskId && (
            <div className="cloud-task-id">Task ID: {state.taskId}</div>
          )}
        </div>
      )}

      {/* ── Done ────────────────────────────────────────────── */}
      {state.phase === 'done' && state.resultPath && (
        <div className="cloud-result">
          <div className="cloud-result-title">✓ Model ready</div>
          <div className="cloud-result-sub">
            Decrypted and saved · {state.resultPath.split('/').pop()}
          </div>
          <div className="cloud-result-note">
            Security log: material encrypted with AES-256-GCM before upload;
            key never left this device.
          </div>
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────── */}
      {state.phase === 'error' && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          {state.error ?? 'Unknown error'}
        </div>
      )}
    </div>
  )
}
