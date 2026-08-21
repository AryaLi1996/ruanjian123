import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'

export interface StemTrack {
  key:   string   // e.g. 'vocals', 'accompaniment', 'lead_dry'
  label: string
  path:  string   // absolute file path on disk
}

interface Props {
  stems: StemTrack[]
}

export function StemPlayer({ stems }: Props): JSX.Element {
  const { t } = useTranslation()
  const [urls, setUrls]     = useState<Record<string, string>>({})
  const [solo, setSolo]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const audioRefs = useRef<Record<string, HTMLAudioElement>>({})

  useEffect(() => {
    let alive = true
    const revoke: string[] = []
    async function load() {
      const built: Record<string, string> = {}
      for (const s of stems) {
        try {
          const buf  = await window.engine.readFile(s.path)
          const blob = new Blob([buf], { type: 'audio/wav' })
          const url  = URL.createObjectURL(blob)
          built[s.key] = url
          revoke.push(url)
        } catch { /* ignore unavailable stems */ }
      }
      if (alive) { setUrls(built); setLoading(false) }
    }
    load()
    return () => { alive = false; revoke.forEach(URL.revokeObjectURL) }
  }, [stems])

  function handleSolo(key: string): void {
    const next = solo === key ? null : key
    setSolo(next)
    // Mute/unmute all audio elements accordingly
    Object.entries(audioRefs.current).forEach(([k, el]) => {
      el.muted = next !== null && k !== next
    })
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>{t('cover.stemsLoading')}</div>
  }

  return (
    <div className="stem-grid">
      {stems.map((s) => (
        <div key={s.key} className={`stem-track${solo === s.key ? ' solo' : ''}`}>
          <div className="stem-track-header">
            <span className="stem-track-label">{s.label}</span>
            <button
              className={`btn btn-ghost stem-solo-btn${solo === s.key ? ' active' : ''}`}
              onClick={() => handleSolo(s.key)}
              title={solo === s.key ? t('cover.unsolo') : t('playback.solo')}
            >
              S
            </button>
          </div>
          {urls[s.key] ? (
            <audio
              ref={(el) => { if (el) audioRefs.current[s.key] = el }}
              src={urls[s.key]}
              controls
              style={{ width: '100%', height: 32, marginTop: 6 }}
              preload="metadata"
            />
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{t('common.unavailable')}</div>
          )}
        </div>
      ))}
    </div>
  )
}
