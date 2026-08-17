import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { textFromLyricsBlob, type LyricLine } from '../../utils/lrc'

interface LyricsSearchResult {
  id:            number
  trackName:     string
  artistName:    string
  albumName:     string
  duration:      number | null
  instrumental:  boolean
  syncedLyrics:  string | null
  plainLyrics:   string | null
}

interface Props {
  lines:            LyricLine[]
  currentIndex:     number
  collapsed:        boolean
  onToggleCollapse: () => void
  onSeek:           (time: number) => void
  onImportFile:     (file: File) => void
  onImportLyrics:   (lines: LyricLine[]) => void
  songTitle:        string
  onlineSearchAllowed: boolean
}

const WINDOW = 20   // render current line ± WINDOW to cap DOM node count

function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function LyricsPanel({
  lines, currentIndex, collapsed, onToggleCollapse, onSeek, onImportFile, onImportLyrics,
  songTitle, onlineSearchAllowed,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [fontSize, setFontSize] = useState(16)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [dragging, setDragging] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [artist, setArtist] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [results, setResults] = useState<LyricsSearchResult[] | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const activeLineRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  function openSearch(): void {
    setQuery(songTitle)
    setArtist('')
    setResults(null)
    setSearchError(false)
    setSearchOpen(true)
  }

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  async function runSearch(): Promise<void> {
    const track = query.trim()
    if (!track || searching) return
    setSearching(true)
    setSearchError(false)
    try {
      const found = await window.engine.searchLyrics({ track, artist: artist.trim() || undefined })
      setResults(found)
    } catch {
      setResults(null)
      setSearchError(true)
    } finally {
      setSearching(false)
    }
  }

  function useResult(result: LyricsSearchResult): void {
    const raw = result.syncedLyrics ?? result.plainLyrics ?? ''
    onImportLyrics(textFromLyricsBlob(raw))
    setSearchOpen(false)
  }

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentIndex])

  function handleFiles(files: FileList | null): void {
    const file = files?.[0]
    if (file && /\.lrc$/i.test(file.name)) onImportFile(file)
  }

  const start = Math.max(0, currentIndex - WINDOW)
  const end = Math.min(lines.length, currentIndex + WINDOW + 1)
  const visible = lines.slice(start, end)

  return (
    <div className={`card pbm-lyrics${collapsed ? ' collapsed' : ''} theme-${theme}`}>
      <div className="pbm-lyrics-header">
        <span className="pbm-panel-title" style={{ marginBottom: 0 }}>{t('playback.lyrics')}</span>
        <div className="row" style={{ gap: 6 }}>
          {!collapsed && (
            <>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFontSize((s) => Math.max(11, s - 2))}>A-</button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFontSize((s) => Math.min(28, s + 2))}>A+</button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setTheme((th) => th === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? '🌙' : '☀️'}
              </button>
            </>
          )}
          <button className="btn btn-ghost pbm-mini-btn" onClick={onToggleCollapse}>
            {collapsed ? t('playback.expand') : t('playback.collapse')}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => inputRef.current?.click()}>
              {t('playback.importLrc')}
            </button>
            <input ref={inputRef} type="file" accept=".lrc" style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)} />
            <button className="btn btn-ghost" disabled={!onlineSearchAllowed} title={
              onlineSearchAllowed ? undefined : t('playback.subscribeForSearch')
            } onClick={openSearch}>
              {t('playback.searchOnline')}
            </button>
          </div>

          {lines.length === 0 ? (
            <div
              className={`pbm-lyrics-empty${dragging ? ' drag-over' : ''}`}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
            >
              <div className="view-desc">{t('playback.noLyrics')}</div>
              <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => inputRef.current?.click()}>
                {t('playback.importLrc')}
              </button>
            </div>
          ) : (
            <div
              className="pbm-lyrics-list"
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
              style={{ fontSize }}
            >
              {start > 0 && <div className="pbm-lyrics-spacer" />}
              {visible.map((line, i) => {
                const idx = start + i
                const active = idx === currentIndex
                return (
                  <div
                    key={idx}
                    ref={active ? activeLineRef : undefined}
                    className={`pbm-lyrics-line${active ? ' active' : ''}`}
                    onClick={() => onSeek(line.time)}
                  >
                    <div className="pbm-lyrics-text">{line.text}</div>
                    {line.translation && <div className="pbm-lyrics-translation">{line.translation}</div>}
                  </div>
                )
              })}
              {end < lines.length && <div className="pbm-lyrics-spacer" />}
            </div>
          )}
        </>
      )}

      {searchOpen && (
        <div className="pbm-lyrics-search-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSearchOpen(false) }}>
          <div className="pbm-lyrics-search-card" role="dialog" aria-modal="true">
            <div className="pbm-lyrics-search-header">
              <span className="pbm-panel-title" style={{ marginBottom: 0 }}>{t('playback.searchLyricsTitle')}</span>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setSearchOpen(false)}>
                {t('playback.closeSearch')}
              </button>
            </div>

            <form className="row" style={{ gap: 8, marginBottom: 10 }} onSubmit={(e) => { e.preventDefault(); void runSearch() }}>
              <input ref={searchInputRef} className="input" style={{ flex: 2 }} value={query}
                placeholder={t('playback.searchQueryPlaceholder')}
                onChange={(e) => setQuery(e.target.value)} />
              <input className="input" style={{ flex: 1 }} value={artist}
                placeholder={t('playback.searchArtistPlaceholder')}
                onChange={(e) => setArtist(e.target.value)} />
              <button type="submit" className="btn btn-primary" disabled={searching || !query.trim()}>
                {searching ? t('playback.searching') : t('playback.search')}
              </button>
            </form>

            <div className="pbm-lyrics-search-results">
              {searchError && <div className="view-desc">{t('playback.searchError')}</div>}
              {!searchError && results?.length === 0 && <div className="view-desc">{t('playback.searchNoResults')}</div>}
              {results?.map((r) => (
                <div key={r.id} className="pbm-lyrics-search-result">
                  <div className="pbm-lyrics-search-result-info">
                    <div className="pbm-lyrics-search-result-title">{r.trackName}</div>
                    <div className="pbm-lyrics-search-result-meta">
                      {[r.artistName, r.albumName, formatDuration(r.duration)].filter(Boolean).join(' · ')}
                      {!r.instrumental && !r.syncedLyrics && r.plainLyrics && (
                        <span className="pbm-lyrics-search-tag"> {t('playback.unsynced')}</span>
                      )}
                      {r.instrumental && <span className="pbm-lyrics-search-tag"> {t('playback.instrumental')}</span>}
                    </div>
                  </div>
                  <button className="btn btn-ghost pbm-mini-btn" onClick={() => useResult(r)}>
                    {t('playback.useResult')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
