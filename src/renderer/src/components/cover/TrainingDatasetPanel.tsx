import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '../../store/useNotificationStore'
import type { TargetSong } from '../../store/useAppStore'

// ── Engine response shapes (engine/train_dataset.py) ─────────────────────────
interface ShiftResult {
  output_path: string
  duration_sec: number
}
interface MergeResult {
  output_path: string
  duration_sec: number
  sample_rate: number
  align_mode: 'pad' | 'truncate'
  adjusted_sec: number
  normalized: boolean
  dry_vocal_path?: string
}
interface PackageResult {
  zip_path: string
  size_bytes: number
}

type UploadPhase = 'idle' | 'packaging' | 'uploading' | 'training' | 'done' | 'error'

interface Props {
  /** The AI vocal (coverResult.ai_vocal_path). Null until synthesis (step 3) has produced one. */
  vocalPath: string | null
  /** Whether Ticket 17's <HighPitchProtection> has actually run on `vocalPath` — see CoverView's onApplied. */
  vocalProtected: boolean
  /** The clean dry vocal from separation, offered as an optional extra training track. */
  dryVocalPath?: string | null
  /** Ticket 18's Cloud Library selection — the "target song" Ticket 19 pitch-shifts. */
  targetSong: TargetSong | null
  /** Marks the wizard's step 5 complete once a merge succeeds. */
  onMerged?: () => void
}

// Phase weights for a single monotonic 0-100 progress bar across
// packaging → uploading → training, rather than resetting to 0 at each
// phase boundary (the acceptance criterion is "0% to 100%", not three
// separate bars).
function combinedPercent(phase: UploadPhase, subPercent: number): number {
  switch (phase) {
    case 'packaging': return Math.min(10, subPercent * 0.1)
    case 'uploading':  return 10 + Math.min(100, subPercent) * 0.4
    case 'training':   return 50 + Math.min(100, subPercent) * 0.5
    case 'done':        return 100
    default:            return 0
  }
}

