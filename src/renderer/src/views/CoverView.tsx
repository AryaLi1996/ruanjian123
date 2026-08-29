import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { notify } from '../store/useNotificationStore'
import { StepWizard } from '../components/cover/StepWizard'
import { StemPlayer, type StemTrack } from '../components/cover/StemPlayer'
import { MixingConsole, type MixTrack } from '../components/cover/MixingConsole'
import { ExportPanel } from '../components/cover/ExportPanel'
import { TrainingDatasetPanel } from '../components/cover/TrainingDatasetPanel'
import { PitchShiftSlider } from '../components/cover/PitchShiftSlider'
import { PitchAnalysisPanel } from '../components/cover/PitchAnalysisPanel'
import { HighPitchProtection } from '../components/cover/HighPitchProtection'
import { CloudLibraryModal } from '../components/library/CloudLibraryModal'
import { usePitchStore } from '../store/usePitchStore'
import { computeRecommendedShift } from '../utils/pitch'
import type { LibrarySong } from '../global'

type SepMode  = 'standard' | 'enhanced'
type AlgoVer  = 'v1' | 'v2'

/** FC-05: keep the log console's DOM small on a long enhanced-mode run. */
const SEP_LOG_MAX_LINES = 200

/** Step number → i18n key, for naming an unmet prerequisite (FC-03). */
const STEP_LABEL_KEYS: Record<number, string> = {
  1: 'cover.stepUpload',
  2: 'cover.stepModel',
  3: 'cover.stepMix',
  4: 'cover.stepExport',
  5: 'cover.stepTrainingData',
}

interface SeparationResult {
  mode: string; stems: Record<string, string>; elapsed_sec: number; duration_sec: number
}
interface CoverResult {
  output_path: string; ai_vocal_path: string; mode: string; duration_sec: number; elapsed_sec: number
}

