import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WaveformEditor } from '../components/waveform/WaveformEditor'
import { ActionToolbar, type ToolbarAction } from '../components/toolbar/ActionToolbar'
import { useWaveformStore } from '../store/useWaveformStore'
import { useAppStore } from '../store/useAppStore'
import { midiToNoteName } from '../utils/pitch'

// PATCH-03: the workspace formerly titled 波形编辑, re-framed as the AI model
// training-data prep bench: 处理干音 → 设定保护 → 选目标歌 → 合并训练.
//
// Toolbar grouping and every label are fixed by the ticket. Controls whose
// backing call does not exist yet (recording, mute-selection, undo, the noise/
// denoise/loudness chain, and the cloud model-management actions) render
// disabled with a "该功能尚未开放" tooltip rather than as buttons that look
// live and do nothing — see the PR description for the full list.

// D#4, the fixed 高音保护 threshold (Ticket 17 / PATCH-02).
const PROTECTION_THRESHOLD_MIDI = 63

interface AnalyzePitchResponse {
  max_midi: number
  avg_midi: number
  contour:  number[]
  error?:   string
}
interface ProtectionResult {
  output_path:      string
  modified_regions: [number, number][]
  modified_ratio:   number
}
interface MergeResult {
  output_path:  string
  duration_sec: number
  sample_rate:  number
}
interface PackageResult {
  zip_path:   string
  size_bytes: number
}

type TrainPhase = 'idle' | 'packaging' | 'uploading' | 'training' | 'done' | 'error'

// One monotonic 0-100 bar across packaging → uploading → training, matching
// how <TrainingDatasetPanel> weights the same three phases.
function combinedPercent(phase: TrainPhase, subPercent: number): number {
  switch (phase) {
    case 'packaging': return Math.min(10, subPercent * 0.1)
    case 'uploading': return 10 + Math.min(100, subPercent) * 0.4
    case 'training':  return 50 + Math.min(100, subPercent) * 0.5
    case 'done':      return 100
    default:          return 0
  }
}

