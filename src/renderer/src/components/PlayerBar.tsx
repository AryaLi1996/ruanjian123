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
  const volume      = usePlayerStore((s) => s.volume)
  const loop        = usePlayerStore((s) => s.loop)
  const controls    = usePlayerStore((s) => s.controls)
  const setVolume   = usePlayerStore((s) => s.setVolume)
  const setLoop     = usePlayerStore((s) => s.setLoop)

  const active   = controls !== null
  const seekable = active && duration > 0
  const pct      = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  function seekBy(seconds: number): void {
    controls?.seek(Math.max(0, Math.min(duration, position + seconds)))
  }

  return (
    <footer className={`player-bar${active ? '' : ' idle'}`}>
      <div className="pb-meta">
        <div className="pb-cover">
          {coverArtUrl
            ? <img src={coverArtUrl} alt="" />
            : <span className="pb-cover-placeholder" aria-hidden="true" />}
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
            onClick={() => seekBy(-5)}
            disabled={!active}
            title={t('player.previous')}
            aria-label={t('player.previous')}
          >
            ↶5
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
          <button className="pb-btn" onClick={() => seekBy(5)} disabled={!active} title={t('player.next')} aria-label={t('player.next')}>5↷</button>
        </div>

        <div className="pb-progress-row">
          <span className="pb-time">{formatTime(position)}</span>
          <input
            className="pb-progress"
            type="range" min={0} max={duration || 0} step={0.01}
            value={Math.min(position, duration || 0)} disabled={!seekable}
            onChange={(event) => controls?.seek(Number(event.target.value))}
            style={{ '--progress': `${pct}%` } as React.CSSProperties}
            aria-label={t('player.seek')}
          />
          <span className="pb-time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="pb-right">
        <button className={`pb-btn pb-loop${loop ? ' active' : ''}`} onClick={() => setLoop(!loop)} disabled={!active} title={t('player.loop')} aria-label={t('player.loop')}>↻</button>
        <span aria-hidden="true">🔊</span>
        <input className="pb-volume" type="range" min={0} max={1} step={0.01} value={volume}
          onChange={(event) => setVolume(Number(event.target.value))} disabled={!active} aria-label={t('player.volume')} />
        <button className="btn btn-ghost pb-goto-btn" onClick={() => setActiveView('playback')} title={t('player.openPlayback')}>🎚️ {t('player.openPlayback')}</button>
      </div>
    </footer>
  )
}
