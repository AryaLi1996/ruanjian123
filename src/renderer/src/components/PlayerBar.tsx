import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { usePlayerStore } from '../store/usePlayerStore'

/** `mm:ss` with a zero-padded minute, per Ticket UI-03 §3's `01:23 / 04:56`. */
function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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
  const waveformUrl = usePlayerStore((s) => s.waveformUrl)
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

  // Position being dragged, or null when not scrubbing. The commit is
  // deliberately deferred to pointerup: the owning view's seek() tears down
  // and recreates every buffer source, so seeking on each pointermove (as a
  // range input's onChange does) restarts the whole graph dozens of times
  // per drag. The handle tracks the pointer live and the audio jumps once,
  // on release — the way a buffer-source player has to behave.
  const [scrub, setScrub] = useState<number | null>(null)
  const progressRef = useRef<HTMLDivElement>(null)

  const shown    = scrub ?? position
  const shownPct = duration > 0 ? Math.min(100, Math.max(0, (shown / duration) * 100)) : 0

  function positionFromEvent(clientX: number): number {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (!seekable) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setScrub(positionFromEvent(event.clientX))
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (scrub === null) return
    setScrub(positionFromEvent(event.clientX))
  }

  // Also fires for a plain click (press and release with no movement), so
  // click-to-seek and drag-to-seek share this one commit path.
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (scrub === null) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    controls?.seek(positionFromEvent(event.clientX))
    setScrub(null)
  }

  function seekBy(seconds: number): void {
    controls?.seek(Math.max(0, Math.min(duration, position + seconds)))
  }

  return (
    <footer className={`player-bar${active ? '' : ' idle'}`}>
      <div className="pb-meta">
        <div className="pb-cover">
          {waveformUrl
            ? <img src={waveformUrl} alt="" className="pb-cover-wave" />
            : coverArtUrl
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
          {/* A div rather than <input type="range">: the drag has to be able
              to move the handle without committing a seek on every step (see
              the scrub note above), which a range input's onChange can't do. */}
          <div
            ref={progressRef}
            className={`pb-progress${seekable ? ' seekable' : ''}${scrub !== null ? ' scrubbing' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setScrub(null)}
            role="slider"
            aria-label={t('player.seek')}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(shown)}
            aria-valuetext={`${formatClock(shown)} / ${formatClock(duration)}`}
            aria-disabled={!seekable}
            tabIndex={seekable ? 0 : -1}
            onKeyDown={(event) => {
              if (!seekable) return
              if (event.key === 'ArrowLeft')  { event.preventDefault(); seekBy(-5) }
              if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5) }
              if (event.key === 'Home')       { event.preventDefault(); controls?.seek(0) }
              if (event.key === 'End')        { event.preventDefault(); controls?.seek(duration) }
            }}
          >
            <div className="pb-progress-fill" style={{ width: `${shownPct}%` }} />
            <div className="pb-progress-handle" style={{ left: `${shownPct}%` }} />
          </div>
        </div>
      </div>

      <div className="pb-right">
        <span className="pb-clock">
          {formatClock(shown)} <span className="pb-clock-sep">/</span> {formatClock(duration)}
        </span>
        {/* Loop and volume stay enabled while idle: they're user preferences
            the next view to take ownership will pick up, not commands aimed
            at a graph that isn't there. */}
        <button className={`pb-btn pb-loop${loop ? ' active' : ''}`} onClick={() => setLoop(!loop)} title={t('player.loop')} aria-label={t('player.loop')} aria-pressed={loop}>↻</button>
        <span aria-hidden="true">🔊</span>
        <input className="pb-volume" type="range" min={0} max={1} step={0.01} value={volume}
          onChange={(event) => setVolume(Number(event.target.value))} aria-label={t('player.volume')} />
        <button className="btn btn-ghost pb-goto-btn" onClick={() => setActiveView('playback')} title={t('player.openPlayback')}>🎚️ {t('player.openPlayback')}</button>
      </div>
    </footer>
  )
}
