import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { textFromLyricsBlob, type LyricLine } from '../../utils/lrc'
import { fetchLyricsOnline, getCachedLyrics, setCachedLyrics, type LyricsSearchResult } from '../../utils/autoLyrics'

interface Props {
  lines:            LyricLine[]
  currentIndex:     number
  collapsed:        boolean
  onToggleCollapse: () => void
  onSeek:           (time: number) => void
  onImportFile:     (file: File) => void
  onImportLyrics:   (lines: LyricLine[]) => void
  songId:           string | null
  songTitle:        string
  songArtist:       string | null
  songDuration:     number
  onlineSearchAllowed: boolean
  // Ticket 43 §5 — the Settings-page "automatically fetch lyrics" toggle.
  autoLyricsEnabled: boolean
  coverArtUrl?:     string | null
}

type AutoStatus = 'idle' | 'searching' | 'found' | 'notfound'

const WINDOW = 30   // render current line ± WINDOW to cap DOM node count

function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function LyricsPanel({
  lines, currentIndex, collapsed, onToggleCollapse, onSeek, onImportFile, onImportLyrics,
  songId, songTitle, songArtist, songDuration, onlineSearchAllowed, autoLyricsEnabled, coverArtUrl,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [fontSize, setFontSize] = useState(16)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [dragging, setDragging] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

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

  // ── Automatic lyrics recognition (Ticket 43) ────────────────────────────
  // Runs once per newly-loaded song: a cache lookup first (instant on a
  // repeat play), then an online search if that misses. Never blocks
  // playback — this is a plain fire-and-forget effect — and backs off
  // entirely if the song already has lyrics (embedded, or a previous
  // manual/auto load), the user turned the feature off, or online lyrics
  // aren't part of the current plan.
  const [autoStatus, setAutoStatus] = useState<AutoStatus>('idle')
  const [showFoundBanner, setShowFoundBanner] = useState(false)
  const autoFetchedForRef = useRef<string | null>(null)
  const activeSongIdRef = useRef<string | null>(null)
  useEffect(() => { activeSongIdRef.current = songId }, [songId])

  useEffect(() => {
    setShowFoundBanner(false)
    if (!songId || autoFetchedForRef.current === songId) return
    autoFetchedForRef.current = songId

    if (lines.length > 0 || !autoLyricsEnabled || !onlineSearchAllowed || !songTitle.trim()) {
      setAutoStatus('idle')
      return
    }

    let cancelled = false
    setAutoStatus('searching')

    void (async () => {
      const stillCurrent = (): boolean => !cancelled && activeSongIdRef.current === songId

      const cached = await getCachedLyrics(songArtist, songTitle, songDuration)
      if (!stillCurrent()) return
      if (cached) {
        onImportLyrics(cached.lines)
        setAutoStatus('found')
        setShowFoundBanner(true)
        return
      }

      const found = await fetchLyricsOnline(songTitle, songArtist)
      if (!stillCurrent()) return
      if (found) {
        onImportLyrics(found.lines)
        void setCachedLyrics(songArtist, songTitle, songDuration, found.raw, found.source)
        setAutoStatus('found')
        setShowFoundBanner(true)
      } else {
        setAutoStatus('notfound')
      }
    })()

    return () => { cancelled = true }
    // Deliberately keyed on songId alone — this should fire exactly once per
    // song load, not re-run every time songTitle/songArtist/lines are
    // touched by the fetch's own onImportLyrics call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId])

  useEffect(() => {
    if (!showFoundBanner) return
    const timer = setTimeout(() => setShowFoundBanner(false), 3000)
    return () => clearTimeout(timer)
  }, [showFoundBanner])

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

  const effectiveCollapsed = collapsed && !fullscreen

  return (
    <div className={`card pbm-lyrics${effectiveCollapsed ? ' collapsed' : ''}${fullscreen ? ' fullscreen' : ''}${coverArtUrl ? ' has-backdrop' : ''} theme-${theme}`}>
      {coverArtUrl && <div className="pbm-lyrics-backdrop" style={{ backgroundImage: `url(${coverArtUrl})` }} />}
      <div className="pbm-lyrics-content">
      <div className="pbm-lyrics-header">
        <span className="pbm-panel-title" style={{ marginBottom: 0 }}>{t('playback.lyrics')}</span>
        <div className="row" style={{ gap: 6 }}>
          {(!collapsed || fullscreen) && (
            <>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFontSize((s) => Math.max(11, s - 2))}>A-</button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFontSize((s) => Math.min(28, s + 2))}>A+</button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setTheme((th) => th === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? '🌙' : '☀️'}
              </button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFullscreen((f) => !f)}
                title={fullscreen ? t('playback.exitFullscreen') : t('playback.enterFullscreen')}>
                {fullscreen ? '⤡' : '⤢'}
              </button>
            </>
          )}
          {!fullscreen && (
            <button className="btn btn-ghost pbm-mini-btn" onClick={onToggleCollapse}>
              {collapsed ? t('playback.expand') : t('playback.collapse')}
            </button>
          )}
        </div>
      </div>

      {!effectiveCollapsed && (
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

          {showFoundBanner && lines.length > 0 && (
            <div className="pbm-lyrics-auto-banner">{t('lyrics.auto.found')}</div>
          )}

          {lines.length === 0 ? (
            <div
              className={`pbm-lyrics-empty${dragging ? ' drag-over' : ''}`}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
            >
              {autoStatus === 'searching' ? (
                <div className="pbm-lyrics-auto-status">
                  <span className="sub-spinner pbm-lyrics-auto-spinner" aria-hidden="true" />
                  <span>{t('lyrics.auto.searching')}</span>
                </div>
              ) : autoStatus === 'notfound' ? (
                <>
                  <div className="view-desc">{t('lyrics.auto.notfound')}</div>
                  <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'center' }}>
                    <button className="btn btn-ghost" onClick={() => inputRef.current?.click()}>
                      {t('playback.importLrc')}
                    </button>
                    {onlineSearchAllowed && (
                      <button className="btn btn-ghost" onClick={openSearch}>
                        {t('playback.searchOnline')}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="view-desc">{t('playback.noLyrics')}</div>
                  <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => inputRef.current?.click()}>
                    {t('playback.importLrc')}
                  </button>
                </>
              )}
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
      </div>

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
