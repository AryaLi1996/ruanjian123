import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { notify } from '../../store/useNotificationStore'
import { computePeaks, drawWaveform } from '../../utils/waveform'
import { formatDuration } from '../../utils/audio'

interface HighPitchProtectionResult {
  output_path:       string
  modified_regions:  [number, number][]
  modified_ratio:    number
  threshold_hz:      number
  threshold_note:    number
  duration_sec:      number
  elapsed_sec:       number
}

interface Props {
  /** Path to the AI vocal stem to correct (e.g. coverResult.ai_vocal_path). */
  audioPath: string
  /** Called with the corrected file's path once protection has been applied. */
  onApplied?: (outputPath: string) => void
}

const PEAK_BUCKETS = 1200
const CANVAS_HEIGHT = 64

/**
 * Ticket 17: "高音保护" (forced auto-tune). Runs
 * engine.apply_high_pitch_protection on the AI vocal stem, then renders its
 * waveform with the corrected spans highlighted in red so the user can see
 * exactly where 强制修音 fired.
 */
export function HighPitchProtection({ audioPath, onApplied }: Props): JSX.Element {
  const { t } = useTranslation()
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)

  const [applying, setApplying] = useState(false)
  const [result,   setResult]   = useState<HighPitchProtectionResult | null>(null)
  const [peaks,    setPeaks]    = useState<Float32Array | null>(null)
  const [duration, setDuration] = useState(0)
  const [error,    setError]    = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef     = useRef<HTMLCanvasElement | null>(null)
  const [canvasWidth, setCanvasWidth] = useState(600)

  // Track the wrapper's width so the waveform (and its red overlays, which
  // are positioned by percentage) stay aligned as the panel resizes.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setCanvasWidth(Math.max(280, Math.floor(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    canvas.width = canvasWidth
    canvas.height = CANVAS_HEIGHT
    drawWaveform(canvas, peaks, '#6366f1', { background: 'transparent' })
  }, [peaks, canvasWidth])

  async function handleApply(): Promise<void> {
    setApplying(true); setError(null)
    setEngineStatus(t('status.applyingHighPitchProtection'))
    try {
      const res = await window.engine.call('apply_high_pitch_protection', {
        audio_path:     audioPath,
        threshold_note: 63,   // D#4 — fixed per Ticket 17 ("高音保护起点为D#4")
      }) as HighPitchProtectionResult

      const buf = await window.engine.readFile(res.output_path)
      const ctx = new AudioContext()
      const decoded = await ctx.decodeAudioData(buf.slice(0))
      await ctx.close()

      setPeaks(computePeaks(decoded, PEAK_BUCKETS))
      setDuration(decoded.duration)
      setResult(res)
      onApplied?.(res.output_path)

      // Ticket 17: fixed top-status-bar copy once protection has been applied.
      setEngineStatus(t('status.highPitchProtectionApplied'))

      notify({
        category: 'taskCompletion',
        titleKey: 'notification.highPitchProtection.complete.title',
        messageKey: 'notification.highPitchProtection.complete.message',
        messageParams: { count: res.modified_regions.length },
        action: { type: 'view', view: 'cover' },
      })
    } catch (err) {
      setError(String(err))
      setEngineStatus(t('status.idle'))
      notify({
        category: 'taskFailure',
        titleKey: 'notification.highPitchProtection.failed.title',
        messageKey: 'notification.highPitchProtection.failed.message',
        messageParams: { message: String(err) },
        action: { type: 'view', view: 'cover' },
      })
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="card hpp-card">
      <div className="card-title">{t('cover.highPitchProtection')}</div>
      <p className="hpp-desc">{t('cover.highPitchProtectionThreshold')}</p>

      {error && <div className="error-banner">{error}</div>}

      <button className="btn btn-ghost" onClick={() => void handleApply()} disabled={applying || !audioPath}>
        {applying ? `⏳ ${t('cover.highPitchProtectionApplying')}` : `🎯 ${t('cover.highPitchProtectionApply')}`}
      </button>

      <div ref={containerRef} className="hpp-wave-wrap">
        {peaks && duration > 0 && (
          <>
            <canvas ref={canvasRef} className="hpp-canvas" />
            {result?.modified_regions.map(([s, e], i) => (
              <div
                key={i}
                className="hpp-region"
                style={{
                  left:  `${Math.min(100, (s / duration) * 100)}%`,
                  width: `${Math.max(0.3, Math.min(100, ((e - s) / duration) * 100))}%`,
                }}
                title={`${formatDuration(s)} – ${formatDuration(e)}`}
              />
            ))}
          </>
        )}
      </div>

      {result && (
        <div className="hpp-footer">
          <div className="hpp-info">
            {result.modified_regions.length > 0
              ? t('cover.highPitchProtectionInfo', {
                  count: result.modified_regions.length,
                  percent: Math.round(result.modified_ratio * 100),
                })
              : t('cover.highPitchProtectionNone')}
          </div>
          {result.modified_regions.length > 0 && (
            <div className="hpp-legend">
              <span className="hpp-legend-swatch" aria-hidden="true" />
              {t('cover.highPitchProtectionLegend')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