export function DataPrepView(): JSX.Element {
  const { t } = useTranslation()

  const fileName = useWaveformStore((s) => s.fileName)
  const filePath = useWaveformStore((s) => s.filePath)
  const controls = useWaveformStore((s) => s.controls)
  const isPlaying = useWaveformStore((s) => s.isPlaying)

  const targetSong      = useAppStore((s) => s.targetSong)
  const setEngineBusy   = useAppStore((s) => s.setEngineBusy)
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)

  // ── 分析音高 / 应用高音保护 ────────────────────────────────
  const [analyzing, setAnalyzing]   = useState(false)
  const [maxMidi, setMaxMidi]       = useState<number | null>(null)
  const [applying, setApplying]     = useState(false)
  const [justApplied, setJustApplied] = useState(false)
  const [protectedPath, setProtectedPath] = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)

  // ── 合并所有音频 / 上传并开始训练 ──────────────────────────
  const [merging, setMerging]   = useState(false)
  const [mergeRes, setMergeRes] = useState<MergeResult | null>(null)
  const [phase, setPhase]       = useState<TrainPhase>('idle')
  const [subPercent, setSubPercent]     = useState(0)
  const [statusMessage, setStatusMessage] = useState('')

  // Re-minted on every merge: a merge is what produces a dataset, so reusing
  // one id across two merges would upload the second under the first's task
  // and poll a status that doesn't describe it.
  const taskIdRef  = useRef<string>(crypto.randomUUID())
  const pollTimer  = useRef<ReturnType<typeof setInterval> | null>(null)
  const appliedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    if (appliedTimer.current) clearTimeout(appliedTimer.current)
  }, [])

  // A different clip invalidates everything derived from the previous one.
  useEffect(() => {
    setMaxMidi(null); setProtectedPath(null); setMergeRes(null); setError(null)
  }, [filePath])

  // ── §3: device info line ───────────────────────────────────
  // Real input-device name when the browser will name it (it only labels
  // devices after mic permission has been granted); the ticket's placeholder
  // otherwise, which is also what a fresh install shows.
  // Held as null-until-detected (rather than seeded with the translated
  // placeholder) so switching language re-renders the fallback too.
  const [detectedDevice, setDetectedDevice] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
      const input = devices.find((d) => d.kind === 'audioinput' && d.label)
      if (alive && input) setDetectedDevice(input.label)
    }).catch(() => { /* keep the placeholder */ })
    return () => { alive = false }
  }, [])
  const device = detectedDevice ?? t('dataPrep.deviceUnknown')

  // The vocal actually fed downstream: the protected copy once 应用高音保护
  // has run, the raw pick before that.
  const vocalPath = protectedPath ?? filePath

  const handleAnalyze = useCallback(async () => {
    if (!filePath || analyzing) return
    setAnalyzing(true); setError(null)
    try {
      const res = await window.engine.call('analyze_pitch', {
        audio_path: filePath, start_sec: null, end_sec: null,
      }) as AnalyzePitchResponse
      if (res.error) throw new Error(res.error)
      setMaxMidi(res.max_midi)
    } catch (err) {
      setError(String(err))
    } finally {
      setAnalyzing(false)
    }
  }, [filePath, analyzing])

  const handleApplyProtection = useCallback(async () => {
    if (!filePath || applying || maxMidi == null) return
    setApplying(true); setError(null)
    setEngineBusy(true); setEngineStatus(t('status.applyingHighPitchProtection'))
    try {
      const res = await window.engine.call('apply_high_pitch_protection', {
        audio_path: filePath, threshold_note: PROTECTION_THRESHOLD_MIDI,
      }) as ProtectionResult
      setProtectedPath(res.output_path)
      setMergeRes(null)   // a newly protected vocal invalidates any prior merge
      // §4: sticky so the toolbar keeps showing it after the engine goes idle
      // (PATCH-02 added statusSticky for exactly this).
      setEngineStatus(t('status.highPitchProtectionApplied'), true)
      setJustApplied(true)
      if (appliedTimer.current) clearTimeout(appliedTimer.current)
      appliedTimer.current = setTimeout(() => setJustApplied(false), 2_000)
    } catch (err) {
      setError(String(err))
      setEngineStatus(t('status.idle'))
    } finally {
      setApplying(false)
      setEngineBusy(false)
    }
  }, [filePath, applying, maxMidi, setEngineBusy, setEngineStatus, t])

  const handleMerge = useCallback(async () => {
    if (!vocalPath || !targetSong || merging) return
    setMerging(true); setError(null)
    taskIdRef.current = crypto.randomUUID()
    try {
      const res = await window.engine.call('merge_train_audio', {
        vocal_path:  vocalPath,
        target_path: targetSong.shiftedAudioPath ?? targetSong.audioPath,
        task_id:     taskIdRef.current,
        align_mode:  'pad',
      }) as MergeResult
      setMergeRes(res)
    } catch (err) {
      setError(String(err))
    } finally {
      setMerging(false)
    }
  }, [vocalPath, targetSong, merging])

  const handleUploadAndTrain = useCallback(async () => {
    if (!mergeRes) return
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
    setError(null); setPhase('packaging'); setSubPercent(0); setStatusMessage('')
    try {
      const pkg = await window.engine.call('package_train_dataset', {
        files: [{ path: mergeRes.output_path, name: 'merged_train.wav' }],
        task_id: taskIdRef.current,
      }) as PackageResult
      setSubPercent(100)

      setPhase('uploading'); setSubPercent(0)
      const taskId = taskIdRef.current
      const started = await window.engine.uploadTrainDataset(pkg.zip_path, taskId, {
        mode: 'standard',
        pitchShiftSemitones: targetSong?.pitchShift ?? 0,
        highPitchProtection: protectedPath != null,
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
            if (status.status === 'completed') { setPhase('done'); setSubPercent(100); resolve() }
            else reject(new Error(status.error ?? 'training failed'))
          }).catch((err) => {
            if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
            reject(err instanceof Error ? err : new Error(String(err)))
          })
        }, 1_500)
      })
    } catch (err) {
      setPhase('error'); setError(String(err))
    }
  }, [mergeRes, targetSong, protectedPath])

  // ── Derived enablement ─────────────────────────────────────
  const hasFile   = fileName !== null
  const uploading = phase === 'packaging' || phase === 'uploading' || phase === 'training'
  const pct       = combinedPercent(phase, subPercent)

  const soon = t('dataPrep.notAvailableYet')
  const pathHint = t('dataPrep.needsFilePath')

  // Row 3 status line: the ticket's fixed idle copy, replaced by live phase
  // text once training is under way.
  const trainStatus =
    phase === 'packaging' ? t('cover.phasePackaging')
    : phase === 'uploading' ? (statusMessage || t('cover.phaseUploading'))
    : phase === 'training'  ? (statusMessage || t('cover.phaseTraining'))
    : phase === 'done'      ? t('cover.phaseDone')
    : phase === 'error'     ? (error ?? t('dataPrep.waitingToTrain'))
    : t('dataPrep.waitingToTrain')

  // Ticket UI-06: the four high-frequency actions are promoted to the
  // always-visible core row; the rest ride in the overflow carousel. Play
  // and pause collapse into one core button — they're the same intent and
  // two mutually-exclusive pills would waste the scarce core slots.
  const toolbarActions: ToolbarAction[] = [
    {
      id: 'playPause',
      core: true,
      icon: isPlaying ? '⏸' : '▶',
      label: isPlaying ? t('dataPrep.pause') : t('dataPrep.play'),
      onClick: () => (isPlaying ? controls?.pause() : controls?.play()),
      disabled: !hasFile || !controls,
      title: hasFile ? undefined : pathHint,
    },
    {
      id: 'analyzePitch',
      core: true,
      icon: '🎼',
      label: t('dataPrep.analyzePitch'),
      loading: analyzing,
      loadingLabel: t('dataPrep.analyzing'),
      onClick: () => void handleAnalyze(),
      disabled: !filePath,
      title: filePath ? t('dataPrep.analyzePitch') : pathHint,
    },
    {
      id: 'applyProtection',
      core: true,
      icon: '🛡',
      label: justApplied ? t('dataPrep.applied') : t('dataPrep.applyProtection'),
      done: justApplied,
      loading: applying,
      loadingLabel: t('dataPrep.applying'),
      onClick: () => void handleApplyProtection(),
      disabled: !filePath || maxMidi == null,
      title: !filePath ? pathHint : maxMidi == null ? t('dataPrep.needsAnalysis') : t('dataPrep.applyProtection'),
    },
    // Named by the ticket as a core action, so it holds its slot even though
    // the backing call doesn't exist yet — it renders plainly disabled with
    // the "not available" reason rather than as an accent pill inviting a
    // click that would do nothing.
    { id: 'saveChanges', core: true, icon: '💾', label: t('dataPrep.saveChanges'), disabled: true, title: soon },

    { id: 'newRecord',     icon: '⏺', label: t('dataPrep.newRecord'),         disabled: true, title: soon },
    { id: 'muteSelection', icon: '🔇', label: t('dataPrep.muteSelection'),     disabled: true, title: soon },
    { id: 'undo',          icon: '↩', label: t('dataPrep.undo'),              disabled: true, title: soon },
    { id: 'noiseSample',   icon: '🎚', label: t('dataPrep.getNoiseSample'),    disabled: true, title: soon },
    { id: 'denoise',       icon: '✨', label: t('dataPrep.denoise'),           disabled: true, title: soon },
    { id: 'loudness',      icon: '📶', label: t('dataPrep.loudnessNormalize'), disabled: true, title: soon },
  ]

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('dataPrep.title')}</h1>
        <p className="view-desc">{t('dataPrep.description')}</p>
      </div>

      {/* ── §3: status strip — protection state, then device info ────── */}
      <div className="dp-statusbar">
        {protectedPath && (
          <div className="dp-status-protection">
            🛡 {t('status.highPitchProtectionApplied')}
          </div>
        )}
        <div className="dp-status-device">{t('dataPrep.device', { device })}</div>
      </div>

      <div className="card">
        <WaveformEditor showTransportButtons={false} />

        {/* ── §1: operations toolbar (Ticket UI-06) ───────────────
            Core actions stay visible as pills; everything else lives
            behind "更多操作" in a scrollable carousel. */}
        <ActionToolbar ariaLabel={t('dataPrep.title')} actions={toolbarActions} />

        {maxMidi != null && maxMidi > 0 && (
          <div className="dp-analysis-info">
            {t('dataPrep.analyzedMax', { note: midiToNoteName(maxMidi) })}
          </div>
        )}
        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {/* ── §2: cloud model training ─────────────────────────────── */}
      <div className="card dp-training">
        <div className="card-title">{t('dataPrep.cloudTraining')}</div>

        <div className="dp-train-row">
          <button className="btn btn-ghost dp-tool" disabled title={soon}>
            {t('dataPrep.refreshList')}
          </button>
          <button className="btn btn-ghost dp-tool" disabled title={soon}>
            {t('dataPrep.deleteFile')}
          </button>
          <div
            className="progress-track dp-train-progress"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="progress-fill" style={{ width: `${pct}%` }} />
            <span className="progress-pct">{Math.round(pct)}%</span>
          </div>
        </div>

        <div className="dp-train-row">
          <button
            className="btn btn-ghost dp-tool"
            onClick={() => void handleUploadAndTrain()}
            disabled={!mergeRes || uploading}
            title={mergeRes ? t('dataPrep.uploadAndTrain') : t('dataPrep.needsMerge')}
          >
            ☁️ {t('dataPrep.uploadAndTrain')}
          </button>
          <button className="btn btn-ghost dp-tool" disabled title={soon}>
            {t('dataPrep.checkModel')}
          </button>
          <button className="btn btn-ghost dp-tool" disabled title={soon}>
            {t('dataPrep.uploadModel')}
          </button>
          <button className="btn btn-ghost dp-tool" disabled title={soon}>
            {t('dataPrep.uploadSvcModel')}
          </button>
        </div>

        <div className="dp-train-status">{trainStatus}</div>

        <div className="dp-train-footer">
          <button
            className="btn btn-primary dp-merge-btn"
            onClick={() => void handleMerge()}
            disabled={!vocalPath || !targetSong || merging}
            title={
              !vocalPath ? pathHint
                : !targetSong ? t('dataPrep.needsTargetSong')
                  : t('dataPrep.mergeAllAudio')
            }
          >
            {merging
              ? <><span className="pitch-protect-spinner" aria-hidden="true" /> {t('cover.merging')}</>
              : `🔀 ${t('dataPrep.mergeAllAudio')}`}
          </button>
        </div>
      </div>
    </>
  )
}
