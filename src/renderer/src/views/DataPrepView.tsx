import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WaveformEditor } from '../components/waveform/WaveformEditor'
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

        {/* ── §1: three-group toolbar ─────────────────────────────── */}
        <div className="dp-toolbar" role="toolbar" aria-label={t('dataPrep.title')}>
          <div className="dp-tool-group" aria-label={t('dataPrep.groupRecord')}>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              ⏺ {t('dataPrep.newRecord')}
            </button>
            <button
              className="btn btn-ghost dp-tool"
              onClick={() => controls?.play()}
              disabled={!hasFile || !controls || isPlaying}
              title={hasFile ? t('dataPrep.play') : pathHint}
            >
              ▶ {t('dataPrep.play')}
            </button>
            <button
              className="btn btn-ghost dp-tool"
              onClick={() => controls?.pause()}
              disabled={!hasFile || !controls || !isPlaying}
              title={hasFile ? t('dataPrep.pause') : pathHint}
            >
              ⏸ {t('dataPrep.pause')}
            </button>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              🔇 {t('dataPrep.muteSelection')}
            </button>
          </div>

          <span className="dp-tool-divider" aria-hidden="true" />

          <div className="dp-tool-group" aria-label={t('dataPrep.groupAnalyze')}>
            <button
              className="btn btn-ghost dp-tool"
              onClick={() => void handleAnalyze()}
              disabled={!filePath || analyzing}
              title={filePath ? t('dataPrep.analyzePitch') : pathHint}
            >
              {analyzing ? `⏳ ${t('dataPrep.analyzing')}` : `🎼 ${t('dataPrep.analyzePitch')}`}
            </button>
            <button
              className={`btn dp-tool pitch-protect-btn${justApplied ? ' applied' : ''}`}
              onClick={() => void handleApplyProtection()}
              disabled={!filePath || maxMidi == null || applying}
              title={!filePath ? pathHint : maxMidi == null ? t('dataPrep.needsAnalysis') : t('dataPrep.applyProtection')}
            >
              {applying
                ? <><span className="pitch-protect-spinner" aria-hidden="true" /> {t('dataPrep.applying')}</>
                : justApplied
                  ? `✓ ${t('dataPrep.applied')}`
                  : `🛡 ${t('dataPrep.applyProtection')}`}
            </button>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              ↩ {t('dataPrep.undo')}
            </button>
          </div>

          <span className="dp-tool-divider" aria-hidden="true" />

          <div className="dp-tool-group" aria-label={t('dataPrep.groupDenoise')}>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              🎚 {t('dataPrep.getNoiseSample')}
            </button>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              ✨ {t('dataPrep.denoise')}
            </button>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              📶 {t('dataPrep.loudnessNormalize')}
            </button>
            <button className="btn btn-ghost dp-tool" disabled title={soon}>
              💾 {t('dataPrep.saveChanges')}
            </button>
          </div>
        </div>

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
