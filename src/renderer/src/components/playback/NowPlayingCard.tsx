import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  title:       string | null
  artist:      string | null
  coverArtUrl: string | null
  liked:       boolean
  onToggleLike: () => void
}

export function NowPlayingCard({ title, artist, coverArtUrl, liked, onToggleLike }: Props): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  async function share(): Promise<void> {
    const text = [title, artist].filter(Boolean).join(' — ')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard unavailable — silently ignore */ }
  }

  return (
    <div className="pbm-now-playing">
      <div className="pbm-now-cover">
        {coverArtUrl
          ? <img src={coverArtUrl} alt="" />
          : <span className="pbm-now-cover-placeholder" aria-hidden="true">🎵</span>}
      </div>
      <div className="pbm-now-info">
        <div className="pbm-now-title" title={title ?? undefined}>
          {title ?? t('playback.noSongSelected')}
        </div>
        <div className="pbm-now-artist">{artist ?? (title ? t('playback.unknownArtist') : '')}</div>
        {title && (
          <div className="pbm-now-actions">
            <button
              className={`btn btn-ghost pbm-mini-btn${liked ? ' active' : ''}`}
              onClick={onToggleLike}
              title={liked ? t('playback.unlike') : t('playback.like')}
            >
              {liked ? '♥' : '♡'}
            </button>
            <button className="btn btn-ghost pbm-mini-btn" onClick={() => void share()} title={t('playback.share')}>
              {copied ? t('playback.shareCopied') : `⇪ ${t('playback.share')}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
