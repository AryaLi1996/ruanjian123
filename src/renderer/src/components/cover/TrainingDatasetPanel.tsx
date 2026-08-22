import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '../../store/useNotificationStore'
import type { TargetSong } from '../../store/useAppStore'

// ── Engine response shapes (engine/train_dataset.py) ─────────────────────────
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
  /** Ticket 18's Cloud Library selection, carrying Ticket 19's applied
   * pitchShift/shiftedAudioPath (see useAppStore's TargetSong) — set from
   * step ①'s Tune slider, not by this panel. */
  targetSong: TargetSong | null
  /** True while step ①'s Tune slider has a shift in flight — merging
   * against a target song mid-recompute would grab a stale/about-to-change
   * file. */
  pitchShiftBusy?: boolean
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
  vocalPath, vocalProtected, dryVocalPath, targetSong, pitchShiftBusy = false, onMerged,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const taskIdRef = useRef<string>(crypto.randomUUID())

  const [includeDryVocal, setIncludeDryVocal] = useState(false)

  // ── Ticket 20: merge ──────────────────────────────────────
  const [merging, setMerging]         = useState(false)
  const [mergeRes, setMergeRes]       = useState<MergeResult | null>(null)
  const [mergeError, setMergeError]   = useState<string | null>(null)

  // A fresh (or freshly re-protected) AI vocal, a newly-picked target song,
  // or a re-shifted target invalidates any merge that was built from the
  // old inputs.
  useEffect(() => { setMergeRes(null) }, [vocalPath, vocalProtected, targetSong?.shiftedAudioPath, targetSong?.id])

  // ── Ticket 20: package → upload → train ──────────────────
  const [phase, setPhase]             = useState<UploadPhase>('idle')
  const [subPercent, setSubPercent]   = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [modelUrl, setModelUrl]       = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current) }, [])

  // ── Prerequisites (Tickets 17/18, enforced) ───────────────
  // Ticket 19's pitch shift doesn't need its own checklist entry: the Tune
  // slider (step ①) always carries a value once a target song is picked —
  // 0 semitones ("same key") is as valid an applied value as any other, not
  // a missing one — so "target song selected" already covers it. A shift
  // still being computed is instead a (separate) disable-with-tooltip
  // condition below, not a listed prerequisite.
  const missing: string[] = []
  if (!vocalProtected) missing.push(t('cover.prereqProtection'))
  if (!targetSong)     missing.push(t('cover.prereqTargetSong'))
  const prereqsMet = missing.length === 0
  const mergeDisabled = !prereqsMet || merging || pitchShiftBusy
  const mergeTooltip = !prereqsMet
    ? t('cover.mergeBlockedTooltip', { reasons: missing.join('、') })
    : pitchShiftBusy
      ? t('cover.mergeBlockedShifting')
      : undefined

  async function handleMerge(): Promise<void> {
    if (mergeDisabled || !vocalPath || !targetSong) return
    setMerging(true); setMergeError(null); setMergeRes(null)
    try {
      // Same resolution CoverView's handleSeparate uses: the pitch-shifted
      // cache when a shift is applied, the original download otherwise.
      const targetPath = targetSong.shiftedAudioPath ?? targetSong.audioPath
      const res = await window.engine.call('merge_train_audio', {
        vocal_path:        vocalPath,
        target_path:       targetPath,
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
        pitchShiftSemitones:  targetSong?.pitchShift ?? 0,
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
          disabled={mergeDisabled}
          title={mergeTooltip}
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
