import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'

export interface SongListItem {
  id:           string
  name:         string
  artist:       string | null
  duration:     number
  coverArtUrl:  string | null
  originalPath: string | null
}

type SortKey = 'title' | 'artist' | 'date'

interface Props {
  songs:         SongListItem[]
  activeSongId:  string | null
  playing:       boolean
  loading:       boolean
  onSelect:      (id: string) => void
  onRemove:      (id: string) => void
  onShowInFolder:(path: string) => void
  onAddFiles:    (files: FileList | null) => void
}

interface MenuState { songId: string; x: number; y: number }

export function SongList({
  songs, activeSongId, playing, loading, onSelect, onRemove, onShowInFolder, onAddFiles,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? songs.filter((s) => s.name.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q))
      : songs
    const list = [...filtered]
    // `date` preserves the original (add-order) sequence — songs already arrive in that order.
    if (sortKey === 'title') list.sort((a, b) => a.name.localeCompare(b.name))
    else if (sortKey === 'artist') list.sort((a, b) => (a.artist ?? '').localeCompare(b.artist ?? ''))
    return list
  }, [songs, query, sortKey])

  function openMenu(e: React.MouseEvent, songId: string): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ songId, x: e.clientX, y: e.clientY })
  }

  const menuSong = menu ? songs.find((s) => s.id === menu.songId) ?? null : null

  return (
    <aside
      className={`card pbm-songlist${dragging ? ' drag-over' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
      onDragOver={(e)  => { e.preventDefault(); setDragging(true) }}
      onDragLeave={()  => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); onAddFiles(e.dataTransfer.files) }}
    >
      <div className="pbm-panel-title">{t('playback.songs')}</div>
      <button className="btn btn-primary pbm-add-song" onClick={() => fileInputRef.current?.click()} disabled={loading}>
        {loading ? t('common.loading') : `+ ${t('playback.addSong')}`}
      </button>
      <input ref={fileInputRef} type="file" accept="audio/*" multiple style={{ display: 'none' }}
        onChange={(e) => onAddFiles(e.target.files)} />

      {songs.length > 0 && (
        <div className="pbm-song-filter-row">
          <input
            className="input pbm-song-search"
            value={query}
            placeholder={t('playback.filterSongs')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="select pbm-song-sort" value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label={t('playback.sortBy')}
          >
            <option value="date">{t('playback.sortDateAdded')}</option>
            <option value="title">{t('playback.sortTitle')}</option>
            <option value="artist">{t('playback.sortArtist')}</option>
          </select>
        </div>
      )}

      {songs.length === 0 ? (
        <div className="pbm-empty-hint">{t('playback.noSongs')}</div>
      ) : (
        <ul className="pbm-song-items">
          {visible.map((s) => {
            const active = s.id === activeSongId
            return (
              <li key={s.id} className="pbm-song-row">
                <button
                  className={`pbm-song-item${active ? ' active' : ''}`}
                  onClick={() => onSelect(s.id)}
                  onContextMenu={(e) => openMenu(e, s.id)}
                >
                  <span className="pbm-song-thumb">
                    {s.coverArtUrl
                      ? <img src={s.coverArtUrl} alt="" />
                      : <span className="pbm-song-thumb-placeholder">🎵</span>}
                    <span className="pbm-song-play-overlay" aria-hidden="true">▶</span>
                    {active && (
                      <span className={`pbm-eq${playing ? ' playing' : ''}`} aria-hidden="true">
                        <span /><span /><span />
                      </span>
                    )}
                  </span>
                  <span className="pbm-song-text">
                    <span className="pbm-song-name" title={s.name}>{s.name}</span>
                    <span className="pbm-song-meta">
                      <span className="pbm-song-artist" title={s.artist ?? undefined}>
                        {s.artist ?? t('playback.unknownArtist')}
                      </span>
                      <span className="pbm-song-dot">·</span>
                      <span>{formatDuration(s.duration)}</span>
                    </span>
                  </span>
                </button>
                <button className="qi-remove pbm-song-remove" onClick={() => onRemove(s.id)} title={t('playback.remove')}>×</button>
              </li>
            )
          })}
        </ul>
      )}

      {menu && menuSong && (
        <div className="pbm-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { onSelect(menuSong.id); setMenu(null) }}>{t('playback.ctxPlay')}</button>
          {menuSong.originalPath && (
            <button onClick={() => { onShowInFolder(menuSong.originalPath!); setMenu(null) }}>
              {t('playback.ctxShowInFolder')}
            </button>
          )}
          <button onClick={() => { onRemove(menuSong.id); setMenu(null) }}>{t('playback.ctxRemove')}</button>
        </div>
      )}
    </aside>
  )
}