export function CoverView(): JSX.Element {
  const { t } = useTranslation()
  const trainedModels = useAppStore((s) => s.trainedModels)
  const setEngineBusy  = useAppStore((s) => s.setEngineBusy)
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)
  // Ticket 18: the 云曲库-selected song, if any — see useAppStore's TargetSong.
  const targetSong    = useAppStore((s) => s.targetSong)
  const setTargetSong = useAppStore((s) => s.setTargetSong)
  // FC-02: standard project folder built from the last separation — what the
  // training step (step ⑤) validates against.
  const trainingAssets    = useAppStore((s) => s.trainingAssets)
  const setTrainingAssets = useAppStore((s) => s.setTrainingAssets)
  // Ticket UI-02: lifted to the store so the sidebar's 云曲库 entry opens
  // this same modal instead of a second copy of it. The modal element and
  // the selection handler still live here — picking a song has to clear this
  // page's local upload alongside setting the target song.
  const libraryOpen    = useAppStore((s) => s.libraryOpen)
  const setLibraryOpen = useAppStore((s) => s.setLibraryOpen)

  // ── Pitch Shift / Tune slider (Ticket 19) ────────────────
  // The user's vocal range comes from Ticket 16's pitch analysis panel
  // (usePitchStore, populated when the user runs "分析音高" below on the
  // separated lead vocal stem). maxMidi === 0 is that panel's "nothing
  // voiced detected" sentinel (see engine/pitch_analysis.py), not a real
  // note — treated the same as "not analyzed yet": no recommendation shown.
  const vocalRangeMaxMidi  = usePitchStore((s) => (s.result && s.result.maxMidi > 0 ? s.result.maxMidi : null))
  const setTargetSongShift = useAppStore((s) => s.setTargetSongShift)
  const [shifting,   setShifting]   = useState(false)
  const [shiftError, setShiftError] = useState<string | null>(null)
  const recommendedShift = targetSong
    ? computeRecommendedShift(targetSong.originalKey, vocalRangeMaxMidi)
    : null
  // Guards against a fast re-drag: if the user commits a second shift before
  // the first's engine call returns, only the response matching the latest
  // request may write into the store — otherwise an in-flight response for
  // an already-abandoned value could land after (and overwrite) it.
  const shiftRequestRef = useRef(0)

  // FC-02: names this session's project folder under userData/projects.
  const projectIdRef = useRef(`project_${Date.now()}`)

  // ── Wizard state ─────────────────────────────────────────
  const [step,      setStep]      = useState(1)
  const [completed, setCompleted] = useState(new Set<number>())

  function complete(n: number, next: number): void {
    setCompleted((s) => new Set([...s, n]))
    setStep(next)
  }

  // ── Step 1 state ─────────────────────────────────────────
  const [songFile,  setSongFile]  = useState<File | null>(null)
  const [sepMode,   setSepMode]   = useState<SepMode>('enhanced')
  const [separating, setSeparating] = useState(false)
  const [sepResult, setSepResult] = useState<SeparationResult | null>(null)
  const [sepError,  setSepError]  = useState<string | null>(null)
  // FC-05: real feedback while separation runs. `sepPercent` comes from the
  // engine's own per-chunk progress lines (engine/separation.py), `sepStage`
  // names what it's doing, and `sepLog` keeps the raw lines for the
  // collapsible console so a stuck run can actually be diagnosed.
  const [sepPercent, setSepPercent] = useState(0)
  const [sepStage,   setSepStage]   = useState<string>('')
  const [sepLog,     setSepLog]     = useState<string[]>([])
  const [sepJustDone, setSepJustDone] = useState(false)
  // FC-01: "正在下载歌曲资源…" while a cache-missing cloud song is re-fetched
  // before separation can start.
  const [preparing, setPreparing] = useState(false)

  // Engine progress lines arrive on a shared channel; only subscribe while
  // this page's own separation is running, and ignore anything that isn't a
  // separation update (training emits on the same channel).
  useEffect(() => {
    if (!separating) return
    const unsub = window.engine.onProgress((raw) => {
      const data = raw as { type?: string; percent?: number; stage?: string }
      if (data?.type !== 'separation_progress') return
      if (typeof data.percent === 'number') setSepPercent(data.percent)
      if (data.stage) setSepStage(data.stage)
      setSepLog((prev) => {
        const next = [...prev, JSON.stringify(data)]
        return next.length > SEP_LOG_MAX_LINES ? next.slice(-SEP_LOG_MAX_LINES) : next
      })
    })
    return unsub
  }, [separating])

  // ── Step 2 state ─────────────────────────────────────────
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [algoVer,  setAlgoVer]   = useState<AlgoVer>('v2')

  // ── Step 3 state ─────────────────────────────────────────
  const [synthesizing, setSynthesizing] = useState(false)
  const [coverResult,  setCoverResult]  = useState<CoverResult | null>(null)
  const [synthError,   setSynthError]   = useState<string | null>(null)
  // Ticket 20 gates on Ticket 17 having actually run (not just that a vocal
  // exists) — see <HighPitchProtection>'s onApplied below, and
  // TrainingDatasetPanel's prereqProtection.
  const [vocalProtected, setVocalProtected] = useState(false)
  const renderMixRef = useRef<(() => Promise<Float32Array>) | null>(null)
  const onExportRequest = useCallback((fn: () => Promise<Float32Array>) => {
    renderMixRef.current = fn
  }, [])

  // ─────────────────────────────────────────────────────────
  // Step 1: upload + separate
  // ─────────────────────────────────────────────────────────
  async function handleSeparate(): Promise<void> {
    if (!songFile && !targetSong) { setSepError(t('cover.errUploadFirst')); return }
    setSepError(null); setSepLog([]); setSepPercent(0); setSepStage(''); setSepJustDone(false)
    setSeparating(true)
    setEngineBusy(true); setEngineStatus(t('status.separating'))
    try {
      // A local upload and a 云曲库 selection are mutually exclusive (each
      // clears the other — see handleLibrarySelect and the file input's
      // onChange below), so at most one of these branches applies.
      // Ticket 19: a pitch-shifted target song uses its cached shifted audio
      // (shiftedAudioPath) as the training target instead of the original
      // download — null at shift 0, where there's nothing to shift.
      let originalPath: string
      if (songFile) {
        const dir = await window.engine.saveTrainingFiles([
          { name: songFile.name, buffer: await songFile.arrayBuffer() },
        ])
        originalPath = `${dir}/${songFile.name}`
      } else {
        originalPath = await ensureTargetSongAudio()
      }
      const inputPath = songFile ? originalPath : (targetSong!.shiftedAudioPath ?? originalPath)

      // FC-05: streamed rather than a plain call so the engine's per-chunk
      // progress lines reach the progress bar and the log console. The
      // result is the same either way — see main/python-bridge.ts.
      const res = await window.engine.stream('separate', {
        mode:       sepMode,
        input_path: inputPath,
      }) as SeparationResult

      setSepResult(res)
      setSepPercent(100)
      setSepJustDone(true)
      await collectAssets(res, originalPath)
      // Marks step ① done (unlocking ②) without navigating away from it:
      // the stems, the pitch-analysis panel and FC-05's "分离完成！" all live
      // on this step and were previously replaced the instant separation
      // finished. The step's own "下一步：选择模型 →" button is what moves on.
      setCompleted((prev) => new Set([...prev, 1]))
      notify({
        category: 'taskCompletion',
        titleKey: 'notification.separation.complete.title',
        messageKey: 'notification.separation.complete.message',
        messageParams: { mode: t(`cover.${sepMode}`) },
        action: { type: 'view', view: 'cover' },
      })
    } catch (err) {
      setSepError(String(err))
      notify({
        category: 'taskFailure',
        titleKey: 'notification.separation.failed.title',
        messageKey: 'notification.separation.failed.message',
        messageParams: { message: String(err) },
        action: { type: 'view', view: 'cover' },
      })
    } finally {
      setSeparating(false); setPreparing(false)
      setEngineBusy(false); setEngineStatus(t('status.idle'))
    }
  }

  /**
   * FC-01: guarantees the selected 云曲库 song has a local file to separate.
   *
   * The download happens at selection time, but the cache lives on disk and
   * can be gone by the time the user actually hits 分离 (cache cleared, a
   * temp sweep, a profile moved between machines). fetchLibraryAudio returns
   * the cached copy when it's there and re-downloads when it isn't, so
   * calling it again here costs nothing in the common case and turns the
   * "file not found" failure into a transparent re-fetch.
   */
  async function ensureTargetSongAudio(): Promise<string> {
    const song = targetSong!
    setPreparing(true)
    try {
      const { path } = await window.engine.fetchLibraryAudio({
        id:           song.id,
        title:        song.title,
        artist:       song.artist,
        original_key: song.originalKey,
        audio_url:    song.audioUrl,
        cover_url:    song.coverUrl,
      })
      // The re-downloaded file can land under a different extension than the
      // original pick did (a server that changed content-type), so keep the
      // store pointing at what actually exists.
      if (path !== song.audioPath) setTargetSong({ ...song, audioPath: path })
      return path
    } finally {
      setPreparing(false)
    }
  }

  /**
   * FC-02: copies the finished separation's stems into the standard project
   * folder the training step reads from. Best-effort: a failure here leaves
   * the stems playable and the wizard usable, and shows up as "数据未就绪"
   * on the training step rather than as a failed separation.
   */
  async function collectAssets(res: SeparationResult, originalPath: string): Promise<void> {
    try {
      const collected = await window.engine.collectProjectStems(
        projectIdRef.current, sepMode, res.stems, originalPath,
      )
      setTrainingAssets({ ...collected, mode: sepMode })
    } catch (err) {
      setTrainingAssets(null)
      setSepLog((prev) => [...prev, `collect assets failed: ${String(err)}`])
    }
  }

  /**
   * FC-03: a locked step explains itself instead of silently doing nothing.
   * `unmet` is every prerequisite step still outstanding; the first one is
   * what the user should do next, so it leads the message.
   */
  function handleStepBlocked(_stepNumber: number, unmet: number[]): void {
    const names = unmet.map((n) => t(STEP_LABEL_KEYS[n] ?? '')).filter(Boolean).join('、')
    notify({
      category: 'system',
      icon:     '🔒',
      titleKey: 'cover.stepLockedTitle',
      messageKey: 'cover.stepLockedMessage',
      messageParams: { first: unmet[0], steps: names },
    })
  }

  // ─────────────────────────────────────────────────────────
  // Cloud Library (云曲库) selection — Ticket 18
  // ─────────────────────────────────────────────────────────
  function handleLibrarySelect(song: LibrarySong, audioPath: string): void {
    setSongFile(null)   // mutually exclusive with a local upload — see handleSeparate
    setShiftError(null)
    setTrainingAssets(null)   // a new song invalidates the last separation's assets
    setTargetSong({
      id:               song.id,
      title:            song.title,
      artist:           song.artist,
      originalKey:      song.original_key,
      audioPath,
      audioUrl:         song.audio_url,
      coverUrl:         song.cover_url,
      pitchShift:       0,
      shiftedAudioPath: null,
    })
    setLibraryOpen(false)
  }

  // ─────────────────────────────────────────────────────────
  // Pitch Shift / Tune slider (Ticket 19)
  // ─────────────────────────────────────────────────────────
  async function handlePitchShiftChange(nextShift: number): Promise<void> {
    if (!targetSong || nextShift === targetSong.pitchShift) return
    setShiftError(null)
    const requestId = ++shiftRequestRef.current

    if (nextShift === 0) {
      setTargetSongShift(0, null)
      setShifting(false)   // supersedes any shift still in flight — see requestId above
      return
    }

    setShifting(true)
    try {
      const res = await window.engine.call('pitch_shift', {
        input_path: targetSong.audioPath,
        semitones:  nextShift,
        cache_key:  targetSong.id,
      }) as { output_path: string }
      if (shiftRequestRef.current === requestId) setTargetSongShift(nextShift, res.output_path)
    } catch (err) {
      if (shiftRequestRef.current === requestId) setShiftError(String(err))
    } finally {
      if (shiftRequestRef.current === requestId) setShifting(false)
    }
  }

  // ─────────────────────────────────────────────────────────
  // Step 3: synthesize cover
  // ─────────────────────────────────────────────────────────
  async function handleSynthesize(): Promise<void> {
    const model = trainedModels.find((m) => m.id === selectedModelId)
    if (!model)     { setSynthError(t('cover.errSelectModel')); return }
    if (!sepResult) { setSynthError(t('cover.errRunSeparation'));  return }

    setSynthError(null); setSynthesizing(true)
    setEngineBusy(true); setEngineStatus(t('status.synthesizing', { mode: algoVer }))
    try {
      const stems = sepResult.stems
      const refVocal = stems['lead_dry'] ?? stems['vocals'] ?? Object.values(stems)[0]
      const acc      = stems['accompaniment']

      const res = await window.engine.call('synthesize_cover', {
        mode:          algoVer,
        ai_model:      model.onnxPath,
        ref_vocal:     refVocal,
        accompaniment: acc,
      }) as CoverResult

      // Ticket 45: don't auto-advance to the export step here. Doing so used
      // to skip straight from "synthesizing" to step 4 in the same update
      // that set coverResult, so the mixer (step 3's `coverResult && (...)`
      // branch, which mounts <MixingConsole> and is the only place that
      // calls onExportRequest to register the render function) never got a
      // chance to mount. renderMixRef.current stayed null forever, so the
      // export button stayed disabled and "请先完成合成与混音步骤" showed no
      // matter how complete synthesis actually was. Stay on step 3 so the
      // mixer renders; the user (or the mixer's own "proceed" button) is
      // what should trigger the move to step 4, once mixing is registered.
      setCoverResult(res)
      setVocalProtected(false)   // fresh AI vocal — Ticket 17 hasn't run on it yet
      setCompleted((s) => new Set([...s, 3]))
      notify({
        category: 'taskCompletion',
        titleKey: 'notification.synthesis.complete.title',
        messageKey: 'notification.synthesis.complete.message',
        messageParams: { mode: algoVer.toUpperCase() },
        action: { type: 'view', view: 'cover' },
      })
    } catch (err) {
      setSynthError(String(err))
      notify({
        category: 'taskFailure',
        titleKey: 'notification.synthesis.failed.title',
        messageKey: 'notification.synthesis.failed.message',
        messageParams: { message: String(err) },
        action: { type: 'view', view: 'cover' },
      })
    } finally {
      setSynthesizing(false); setEngineBusy(false); setEngineStatus(t('status.idle'))
    }
  }

  // FC-05: the green "分离完成！" confirmation is a moment, not a state — it
  // steps back to 重新分离 so the button stays actionable.
  useEffect(() => {
    if (!sepJustDone) return
    const timer = setTimeout(() => setSepJustDone(false), 2_000)
    return () => clearTimeout(timer)
  }, [sepJustDone])

  // ─────────────────────────────────────────────────────────
  // Derived data for sub-components
  // ─────────────────────────────────────────────────────────
  const stemTracks: StemTrack[] = sepResult
    ? Object.entries(sepResult.stems).map(([key, path]) => ({
        key,
        label: {
          vocals: t('cover.labelVocals'), accompaniment: t('cover.labelAccompaniment'),
          lead_dry: t('cover.labelLeadDry'), harmony_dry: t('cover.labelHarmonyDry'),
        }[key] ?? key,
        path,
      }))
    : []

  const mixTracks: MixTrack[] = coverResult
    ? [
        { key: 'ai_vocal',     label: t('cover.labelAiVocal'),     path: coverResult.ai_vocal_path, color: '#6366f1' },
        { key: 'harmony',      label: t('cover.labelOrigHarmony'), path: sepResult?.stems['harmony_dry'] ?? sepResult?.stems['vocals'] ?? '', color: '#22c55e' },
        { key: 'accompaniment', label: t('cover.labelAccomp'),      path: sepResult?.stems['accompaniment'] ?? '', color: '#f59e0b' },
      ].filter((t) => t.path)
    : []

  const selectedModel = trainedModels.find((m) => m.id === selectedModelId)

  // FC-05: idle → downloading → separating(%) → done → re-run, so the button
  // always says what the app is doing.
  const busy = separating || preparing
  const separateButtonLabel = preparing
    ? `⏳ ${t('cover.preparingSource')}`
    : separating
      ? `⏳ ${t('cover.separatingPercent', { percent: Math.round(sepPercent) })}`
      : sepJustDone
        ? `✅ ${t('cover.separationDone')}`
        : sepResult
          ? `🔊 ${t('cover.reSeparate')}`
          : `🔊 ${t('cover.startSeparation')}`

  // Ticket 16: prefer the driest lead vocal available for pitch analysis —
  // same fallback chain used to pick the reference vocal for synthesis.
  // Label mirrors whichever key the path actually came from (not just the
  // first two candidates) so the panel never claims to be analyzing
  // "Vocals" when it fell back to some other stem.
  const pitchStemKey = sepResult
    ? (['lead_dry', 'vocals'].find((k) => sepResult.stems[k]) ?? Object.keys(sepResult.stems)[0])
    : null
  const pitchStemPath  = pitchStemKey && sepResult ? sepResult.stems[pitchStemKey] : null
  const pitchStemLabel = pitchStemKey
    ? stemTracks.find((s) => s.key === pitchStemKey)?.label ?? pitchStemKey
    : ''

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('cover.title')}</h1>
        <p className="view-desc">{t('cover.description')}</p>
      </div>

      {/* Ticket 18: the 云曲库-selected target song, shown prominently in the
          main workspace and persisted (via useAppStore) until changed. */}
      {targetSong && (
        <div className="target-song-banner">
          <span className="target-song-banner-text">
            🎯 {t('cover.targetSongLabel', { title: targetSong.title, artist: targetSong.artist || t('cover.unknownArtist') })}
          </span>
          <button className="btn btn-ghost pbm-mini-btn" onClick={() => setTargetSong(null)}>
            {t('cover.clearTargetSong')}
          </button>
        </div>
      )}

      <StepWizard
        current={step}
        completed={completed}
        onNavigate={setStep}
        onBlocked={handleStepBlocked}
      />

      {/* ── Step 1 ────────────────────────────────────────── */}
      {step === 1 && (
        <div className="card">
          <div className="card-title">① {t('cover.upload')}</div>

          <div className="field">
            <label>{t('cover.song')}</label>
            <div className="row" style={{ gap: 8 }}>
              <div className="song-drop" style={{ flex: 1 }} onClick={() => document.getElementById('song-input')?.click()}>
                <input
                  id="song-input" type="file" accept="audio/*" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) { setSongFile(f); setTargetSong(null) }   // local upload wins over any 云曲库 selection
                  }}
                />
                {songFile
                  ? <span style={{ color: 'var(--text)' }}>🎵 {songFile.name}</span>
                  : targetSong
                    ? <span style={{ color: 'var(--text)' }}>☁️ {targetSong.title} - {targetSong.artist}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>{t('cover.chooseSong')}</span>}
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setLibraryOpen(true)}>
                {t('cover.openLibrary')}
              </button>
            </div>
          </div>

          {/* Ticket 19: only meaningful for a 云曲库 song — a local upload has
              no catalog `original_key` to shift against and is meant to be
              used as-is. */}
          {targetSong && (
            <div className="field">
              <PitchShiftSlider
                value={targetSong.pitchShift}
                recommended={recommendedShift}
                busy={shifting}
                onChange={(v) => void handlePitchShiftChange(v)}
              />
              {shiftError && <div className="error-banner">{shiftError}</div>}
            </div>
          )}

          <div className="field">
            <label>{t('cover.separationMode')}</label>
            <div className="mode-grid">
              {(['standard', 'enhanced'] as const).map((m) => (
                <button key={m} className={`mode-card${sepMode === m ? ' selected' : ''}`}
                  onClick={() => setSepMode(m)}>
                  <div className="mode-card-header">
                    <span className="mode-card-name">{t(`cover.${m}`)}</span>
                    {sepMode === m && <span className="mode-card-check">✓</span>}
                  </div>
                  <div className="mode-card-tagline">
                    {t(`cover.${m}Stems`)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {sepError && <div className="error-banner">{sepError}</div>}

          {/* FC-01: the button used to require a local upload, which left a
              云曲库 song selected and the only way to separate it disabled —
              the "云曲库无法分离" report. Either source is a valid input. */}
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 4 }}
            onClick={handleSeparate}
            disabled={busy || (!songFile && !targetSong)}
            title={!songFile && !targetSong ? t('cover.errUploadFirst') : undefined}>
            {separateButtonLabel}
          </button>

          {/* FC-05: an actual percentage while the engine works, so a long
              separation is visibly running rather than apparently ignored. */}
          {busy && (
            <div className="progress-track" style={{ marginTop: 10 }}
                 role="progressbar" aria-valuenow={Math.round(sepPercent)} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-fill" style={{ width: `${preparing ? 0 : sepPercent}%` }} />
              <span className="progress-pct">{preparing ? '…' : `${Math.round(sepPercent)}%`}</span>
            </div>
          )}
          {separating && sepStage && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              {t(`cover.sepStage.${sepStage}`, { defaultValue: sepStage })}
            </div>
          )}

          {sepLog.length > 0 && (
            <details className="sep-log-console">
              <summary>{t('cover.sepLogTitle', { count: sepLog.length })}</summary>
              <pre className="sep-log-lines">{sepLog.join('\n')}</pre>
            </details>
          )}

          {sepResult && (
            <div style={{ marginTop: 20 }}>
              <div className="card-title">{t('cover.stems')}</div>
              <StemPlayer stems={stemTracks} />
              {pitchStemPath && (
                <div style={{ marginTop: 16 }}>
                  <PitchAnalysisPanel audioPath={pitchStemPath} label={pitchStemLabel} />
                </div>
              )}
              <button className="btn btn-primary" style={{ marginTop: 16 }}
                onClick={() => complete(1, 2)}>
                {t('cover.nextModel')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2 ────────────────────────────────────────── */}
      {step === 2 && (
        <div className="card">
          <div className="card-title">② {t('cover.selectModel')}</div>

          {trainedModels.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {t('cover.noModels')}
            </p>
          ) : (
            <div className="model-grid" style={{ marginBottom: 16 }}>
              {trainedModels.map((m) => (
                <button key={m.id}
                  className={`model-card${selectedModelId === m.id ? ' selected-model' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer', border: selectedModelId === m.id ? '2px solid var(--accent)' : undefined }}
                  onClick={() => setSelectedModelId(m.id)}>
                  <div className="model-card-cover">
                    {m.coverDataUrl ? <img src={m.coverDataUrl} alt={m.name} /> : <span className="model-card-cover-placeholder">🎤</span>}
                  </div>
                  <div className="model-card-body">
                    <div className="model-card-name">{m.name}</div>
                    <div className="model-card-meta">
                      <span className={`badge badge-mode-${m.mode}`}>{m.mode === 'standard' ? 'Std' : 'Pro'}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="field">
            <label>{t('cover.algorithm')}</label>
            <div className="mode-grid">
              {(['v1', 'v2'] as const).map((v) => (
                <button key={v} className={`mode-card${algoVer === v ? ' selected' : ''}`}
                  onClick={() => setAlgoVer(v)}>
                  <div className="mode-card-header">
                    <span className="mode-card-name">{t(v === 'v1' ? 'cover.v1' : 'cover.v2')}</span>
                    {algoVer === v && <span className="mode-card-check">✓</span>}
                  </div>
                  <div className="mode-card-tagline">
                    {t(v === 'v1' ? 'cover.v1Tagline' : 'cover.v2Tagline')}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <button className="btn btn-primary" style={{ marginTop: 8 }}
            onClick={() => complete(2, 3)}
            disabled={!selectedModelId}>
            {t('cover.nextSynthesize')}
          </button>
        </div>
      )}

      {/* ── Step 3 ────────────────────────────────────────── */}
      {step === 3 && (
        <div className="card">
          <div className="card-title">③ {t('cover.mix')}</div>

          {!coverResult && (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                {t('cover.mixInfo', { model: selectedModel?.name ?? '—', algo: algoVer.toUpperCase() })}
              </p>
              {synthError && <div className="error-banner">{synthError}</div>}
              <button className="btn btn-primary" style={{ width: '100%' }}
                onClick={handleSynthesize} disabled={synthesizing}>
                {synthesizing ? `⏳ ${t('cover.synthesizing')}` : `🎤 ${t('cover.synthesize')}`}
              </button>
            </>
          )}

          {coverResult && (
            <>
              <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 16 }}>
                {t('cover.synthesizedInfo', { elapsed: coverResult.elapsed_sec, duration: coverResult.duration_sec })}
              </div>

              {/* Ticket 17: 强制修音 — clamp any AI-vocal pitch above D#4
                  before mixing, so the mixer/export downstream always work
                  from the protected stem once applied.
                  Ticket 22: also re-analyzes the protected vocal and, when a
                  云曲库 song is selected, auto-applies the recommended Tune
                  shift (see handlePitchShiftChange) — same engine call and
                  caching the slider itself uses, so the user can still drag
                  it to override afterward. */}
              <HighPitchProtection
                audioPath={coverResult.ai_vocal_path}
                onApplied={(path) => {
                  setCoverResult((prev) => (prev ? { ...prev, ai_vocal_path: path } : prev))
                  setVocalProtected(true)
                }}
                originalKey={targetSong?.originalKey}
                onRecommendedShift={(shift) => void handlePitchShiftChange(shift)}
              />

              <div className="card-title" style={{ marginBottom: 12 }}>{t('cover.mixer')}</div>
              {mixTracks.length > 0 && (
                <MixingConsole
                  tracks={mixTracks}
                  onExportRequest={onExportRequest}
                />
              )}
              {/* Guard against the (rare) case where there's nothing to mix:
                  <MixingConsole> only mounts — and only then registers the
                  render function export needs — when mixTracks is non-empty.
                  Without this guard the button below would still let the
                  user "proceed" into a step 4 that can never export. */}
              <button className="btn btn-primary" style={{ marginTop: 16 }}
                onClick={() => complete(3, 4)} disabled={mixTracks.length === 0}>
                {t('cover.export')}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Step 4 ────────────────────────────────────────── */}
      {step === 4 && (
        <div className="card">
          <div className="card-title">④ {t('cover.exportTitle')}</div>
          <ExportPanel
            renderMix={renderMixRef.current}
            sampleRate={44_100}
          />
          {/* FC-04: every step ends with the way forward, so the next step is
              something the user is led to rather than something they have to
              go looking for. Exporting is optional for training (see
              utils/wizardSteps.ts), so this doesn't require one first. */}
          <button className="btn btn-ghost" style={{ marginTop: 16 }}
            onClick={() => complete(4, 5)}>
            {t('cover.nextTrainingData')}
          </button>
        </div>
      )}

      {/* ── Step 5 (Ticket 20) ───────────────────────────────
          Reachable once synthesis (step 3) has produced an AI vocal —
          independent of whether the user has exported a mixdown (step 4),
          since building a training dataset doesn't need one. */}
      {step === 5 && (
        <div className="card">
          <div className="card-title">⑤ {t('cover.trainingDataTitle')}</div>
          <TrainingDatasetPanel
            trainingAssets={trainingAssets}
            vocalPath={coverResult?.ai_vocal_path ?? null}
            vocalProtected={vocalProtected}
            dryVocalPath={sepResult?.stems['lead_dry'] ?? null}
            targetSong={targetSong}
            pitchShiftBusy={shifting}
            onMerged={() => setCompleted((s) => new Set([...s, 5]))}
          />
        </div>
      )}

      {libraryOpen && (
        <CloudLibraryModal
          onClose={() => setLibraryOpen(false)}
          onSelect={handleLibrarySelect}
        />
      )}
    </>
  )
}
