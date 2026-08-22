import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { midiToNoteName, suggestedProtectionThreshold } from '../../utils/pitch'

interface Props {
  maxMidi:  number
  avgMidi:  number
  /** Runs the high-pitch protection (Ticket 17's engine call). */
  onApply:  () => void
  onClose:  () => void
  applying: boolean
  applied:  boolean
  /** False when protection can't run yet — the tooltip explains why. */
  canApply:     boolean
  disabledHint?: string
}

/** How long the card keeps its attention-drawing glow before settling down. */
const GLOW_MS = 3_000

/** Kept on screen by at least this much when dragged towards an edge. */
const EDGE_MARGIN = 24

const CARD_WIDTH = 300

/**
 * Floating pitch-analysis result card (Ticket UI-07).
 *
 * Deliberately not a modal: analysis is something the user runs *while*
 * working on the waveform, so the result has to be readable without
 * blocking the editor underneath. It's viewport-fixed and draggable by its
 * header precisely because the interesting part of the waveform is often
 * exactly where a statically-placed card would land.
 */
export function PitchResultCard({
  maxMidi, avgMidi, onApply, onClose, applying, applied, canApply, disabledHint,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const cardRef = useRef<HTMLDivElement>(null)

  // null until the first layout pass, when it's anchored to the top-right of
  // the viewport; after that it's whatever the user dragged it to.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [glowing, setGlowing] = useState(true)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    setPos({ x: Math.max(EDGE_MARGIN, window.innerWidth - CARD_WIDTH - 48), y: 132 })
  }, [])

  // The glow is an attention cue, not a permanent state — it would be noise
  // on a card the user has already read (Ticket UI-07 §3).
  useEffect(() => {
    const id = setTimeout(() => setGlowing(false), GLOW_MS)
    return () => clearTimeout(id)
  }, [])

  const clamp = useCallback((x: number, y: number) => {
    const rect = cardRef.current?.getBoundingClientRect()
    const w = rect?.width ?? CARD_WIDTH
    const h = rect?.height ?? 0
    return {
      x: Math.min(Math.max(EDGE_MARGIN - w + 80, x), window.innerWidth - EDGE_MARGIN - 80),
      y: Math.min(Math.max(EDGE_MARGIN, y), window.innerHeight - EDGE_MARGIN - Math.min(h, 60)),
    }
  }, [])

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Only the header drags; buttons inside it must stay clickable.
    if ((event.target as HTMLElement).closest('button')) return
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag) return
    setPos(clamp(event.clientX - drag.dx, event.clientY - drag.dy))
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }

  const hasPitch      = maxMidi > 0
  const thresholdMidi = hasPitch ? suggestedProtectionThreshold(maxMidi) : null
  const noteWithMidi  = (midi: number): string => `${midiToNoteName(midi)} (${midi})`

  return (
    <div
      ref={cardRef}
      className={`pitch-card${glowing ? ' glowing' : ''}`}
      style={pos ? { left: pos.x, top: pos.y } : { visibility: 'hidden' }}
      role="dialog"
      aria-label={t('pitch.cardTitle')}
    >
      <div
        className="pitch-card-header"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <span className="pitch-card-title">🎼 {t('pitch.cardTitle')}</span>
        <button
          type="button"
          className="pitch-card-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ✕
        </button>
      </div>

      {hasPitch ? (
        <>
          <dl className="pitch-card-stats">
            <div className="pitch-card-stat">
              <dt>{t('pitch.maxDetected')}</dt>
              <dd className="pitch-card-value pitch-card-max">{noteWithMidi(maxMidi)}</dd>
            </div>
            <div className="pitch-card-stat">
              <dt>{t('pitch.avgDetected')}</dt>
              <dd className="pitch-card-value">{avgMidi > 0 ? noteWithMidi(Math.round(avgMidi)) : '—'}</dd>
            </div>
            <div className="pitch-card-stat">
              <dt>{t('pitch.suggestedThreshold')}</dt>
              <dd className="pitch-card-value pitch-card-threshold">
                {thresholdMidi != null ? midiToNoteName(thresholdMidi) : '—'}
              </dd>
            </div>
          </dl>

          <button
            type="button"
            className={`pitch-card-apply${applied ? ' applied' : ''}`}
            onClick={onApply}
            disabled={!canApply || applying || applied}
            title={canApply ? t('dataPrep.applyProtection') : disabledHint}
            aria-busy={applying || undefined}
          >
            {applying
              ? <><span className="at-spinner" aria-hidden="true" /> {t('dataPrep.applying')}</>
              : applied
                ? `✓ ${t('dataPrep.applied')}`
                : `🛡 ${t('dataPrep.applyProtection')}`}
          </button>
        </>
      ) : (
        <p className="pitch-card-empty">{t('pitch.noPitchDetected')}</p>
      )}
    </div>
  )
}
