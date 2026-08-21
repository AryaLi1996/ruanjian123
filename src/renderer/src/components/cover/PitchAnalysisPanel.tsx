import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { computePeaks, drawWaveform } from '../../utils/waveform'
import { usePitchStore } from '../../store/usePitchStore'
import { notify } from '../../store/useNotificationStore'
import { PitchResultDisplay } from './PitchResultDisplay'

const PEAK_BUCKETS  = 1200
const CANVAS_HEIGHT = 84
// A drag shorter than this (in seconds) is treated as a click, not a
// selection — clears any region rather than creating a near-zero-length one.
const MIN_DRAG_SEC = 0.15

interface AnalyzePitchResponse {
  max_midi: number
  avg_midi: number
  contour:  number[]
  error?:   string
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

  const [duration, setDuration]     = useState(0)
  const [peaks, setPeaks]           = useState<Float32Array | null>(null)
  const [loadingWave, setLoadingWave] = useState(true)
  const [dragPreview, setDragPreview] = useState<[number, number] | null>(null)
  const [width, setWidth]           = useState(600)

  const canvasRef    = useRef<HTMLCanvasElement | null>(null)
  const wrapRef       = useRef<HTMLDivElement | null>(null)
  const dragStartRef  = useRef<number | null>(null)

  // A new file to analyze (e.g. switching stems) starts from a clean slate.
  useEffect(() => { reset() }, [audioPath, reset])

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

  // ── Draw waveform whenever peaks/size change ───────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width  = width
    canvas.height = CANVAS_HEIGHT
    if (peaks) {
      drawWaveform(canvas, peaks, cssVar('--accent', '#6366f1'), {
        background: cssVar('--bg', '#0b0b12'),
      })
    } else {
      const ctx2d = canvas.getContext('2d')
      ctx2d?.clearRect(0, 0, width, CANVAS_HEIGHT)
    }
  }, [peaks, width])

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

      setResult({ maxMidi: res.max_midi, avgMidi: res.avg_midi, contour: res.contour })

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
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <PitchResultDisplay result={result} />
    </div>
  )
}
