import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { notify } from '../store/useNotificationStore'
import { StepWizard } from '../components/cover/StepWizard'
import { StemPlayer, type StemTrack } from '../components/cover/StemPlayer'
import { MixingConsole, type MixTrack } from '../components/cover/MixingConsole'
import { ExportPanel } from '../components/cover/ExportPanel'
import { CloudLibraryModal } from '../components/library/CloudLibraryModal'
import type { LibrarySong } from '../global'

type SepMode  = 'standard' | 'enhanced'
type AlgoVer  = 'v1' | 'v2'

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
  const [libraryOpen, setLibraryOpen] = useState(false)

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

  // ── Step 2 state ─────────────────────────────────────────
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [algoVer,  setAlgoVer]   = useState<AlgoVer>('v2')

  // ── Step 3 state ─────────────────────────────────────────
  const [synthesizing, setSynthesizing] = useState(false)
  const [coverResult,  setCoverResult]  = useState<CoverResult | null>(null)
  const [synthError,   setSynthError]   = useState<string | null>(null)
  const renderMixRef = useRef<(() => Promise<Float32Array>) | null>(null)
  const onExportRequest = useCallback((fn: () => Promise<Float32Array>) => {
    renderMixRef.current = fn
  }, [])

  // ─────────────────────────────────────────────────────────
  // Step 1: upload + separate
  // ─────────────────────────────────────────────────────────
  async function handleSeparate(): Promise<void> {
    if (!songFile && !targetSong) { setSepError(t('cover.errUploadFirst')); return }
    setSepError(null); setSeparating(true)
    setEngineBusy(true); setEngineStatus(t('status.separating'))
    try {
      // A local upload and a 云曲库 selection are mutually exclusive (each
      // clears the other — see handleLibrarySelect and the file input's
      // onChange below), so at most one of these branches applies. The
      // library song's audio is already a local, cached file — see
      // main/library.ts's fetchLibraryAudio — so it needs no upload step.
      const inputPath = songFile
        ? `${await window.engine.saveTrainingFiles([{ name: songFile.name, buffer: await songFile.arrayBuffer() }])}/${songFile.name}`
        : targetSong!.audioPath
      const res = await window.engine.call('separate', {
        mode:       sepMode,
        input_path: inputPath,
      }) as SeparationResult

      setSepResult(res)
      complete(1, 2)
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
      setSeparating(false); setEngineBusy(false); setEngineStatus(t('status.idle'))
    }
  }

  // ─────────────────────────────────────────────────────────
  // Cloud Library (云曲库) selection — Ticket 18
  // ─────────────────────────────────────────────────────────
  function handleLibrarySelect(song: LibrarySong, audioPath: string): void {
    setSongFile(null)   // mutually exclusive with a local upload — see handleSeparate
    setTargetSong({
      id:          song.id,
      title:       song.title,
      artist:      song.artist,
      originalKey: song.original_key,
      audioPath,
    })
    setLibraryOpen(false)
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

      <StepWizard current={step} completed={completed} onNavigate={setStep} />

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

          <button className="btn btn-primary" style={{ width: '100%', marginTop: 4 }}
            onClick={handleSeparate} disabled={separating || !songFile}>
            {separating ? `⏳ ${t('cover.separating')}` : `🔊 ${t('cover.startSeparation')}`}
          </button>

          {sepResult && (
            <div style={{ marginTop: 20 }}>
              <div className="card-title">{t('cover.stems')}</div>
              <StemPlayer stems={stemTracks} />
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
