import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'

interface Props {
  src:    string
  title?: string
}

export function AudioPlayer({ src, title }: Props): JSX.Element {
  const { t } = useTranslation()
  const audioRef                    = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying]       = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration]     = useState(0)
  const [volume, setVolume]         = useState(0.8)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTimeUpdate = () => setCurrentTime(el.currentTime)
    const onDuration   = () => setDuration(el.duration)
    const onEnded      = () => { setPlaying(false); setCurrentTime(0) }
    el.addEventListener('timeupdate',       onTimeUpdate)
    el.addEventListener('loadedmetadata',   onDuration)
    el.addEventListener('ended',            onEnded)
    return () => {
      el.removeEventListener('timeupdate',     onTimeUpdate)
      el.removeEventListener('loadedmetadata', onDuration)
      el.removeEventListener('ended',          onEnded)
    }
  }, [src])

  function togglePlay(): void {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false) }
    else         { el.play().then(() => setPlaying(true)).catch(() => {}) }
  }

  function seek(e: React.MouseEvent<HTMLDivElement>): void {
    const el   = audioRef.current
    if (!el || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t    = ((e.clientX - rect.left) / rect.width) * duration
    el.currentTime = t
    setCurrentTime(t)
  }

  function changeVolume(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = Number(e.target.value)
    setVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="player">
      <audio ref={audioRef} src={src} preload="metadata" />

      <button className="player-play-btn" onClick={togglePlay} aria-label={playing ? t('training.pause') : t('training.play')}>
        {playing ? '⏸' : '▶'}
      </button>

      <div className="player-body">
        {title && <div className="player-title">{title}</div>}
        <div className="player-timeline" onClick={seek} role="slider" aria-valuenow={Math.round(progress)}>
          <div className="player-timeline-fill" style={{ width: `${progress}%` }} />
          <div className="player-timeline-thumb" style={{ left: `${progress}%` }} />
        </div>
        <div className="player-time">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      <input
        className="player-volume"
        type="range"
        min={0} max={1} step={0.01}
        value={volume}
        onChange={changeVolume}
        aria-label={t('training.volume')}
        title={t('training.volume')}
      />
    </div>
  )
}
