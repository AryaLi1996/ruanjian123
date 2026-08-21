import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PITCH_SHIFT_MIN, PITCH_SHIFT_MAX } from '../../utils/pitch'

interface Props {
  /** The shift currently applied (and cached) for the target song. */
  value:       number
  /** Ticket 19: recommended_shift from computeRecommendedShift(), or null
   *  until both the song's key and the user's vocal range are known. */
  recommended: number | null
  /** True while the engine is re-processing the target audio at a new shift. */
  busy:        boolean
  onChange:    (value: number) => void
}

function formatShift(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

/**
 * Tune slider — Ticket 19. A plain -12..+12 step-1 range input, with a
 * separately-positioned dot overlaid on the track marking the recommended
 * shift (native <input type="range"> has no notion of a second, non-thumb
 * marker, so it's drawn as an absolutely-positioned sibling instead).
 *
 * Dragging updates the shown number continuously (onInput); the actual
 * re-process call only fires once the drag/keypress commits (onChange),
 * via the parent's onChange — see CoverView's handlePitchShiftChange, which
 * does the engine.call('pitch_shift', …) and caching.
 */
export function PitchShiftSlider({ value, recommended, busy, onChange }: Props): JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value)

  // Keep the draft in sync when the committed value changes from elsewhere
  // (a new song selected, or the "apply recommended" shortcut below) —
  // otherwise the thumb would lag one step behind after a non-drag update.
  useEffect(() => { setDraft(value) }, [value])

  const range = PITCH_SHIFT_MAX - PITCH_SHIFT_MIN
  const markerPct = recommended != null ? ((recommended - PITCH_SHIFT_MIN) / range) * 100 : null

  return (
    <div className="pitch-shift">
      <div className="pitch-shift-header">
        <span className="pitch-shift-label">{t('cover.pitchShift')}</span>
        <span className="pitch-shift-value">{formatShift(draft)}</span>
      </div>

      <div className="pitch-shift-track-wrap">
        <input
          type="range"
          className="pitch-shift-slider"
          min={PITCH_SHIFT_MIN}
          max={PITCH_SHIFT_MAX}
          step={1}
          value={draft}
          disabled={busy}
          onInput={(e) => setDraft(Number(e.currentTarget.value))}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={t('cover.pitchShift')}
        />
        {markerPct != null && (
          <div
            className="pitch-shift-marker"
            style={{ left: `${markerPct}%` }}
            title={t('cover.pitchShiftRecommendedTitle', { value: formatShift(recommended!) })}
          />
        )}
      </div>

      <div className="pitch-shift-scale">
        <span>{PITCH_SHIFT_MIN}</span>
        <span>0</span>
        <span>+{PITCH_SHIFT_MAX}</span>
      </div>

      {recommended != null && (
        <div className="pitch-shift-hint">
          {t('cover.pitchShiftRecommended', { value: formatShift(recommended) })}
          {recommended !== value && (
            <button
              type="button"
              className="btn btn-ghost pbm-mini-btn"
              disabled={busy}
              onClick={() => onChange(recommended)}
            >
              {t('cover.pitchShiftApplyRecommended')}
            </button>
          )}
        </div>
      )}

      {busy && <div className="pitch-shift-busy">⏳ {t('cover.pitchShiftProcessing')}</div>}
    </div>
  )
}
