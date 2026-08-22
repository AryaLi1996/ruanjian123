import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { computePeaks, drawWaveform, drawPitchContour } from '../../utils/waveform'
import { usePitchStore } from '../../store/usePitchStore'
import { useAppStore } from '../../store/useAppStore'
import { notify } from '../../store/useNotificationStore'
import {
  PROTECTION_THRESHOLD_MIDI, computePitchAxis, midiToYFraction, midiToNoteName,
} from '../../utils/pitch'
import { PitchResultDisplay } from './PitchResultDisplay'

const PEAK_BUCKETS  = 1200
const CANVAS_HEIGHT = 84
// A drag shorter than this (in seconds) is treated as a click, not a
// selection — clears any region rather than creating a near-zero-length one.
const MIN_DRAG_SEC = 0.15
// PATCH-02 §2: how long the button holds its green ✓ before returning to
// its normal "apply" state.
const APPLIED_FLASH_MS = 2000

interface AnalyzePitchResponse {
  max_midi: number
  avg_midi: number
  contour:  number[]
  error?:   string
}

interface HighPitchProtectionResponse {
  output_path:      string
  modified_regions: [number, number][]
  modified_ratio:   number
  threshold_note:   number
  error?:           string
}

interface Props {
  /** Absolute path to the audio (typically the separated vocal stem) to analyze. */
  audioPath: string
  /** Localized label shown in the panel header, e.g. "人声". */
  label:     string
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Ticket 16: waveform + region selection for the "分析音高" (Analyze Pitch) feature. */
export function PitchAnalysisPanel({ audioPath, label }: Props): JSX.Element {
  const { t } = useTranslation()

  const regionStart  = usePitchStore((s) => s.regionStart)
  const regionEnd     = usePitchStore((s) => s.regionEnd)
  const setRegion     = usePitchStore((s) => s.setRegion)
  const clearRegion   = usePitchStore((s) => s.clearRegion)
  const analyzing     = usePitchStore((s) => s.analyzing)
  const setAnalyzing  = usePitchStore((s) => s.setAnalyzing)
  const result        = usePitchStore((s) => s.result)
  const setResult     = usePitchStore((s) => s.setResult)
  const error         = usePitchStore((s) => s.error)
  const setError      = usePitchStore((s) => s.setError)
  const reset         = usePitchStore((s) => s.reset)

  const setEngineStatus = useAppStore((s) => s.setEngineStatus)
  const setEngineBusy    = useAppStore((s) => s.setEngineBusy)

  const [duration, setDuration]     = useState(0)
  const [peaks, setPeaks]           = useState<Float32Array | null>(null)
  const [loadingWave, setLoadingWave] = useState(true)
  const [dragPreview, setDragPreview] = useState<[number, number] | null>(null)
  const [width, setWidth]           = useState(600)

  // PATCH-02: 强制修音 state, local to this panel — the protection outcome is
  // only ever rendered here (as the red overlays below), unlike the analysis
  // result, which CoverView also reads off usePitchStore.
  const [protecting,   setProtecting]   = useState(false)
  const [protectResult, setProtectResult] = useState<HighPitchProtectionResponse | null>(null)
  const [protectError, setProtectError] = useState<string | null>(null)
  const [justApplied,  setJustApplied]  = useState(false)

  const canvasRef    = useRef<HTMLCanvasElement | null>(null)
  const wrapRef       = useRef<HTMLDivElement | null>(null)
  const dragStartRef  = useRef<number | null>(null)
  const flashTimerRef = useRef<number | null>(null)

  // A new file to analyze (e.g. switching stems) starts from a clean slate —
  // including any protection already applied to the *previous* file, whose
  // red overlays would otherwise sit over the new one's waveform.
  useEffect(() => {
    reset()
    setProtectResult(null)
    setProtectError(null)
    setJustApplied(false)
  }, [audioPath, reset])

  // The ✓ flash timer outlives a fast unmount (switching steps mid-flash)
  // unless it's cleared — setJustApplied would then fire on a dead component.
  useEffect(() => () => {
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
  }, [])

  // ── Load audio + compute waveform peaks ───────────────────
  useEffect(() => {
    let alive = true
    setLoadingWave(true)
    const ctx = new AudioContext()
    void (async () => {
      try {
        const raw    = await window.engine.readFile(audioPath)
        const buffer = await ctx.decodeAudioData(raw.slice(0))
        if (!alive) return
        setDuration(buffer.duration)
        setPeaks(computePeaks(buffer, PEAK_BUCKETS))
      } catch {
        if (alive) { setPeaks(null); setDuration(0) }
      } finally {
        if (alive) setLoadingWave(false)
        void ctx.close().catch(() => {})
      }
    })()
    return () => { alive = false }
  }, [audioPath])

  // ── Responsive canvas width ────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(280, Math.floor(el.clientWidth))))
    ro.observe(el)
    setWidth(Math.max(280, Math.floor(el.clientWidth)))
    return () => ro.disconnect()
  }, [])

  // PATCH-02 §3: the vertical MIDI scale the threshold line and contour
  // share. null until an analysis has produced a voiced contour — there's no
  // meaningful pitch axis to place D#4 on before that. Memoized so the draw
  // effect below isn't re-run by a fresh object on every unrelated render.
  const pitchAxis = useMemo(
    () => (result ? computePitchAxis(result.contour) : null),
    [result],
  )

  // ── Draw waveform (+ pitch contour) whenever peaks/size/result change ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width  = width
    canvas.height = CANVAS_HEIGHT
    if (!peaks) {
      canvas.getContext('2d')?.clearRect(0, 0, width, CANVAS_HEIGHT)
      return
    }
    drawWaveform(canvas, peaks, cssVar('--accent', '#6366f1'), {
      background: cssVar('--bg', '#0b0b12'),
      // Leave headroom so the waveform doesn't swamp the contour drawn over it.
      heightScale: result ? 0.72 : 1,
    })
    if (result && pitchAxis && duration > 0) {
      drawPitchContour(canvas, result.contour, {
        lo: pitchAxis.lo,
        hi: pitchAxis.hi,
        x0: result.range[0] / duration,
        x1: result.range[1] / duration,
        color: cssVar('--text', '#e2e8f0'),
      })
    }
  }, [peaks, width, result, pitchAxis, duration])

  // ── Drag-to-select region ──────────────────────────────────
  const secFromClientX = useCallback((clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas || duration <= 0) return 0
    const rect = canvas.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return frac * duration
  }, [duration])

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>): void {
    if (duration <= 0) return
    const sec = secFromClientX(e.clientX)
    dragStartRef.current = sec
    setDragPreview([sec, sec])
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>): void {
    if (dragStartRef.current == null) return
    setDragPreview([dragStartRef.current, secFromClientX(e.clientX)])
  }

  function commitDrag(clientX: number): void {
    const start = dragStartRef.current
    dragStartRef.current = null
    setDragPreview(null)
    if (start == null) return
    const end = secFromClientX(clientX)
    const a = Math.min(start, end)
    const b = Math.max(start, end)
    if (b - a < MIN_DRAG_SEC) clearRegion()
    else setRegion(a, b)
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>): void {
    commitDrag(e.clientX)
  }

  function handleMouseLeave(e: React.MouseEvent<HTMLCanvasElement>): void {
    if (dragStartRef.current != null) commitDrag(e.clientX)
  }

  // ── Analyze ─────────────────────────────────────────────────
  async function handleAnalyze(): Promise<void> {
    setError(null)
    setAnalyzing(true)
    const hasRegion = regionStart != null && regionEnd != null
    try {
      const res = await window.engine.call('analyze_pitch', {
        audio_path: audioPath,
        start_sec:  hasRegion ? regionStart : null,
        end_sec:    hasRegion ? regionEnd   : null,
      }) as AnalyzePitchResponse

      if (res.error) throw new Error(res.error)

      setResult({
        maxMidi: res.max_midi,
        avgMidi: res.avg_midi,
        contour: res.contour,
        range:   hasRegion ? [regionStart, regionEnd] : [0, duration],
      })
      // A re-analysis describes the track afresh; overlays from a protection
      // run against the previous analysis no longer correspond to what's
      // shown, so they go rather than lingering as stale red spans.
      setProtectResult(null)
      setProtectError(null)

      // Acceptance: "若未选择区域，自动分析整段音轨并提示用户" — the region
      // was empty, so let the user know the whole track was used instead.
      if (!hasRegion) {
        notify({
          category:   'system',
          titleKey:   'pitch.wholeTrackTitle',
          messageKey: 'pitch.wholeTrackMessage',
        })
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setAnalyzing(false)
    }
  }

  // ── Apply high-pitch protection (PATCH-02 §1/§2/§4) ─────────
  // Runs Ticket 17's 强制修音 over the analyzed track, clamping anything
  // above D#4, and keeps the corrected spans so they can be shaded red on
  // the waveform below.
  async function handleApplyProtection(): Promise<void> {
    if (protecting || !result) return
    setProtecting(true)
    setProtectError(null)
    setEngineBusy(true)
    setEngineStatus(t('status.applyingHighPitchProtection'))
    try {
      const res = await window.engine.call('apply_high_pitch_protection', {
        audio_path:     audioPath,
        threshold_note: PROTECTION_THRESHOLD_MIDI,
      }) as HighPitchProtectionResponse

      if (res.error) throw new Error(res.error)

      setProtectResult(res)
      // §4: sticky, so this survives the setEngineBusy(false) below and
      // stays on the toolbar instead of reverting to "engine ready".
      setEngineStatus(t('status.highPitchProtectionApplied'), true)

      // §2: green ✓ for two seconds, then back to the normal apply state.
      setJustApplied(true)
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = window.setTimeout(() => setJustApplied(false), APPLIED_FLASH_MS)

      notify({
        category: 'taskCompletion',
        titleKey: 'notification.highPitchProtection.complete.title',
        messageKey: 'notification.highPitchProtection.complete.message',
        messageParams: { count: res.modified_regions.length },
        action: { type: 'view', view: 'cover' },
      })
    } catch (err) {
      setProtectError(String(err))
      setEngineStatus(t('status.idle'))
      notify({
        category: 'taskFailure',
        titleKey: 'notification.highPitchProtection.failed.title',
        messageKey: 'notification.highPitchProtection.failed.message',
        messageParams: { message: String(err) },
        action: { type: 'view', view: 'cover' },
      })
    } finally {
      setProtecting(false)
      setEngineBusy(false)
    }
  }

  // ── Selection overlay geometry ─────────────────────────────
  const preview = dragPreview
    ? [Math.min(...dragPreview), Math.max(...dragPreview)] as [number, number]
    : null
  const committed: [number, number] | null =
    regionStart != null && regionEnd != null ? [regionStart, regionEnd] : null
  const overlay = preview ?? committed
  const overlayStyle = overlay && duration > 0
    ? {
        left:  `${(overlay[0] / duration) * 100}%`,
        width: `${((overlay[1] - overlay[0]) / duration) * 100}%`,
      }
    : null

  // PATCH-02 §3: where D#4 sits on the shared pitch axis, as a percentage
  // down from the top of the plot.
  const thresholdTopPct = pitchAxis
    ? midiToYFraction(PROTECTION_THRESHOLD_MIDI, pitchAxis) * 100
    : null
  const thresholdNote = midiToNoteName(PROTECTION_THRESHOLD_MIDI)

  // §2: the button is inert until an analysis has run — "请先分析音高".
  const canProtect = result != null && !analyzing && !loadingWave

  return (
    <div className="pitch-panel">
      <div className="pitch-panel-header">
        <span className="card-title" style={{ marginBottom: 0 }}>{t('pitch.title')}</span>
        <span className="pitch-panel-source">{label}</span>
      </div>
      <p className="pitch-hint">{t('pitch.selectRegionHint')}</p>

      <div ref={wrapRef} className="pitch-waveform-wrap">
        {loadingWave ? (
          <div className="pitch-waveform-loading">{t('pitch.loadingWaveform')}</div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="pitch-canvas"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
            />
            {overlayStyle && <div className="pitch-selection-overlay" style={overlayStyle} />}

            {/* PATCH-02 §3: red shading over the spans 强制修音 actually
                rewrote — "哪里被改了", at a glance. Drawn under the
                threshold line so the line stays readable across them. */}
            {duration > 0 && protectResult?.modified_regions.map(([s, e], i) => (
              <div
                key={`${s}-${e}-${i}`}
                className="pitch-corrected-region"
                style={{
                  left:  `${Math.min(100, (s / duration) * 100)}%`,
                  width: `${Math.max(0.3, Math.min(100, ((e - s) / duration) * 100))}%`,
                }}
                title={t('pitch.correctedRegionTitle', {
                  start: s.toFixed(1), end: e.toFixed(1),
                })}
              />
            ))}

            {/* §3: the D#4 reference line — everything drawn above it is
                what protection clamps back down. */}
            {thresholdTopPct != null && (
              <div className="pitch-threshold-line" style={{ top: `${thresholdTopPct}%` }}>
                <span className="pitch-threshold-label">
                  {t('pitch.thresholdLineLabel', { note: thresholdNote })}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="pitch-controls">
        <span className="pitch-region-label">
          {committed
            ? t('pitch.regionSelected', { start: committed[0].toFixed(1), end: committed[1].toFixed(1) })
            : t('pitch.wholeTrackLabel')}
        </span>
        <div className="row" style={{ gap: 8 }}>
          {committed && (
            <button className="btn btn-ghost" onClick={clearRegion} disabled={analyzing}>
              {t('pitch.clearRegion')}
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={handleAnalyze}
            disabled={analyzing || loadingWave || duration <= 0}
          >
            {analyzing ? `⏳ ${t('pitch.analyzing')}` : `🎼 ${t('pitch.analyze')}`}
          </button>

          {/* PATCH-02 §1/§2: the explicit 强制修音 trigger, sitting right of
              "分析音高" and inert until that analysis has produced a result. */}
          <button
            className={`btn pitch-protect-btn${justApplied ? ' applied' : ''}`}
            onClick={() => void handleApplyProtection()}
            disabled={!canProtect || protecting}
            title={canProtect ? t('pitch.applyProtection') : t('pitch.applyProtectionHint')}
            aria-label={t('pitch.applyProtection')}
          >
            {protecting ? (
              <>
                <span className="pitch-protect-spinner" aria-hidden="true" />
                {t('pitch.applyingProtection')}
              </>
            ) : justApplied ? (
              <>✓ {t('pitch.protectionApplied')}</>
            ) : (
              <>🛡 {t('pitch.applyProtection')}</>
            )}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {protectError && <div className="error-banner">{protectError}</div>}

      {/* §3: what the red shading above means, and how much of the take it
          covers — only once a run has actually happened. */}
      {protectResult && (
        <div className="pitch-protect-summary">
          {protectResult.modified_regions.length > 0 ? (
            <>
              <span className="pitch-protect-legend">
                <span className="pitch-protect-swatch" aria-hidden="true" />
                {t('pitch.correctedLegend', { note: thresholdNote })}
              </span>
              <span className="pitch-protect-info">
                {t('pitch.correctedInfo', {
                  count: protectResult.modified_regions.length,
                  percent: Math.round(protectResult.modified_ratio * 100),
                })}
              </span>
            </>
          ) : (
            <span className="pitch-protect-info">
              {t('pitch.correctedNone', { note: thresholdNote })}
            </span>
          )}
        </div>
      )}

      <PitchResultDisplay result={result} />
    </div>
  )
}