export function TrainingDatasetPanel({
  vocalPath, vocalProtected, dryVocalPath, targetSong, onMerged,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const taskIdRef = useRef<string>(crypto.randomUUID())

  // ── Ticket 19: pitch shift ────────────────────────────────
  const [semitones, setSemitones]     = useState(0)
  const [shifting, setShifting]       = useState(false)
  const [shiftRes, setShiftRes]       = useState<ShiftResult | null>(null)
  const [shiftError, setShiftError]   = useState<string | null>(null)
  const [includeDryVocal, setIncludeDryVocal] = useState(false)

  // A newly-picked target song invalidates whatever shift was already
  // applied — otherwise switching songs could silently merge in a shift
  // computed against the previous one.
  useEffect(() => { setShiftRes(null); setShiftError(null); setMergeRes(null) }, [targetSong?.id])
  // A fresh (or freshly re-protected) AI vocal invalidates any merge that
  // was built from the old one.
  useEffect(() => { setMergeRes(null) }, [vocalPath, vocalProtected])

  // ── Ticket 20: merge ──────────────────────────────────────
  const [merging, setMerging]         = useState(false)
  const [mergeRes, setMergeRes]       = useState<MergeResult | null>(null)
  const [mergeError, setMergeError]   = useState<string | null>(null)

  // ── Ticket 20: package → upload → train ──────────────────
  const [phase, setPhase]             = useState<UploadPhase>('idle')
  const [subPercent, setSubPercent]   = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [modelUrl, setModelUrl]       = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current) }, [])

  async function handlePitchShift(): Promise<void> {
    if (!targetSong) return
    setShifting(true); setShiftError(null)
    try {
      const res = await window.engine.call('pitch_shift', {
        input_path: targetSong.audioPath, semitones, task_id: taskIdRef.current,
      }) as ShiftResult
      setShiftRes(res)
    } catch (err) {
      setShiftError(String(err))
    } finally {
      setShifting(false)
    }
  }

  // ── Prerequisites (Tickets 17/18/19, enforced) ────────────
  const missing: string[] = []
  if (!vocalProtected) missing.push(t('cover.prereqProtection'))
  if (!targetSong)     missing.push(t('cover.prereqTargetSong'))
  if (!shiftRes)        missing.push(t('cover.prereqPitchShift'))
  const prereqsMet = missing.length === 0

  async function handleMerge(): Promise<void> {
    if (!prereqsMet || !vocalPath || !shiftRes) return
    setMerging(true); setMergeError(null); setMergeRes(null)
    try {
      const res = await window.engine.call('merge_train_audio', {
        vocal_path:        vocalPath,
        target_path:       shiftRes.output_path,
        task_id:           taskIdRef.current,
        align_mode:        'pad',
        include_dry_vocal: includeDryVocal,
        dry_vocal_path:    dryVocalPath ?? undefined,
      }) as MergeResult
      setMergeRes(res)
      onMerged?.()
    } catch (err) {
      setMergeError(String(err))
    } finally {
      setMerging(false)
    }
  }

  // ── Package → upload → train, with polled progress ───────
  async function handleUploadAndTrain(): Promise<void> {
    if (!mergeRes) return
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
    setUploadError(null); setModelUrl(null)
    setPhase('packaging'); setSubPercent(0); setStatusMessage('')

    try {
      const files = [{ path: mergeRes.output_path, name: 'merged_train.wav' }]
      if (mergeRes.dry_vocal_path) files.push({ path: mergeRes.dry_vocal_path, name: 'dry_vocal.wav' })

      const pkg = await window.engine.call('package_train_dataset', {
        files, task_id: taskIdRef.current,
      }) as PackageResult
      setSubPercent(100)

      setPhase('uploading'); setSubPercent(0)
      const taskId = taskIdRef.current
      const started = await window.engine.uploadTrainDataset(pkg.zip_path, taskId, {
        mode:                 'standard',
        pitchShiftSemitones:  semitones,
        highPitchProtection:  true,
        includeDryVocal,
      })
      setPhase(started.status === 'training' ? 'training' : 'uploading')

      await new Promise<void>((resolve, reject) => {
        pollTimer.current = setInterval(() => {
          window.engine.getTrainStatus(taskId).then((status) => {
            setSubPercent(status.percent)
            setStatusMessage(status.message ?? '')
            if (status.status === 'uploading' || status.status === 'queued') { setPhase('uploading'); return }
            if (status.status === 'training') { setPhase('training'); return }

            if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
            if (status.status === 'completed') {
              setPhase('done'); setSubPercent(100); setModelUrl(status.model_url ?? null)
              resolve()
            } else {
              reject(new Error(status.error ?? 'training failed'))
            }
          }).catch((err) => {
            if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
            reject(err instanceof Error ? err : new Error(String(err)))
          })
        }, 1_500)
      })

      notify({
        category: 'taskCompletion',
        titleKey: 'notification.trainUpload.complete.title',
        messageKey: 'notification.trainUpload.complete.message',
        action: { type: 'view', view: 'cover' },
      })
    } catch (err) {
      setPhase('error'); setUploadError(String(err))
      notify({
        category: 'taskFailure',
        titleKey: 'notification.trainUpload.failed.title',
        messageKey: 'notification.trainUpload.failed.message',
        messageParams: { message: String(err) },
        action: { type: 'view', view: 'cover' },
      })
    }
  }

  const uploading = phase === 'packaging' || phase === 'uploading' || phase === 'training'
  const pct = combinedPercent(phase, subPercent)
  const phaseLabel = phase === 'packaging' ? t('cover.phasePackaging')
    : phase === 'uploading' ? t('cover.phaseUploading')
    : phase === 'training'  ? t('cover.phaseTraining')
    : phase === 'done'       ? t('cover.phaseDone')
    : ''

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        {t('cover.trainingDataDesc')}
      </p>

      {/* ── Ticket 17 status (applied in step ③'s <HighPitchProtection>) ── */}
      <div className="field">
        <label>{t('cover.protectionTitle')}</label>
        {!vocalPath && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('cover.protectionNeedsVocal')}</div>}
        {vocalPath && !vocalProtected && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('cover.protectionNotApplied')}</div>}
        {vocalPath && vocalProtected && <div style={{ fontSize: 12, color: 'var(--success)' }}>{t('cover.protectionApplied')}</div>}
      </div>

      {/* ── Ticket 19: pitch shift ────────────────────────────── */}
      <div className="field">
        <label>{t('cover.pitchShiftTitle')}</label>
        {!targetSong && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('cover.pitchShiftNeedsSong')}</div>}
        {targetSong && (
          <>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('cover.pitchShiftSemitones')}</label>
              <input
                className="input" type="number" min={-12} max={12} step={1}
                style={{ width: 80 }}
                value={semitones}
                onChange={(e) => {
                  setSemitones(Number(e.target.value))
                  setShiftRes(null); setMergeRes(null)
                }}
              />
              <button className="btn btn-ghost" onClick={handlePitchShift} disabled={shifting}>
                {shifting ? `⏳ ${t('cover.pitchShiftApplying')}` : `🎚 ${t('cover.pitchShiftApply')}`}
              </button>
            </div>
            {shiftError && <div className="error-banner" style={{ marginTop: 8 }}>{shiftError}</div>}
            {shiftRes && (
              <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>
                {t('cover.pitchShiftApplied', { semitones })}
              </div>
            )}
          </>
        )}
      </div>

      {dryVocalPath && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={includeDryVocal}
            onChange={(e) => { setIncludeDryVocal(e.target.checked); setMergeRes(null) }}
          />
          {t('cover.includeDryVocal')}
        </label>
      )}

      {/* ── Ticket 20: merge ──────────────────────────────────── */}
      <div className="field">
        <label>{t('cover.mergeTitle')}</label>
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleMerge}
          disabled={!prereqsMet || merging}
          title={prereqsMet ? undefined : t('cover.mergeBlockedTooltip', { reasons: missing.join('、') })}
        >
          {merging ? `⏳ ${t('cover.merging')}` : `🔀 ${t('cover.mergeAction')}`}
        </button>
        {mergeError && <div className="error-banner" style={{ marginTop: 8 }}>{mergeError}</div>}
        {mergeRes && (
          <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>
            {t('cover.mergeResultInfo', { duration: mergeRes.duration_sec, sampleRate: mergeRes.sample_rate })}
            {mergeRes.adjusted_sec > 0 && (
              mergeRes.align_mode === 'pad'
                ? t('cover.mergePadded', { sec: mergeRes.adjusted_sec })
                : t('cover.mergeTruncated', { sec: mergeRes.adjusted_sec })
            )}
          </div>
        )}
      </div>

      {/* ── Ticket 20: upload & train ─────────────────────────── */}
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t('cover.uploadTitle')}</label>
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleUploadAndTrain}
          disabled={!mergeRes || uploading}
          title={mergeRes ? undefined : t('cover.uploadNeedsMerge')}
        >
          {uploading ? `⏳ ${phaseLabel}` : `☁️ ${t('cover.uploadAction')}`}
        </button>

        {phase !== 'idle' && (
          <div className="progress-track" style={{ marginTop: 10 }}
               role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
            <span className="progress-pct">{Math.round(pct)}%</span>
          </div>
        )}
        {statusMessage && phase !== 'error' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{statusMessage}</div>
        )}
        {uploadError && <div className="error-banner" style={{ marginTop: 8 }}>{uploadError}</div>}
        {phase === 'done' && (
          <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>
            {phaseLabel}{modelUrl ? ` · ${t('cover.uploadResult', { modelUrl })}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}
