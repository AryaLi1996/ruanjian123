import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { usePlayerStore } from '../store/usePlayerStore'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Persistent bottom control bar (Ticket UI-02 §4) — the fourth module of the
 * shell, fixed at 90px on every page.
 *
 * It's a pure view over usePlayerStore: whichever view currently owns an
 * audio graph registers its transport commands there and publishes position/
 * duration. When nothing is registered (`controls === null`) the bar stays
 * visible — the layout must not reflow as the user navigates — but renders
 * its idle state with the controls disabled and a shortcut to the playback
 * page, rather than offering buttons that would silently do nothing.
 */
export function PlayerBar(): JSX.Element {
  const { t } = useTranslation()
  const setActiveView = useAppStore((s) => s.setActiveView)

  const title       = usePlayerStore((s) => s.title)
  const artist      = usePlayerStore((s) => s.artist)
  const coverArtUrl = usePlayerStore((s) => s.coverArtUrl)
  const playing     = usePlayerStore((s) => s.playing)
  const position    = usePlayerStore((s) => s.position)
  const duration    = usePlayerStore((s) => s.duration)
  const controls    = usePlayerStore((s) => s.controls)

  const active   = controls !== null
  const seekable = active && duration > 0
  const pct      = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  function handleSeek(event: React.MouseEvent<HTMLDivElement>): void {
    if (!seekable) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    controls?.seek(Math.max(0, Math.min(1, ratio)) * duration)
  }

  return (
    <footer className={`player-bar${active ? '' : ' idle'}`}>
      <div className="pb-meta">
        <div className="pb-cover">
          {coverArtUrl
            ? <img src={coverArtUrl} alt="" />
            : <span className="pb-cover-placeholder" aria-hidden="true">🎵</span>}
        </div>
        <div className="pb-text">
          <div className="pb-title" title={title ?? undefined}>
            {title ?? t('player.noSong')}
          </div>
          <div className="pb-artist" title={artist ?? undefined}>
            {artist ?? (active ? '' : t('player.idleHint'))}
          </div>
        </div>
      </div>

      <div className="pb-center">
        <div className="pb-controls">
          <button
            className="pb-btn"
            onClick={() => controls?.stop()}
            disabled={!active}
            title={t('player.stop')}
            aria-label={t('player.stop')}
          >
            ⏹
          </button>
          <button
            className="pb-btn pb-btn-play"
            onClick={() => controls?.togglePlay()}
            disabled={!active}
            title={playing ? t('player.pause') : t('player.play')}
            aria-label={playing ? t('player.pause') : t('player.play')}
          >
            {playing ? '⏸' : '▶'}
          </button>
        </div>

        <div className="pb-progress-row">
          <span className="pb-time">{formatTime(position)}</span>
          {/* A plain div rather than <input type="range">: the fill/handle
              styling here has to match the app's other timelines (see
              .player-timeline), and the bar is read-only whenever no view
              owns the audio graph. */}
          <div
            className={`pb-progress${seekable ? ' seekable' : ''}`}
            onClick={handleSeek}
            role="slider"
            aria-label={t('player.seek')}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(position)}
            aria-disabled={!seekable}
            tabIndex={seekable ? 0 : -1}
            onKeyDown={(event) => {
              if (!seekable) return
              if (event.key === 'ArrowLeft')  controls?.seek(Math.max(0, position - 5))
              if (event.key === 'ArrowRight') controls?.seek(Math.min(duration, position + 5))
            }}
          >
            <div className="pb-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="pb-time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="pb-right">
        <button
          className="btn btn-ghost pb-goto-btn"
          onClick={() => setActiveView('playback')}
          title={t('player.openPlayback')}
        >
          🎚️ {t('player.openPlayback')}
        </button>
      </div>
    </footer>
  )
}
