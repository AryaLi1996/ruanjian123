import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { notify } from '../../store/useNotificationStore'
import { computePeaks, drawWaveform } from '../../utils/waveform'
import { formatDuration } from '../../utils/audio'
import { computeRecommendedShiftRange, type RecommendedShiftRange } from '../../utils/pitch'

interface HighPitchProtectionResult {
  output_path:       string
  modified_regions:  [number, number][]
  modified_ratio:    number
  threshold_hz:      number
  threshold_note:    number
  duration_sec:      number
  elapsed_sec:       number
}

interface AnalyzePitchResponse {
  max_midi: number
  avg_midi: number
  contour:  number[]
  error?:   string
}

interface Props {
  /** Path to the AI vocal stem to correct (e.g. coverResult.ai_vocal_path). */
  audioPath: string
  /** Called with the corrected file's path once protection has been applied. */
  onApplied?: (outputPath: string) => void
  /** Ticket 22: the selected cloud-library song's original key (Ticket 18),
   *  if any — needed to recommend a Tune-slider shift from the *protected*
   *  vocal's re-analyzed range. null/undefined (no target song, or a local
   *  upload with no catalog key) means no recommendation can be made. */
  originalKey?: string | null
  /** Ticket 22: fired with the recommended shift (semitones) once protection
   *  and the re-analysis it triggers both complete and a recommendation was
   *  computed. Never fired when originalKey is unset or no shift is needed. */
  onRecommendedShift?: (shift: number) => void
}

const PEAK_BUCKETS = 1200
const CANVAS_HEIGHT = 64

/**
 * Ticket 17: "高音保护" (forced auto-tune). Runs
 * engine.apply_high_pitch_protection on the AI vocal stem, then renders its
 * waveform with the corrected spans highlighted in red so the user can see
 * exactly where 强制修音 fired.
 *
 * Ticket 22: once protection succeeds, also re-analyzes the corrected vocal
 * (engine.analyze_pitch) and — given the target song's original key via
 * `originalKey` — computes a recommended Tune-slider shift from its new,
 * post-protection range. `onRecommendedShift` hands that back to the parent
 * (CoverView) to auto-set the slider; the user can still drag it to any
 * other value afterward, same as any other change to that slider.
 */
export function HighPitchProtection({ audioPath, onApplied, originalKey, onRecommendedShift }: Props): JSX.Element {
  const { t } = useTranslation()
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)
  const setEngineBusy    = useAppStore((s) => s.setEngineBusy)

  const [applying, setApplying] = useState(false)
  const [result,   setResult]   = useState<HighPitchProtectionResult | null>(null)
  const [peaks,    setPeaks]    = useState<Float32Array | null>(null)
  const [duration, setDuration] = useState(0)
  const [error,    setError]    = useState<string | null>(null)
  // Ticket 22: recommendation computed from the *protected* vocal's range,
  // once re-analysis (below) completes. null until then, and stays null
  // when no target song/key is selected or no shift turns out to be needed.
  const [shiftRange, setShiftRange] = useState<RecommendedShiftRange | null>(null)

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
    setApplying(true); setError(null); setShiftRange(null)
    // PATCH-02 §4: the toolbar only renders engineStatus while the engine
    // reads as busy, so without this the applying/applied copy below was set
    // but never actually shown.
    setEngineBusy(true)
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

      // Ticket 22: re-analyze the just-protected vocal (its highest note is
      // now at/under D#4, wherever the protection clamp fired) so the
      // recommended Tune-slider shift for the target song reflects the
      // vocal's *post-protection* range, not the raw pre-protection one.
      // Best-effort: a bad/corrupt output or an engine error here shouldn't
      // undo the protection that already succeeded above — protection and
      // its confirmation notification (below) still stand either way.
      let recRange: RecommendedShiftRange | null = null
      if (originalKey) {
        try {
          const analysis = await window.engine.call('analyze_pitch', {
            audio_path: res.output_path,
          }) as AnalyzePitchResponse
          if (!analysis.error && analysis.max_midi > 0) {
            recRange = computeRecommendedShiftRange(originalKey, analysis.max_midi)
          }
        } catch {
          // no recommendation this time — protection itself already applied fine
        }
      }
      setShiftRange(recRange)

      if (recRange) {
        onRecommendedShift?.(recRange.recommended)
        const direction = t(recRange.recommended < 0 ? 'cover.shiftDirectionDown' : 'cover.shiftDirectionUp')
        // Ticket 22: combined top-status-bar copy — "已应用模型音域，高音保护起点为
        // D#4 | 建议降4个调" — once a recommendation could be computed.
        // Sticky (PATCH-02 §4) — this is an outcome to keep on the bar, not
        // a progress line that should vanish the moment the engine idles.
        setEngineStatus(t('status.highPitchProtectionAppliedWithShift', {
          direction, count: Math.abs(recRange.recommended),
        }), true)
      } else {
        // Ticket 17: fixed top-status-bar copy once protection has been applied.
        setEngineStatus(t('status.highPitchProtectionApplied'), true)
      }

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
      setEngineBusy(false)
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

      {/* Ticket 22: confirmation message + recommended Tune-slider shift,
          computed from the just-protected vocal's re-analyzed range against
          the target song's original key. */}
      {shiftRange && (
        <div className="hpp-shift-suggestion">
          🎚️ {t('cover.highPitchProtectionShiftSuggestion', {
            direction: t(shiftRange.recommended < 0 ? 'cover.shiftDirectionDown' : 'cover.shiftDirectionUp'),
            min: Math.min(Math.abs(shiftRange.recommended), Math.abs(shiftRange.cushioned)),
            max: Math.max(Math.abs(shiftRange.recommended), Math.abs(shiftRange.cushioned)),
            rec: Math.abs(shiftRange.recommended),
          })}
        </div>
      )}
    </div>
  )
}
