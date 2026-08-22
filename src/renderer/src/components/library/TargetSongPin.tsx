import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { placeholderCover } from '../../utils/coverArt'

/**
 * "Currently targeted song" pin (Ticket UI-09).
 *
 * Lives in the top bar so the answer to "which song am I covering?" is on
 * screen from every page, not just the one where it was picked. Shows the
 * cover, the title and the live pitch shift, and clears the target on ✕.
 *
 * Renders nothing when no song is selected — the pin appearing *is* the
 * signal that a target is set.
 */
export function TargetSongPin(): JSX.Element | null {
  const { t } = useTranslation()
  const targetSong    = useAppStore((s) => s.targetSong)
  const setTargetSong = useAppStore((s) => s.setTargetSong)

  if (!targetSong) return null

  const cover = placeholderCover(targetSong.id, targetSong.title)
  const shift = targetSong.pitchShift

  return (
    <div className="target-pin" role="status" aria-label={t('library.targetSong')}>
      <div
        className="target-pin-cover"
        style={targetSong.coverUrl ? undefined : { background: cover.gradient }}
      >
        {targetSong.coverUrl
          ? <img src={targetSong.coverUrl} alt="" />
          : <span aria-hidden="true">{cover.initial}</span>}
      </div>

      <div className="target-pin-text">
        <div className="target-pin-title" title={targetSong.title}>{targetSong.title}</div>
        <div className="target-pin-meta">
          {/* Zero is shown as "原调" rather than "+0 个调": a shift of none is
              a state the user recognises, not an arithmetic result. */}
          {shift === 0
            ? t('library.originalKey')
            : t('library.pitchShiftValue', { value: shift > 0 ? `+${shift}` : String(shift) })}
        </div>
      </div>

      <button
        type="button"
        className="target-pin-clear"
        onClick={() => setTargetSong(null)}
        aria-label={t('library.clearTarget')}
        title={t('library.clearTarget')}
      >
        ✕
      </button>
    </div>
  )
}
