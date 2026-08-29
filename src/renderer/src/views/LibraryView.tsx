import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { placeholderCover } from '../utils/coverArt'
import type { LibrarySong } from '../global'

const PAGE_SIZE   = 12
const DEBOUNCE_MS = 400
/** Skeleton tiles shown while a search is in flight. */
const SKELETON_COUNT = 8

/**
 * "云曲库" search page (Ticket UI-08).
 *
 * The same search this app already did in a modal (Ticket 18), promoted to
 * a full page and re-laid-out as a cover grid. Selecting a result downloads
 * and caches its audio (main/library.ts) and sets it as the global target
 * song, which the status pin in the top bar then reflects.
 */
export function LibraryView(): JSX.Element {
  const { t } = useTranslation()
  const targetSong    = useAppStore((s) => s.targetSong)
  const setTargetSong = useAppStore((s) => s.setTargetSong)

  const [keyword, setKeyword] = useState('')
  const [page,    setPage]    = useState(1)
  const [results, setResults] = useState<LibrarySong[]>([])
  const [total,   setTotal]   = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)
  const inputRef     = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const runSearch = useCallback(async (kw: string, pg: number): Promise<void> => {
    // Every request carries a ticket; a stale response (a superseded
    // keystroke or page click) is dropped rather than overwriting newer
    // results out of order.
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await window.engine.searchLibrary(kw, pg, PAGE_SIZE)
      if (requestId !== requestIdRef.current) return
      setResults(res.results)
      setTotal(res.total)
      setHasMore(res.hasMore)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(String(err))
      setResults([])
      setHasMore(false)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void runSearch(keyword, page) }, DEBOUNCE_MS)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, page, runSearch])

  async function handleSelect(song: LibrarySong): Promise<void> {
    setDownloadError(null)
    setDownloadingId(song.id)
    try {
      const { path } = await window.engine.fetchLibraryAudio(song)
      setTargetSong({
        id:               song.id,
        title:            song.title,
        artist:           song.artist,
        originalKey:      song.original_key,
        audioPath:        path,
        // FC-01: kept so separation can re-fetch the audio if this cache
        // entry is gone by then — see CoverView's ensureTargetSongAudio.
        audioUrl:         song.audio_url,
        coverUrl:         song.cover_url,
        pitchShift:       0,
        shiftedAudioPath: null,
      })
    } catch (err) {
      setDownloadError(String(err))
    } finally {
      setDownloadingId(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showEmpty  = !loading && !error && results.length === 0

  return (
    <div className="lib-view">
      <div className="view-header">
        <h1 className="view-title">☁️ {t('library.title')}</h1>
        <p className="view-desc">{t('library.pageDescription')}</p>
      </div>

      {/* Rounded search field with a leading icon and a clear button. */}
      <div className="lib-search">
        <span className="lib-search-icon" aria-hidden="true">🔍</span>
        <input
          ref={inputRef}
          className="lib-search-input"
          value={keyword}
          placeholder={t('library.searchPlaceholder')}
          aria-label={t('library.searchPlaceholder')}
          onChange={(e) => { setKeyword(e.target.value); setPage(1) }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            if (debounceRef.current) clearTimeout(debounceRef.current)
            void runSearch(keyword, page)
          }}
        />
        {keyword && (
          <button
            type="button"
            className="lib-search-clear"
            onClick={() => { setKeyword(''); setPage(1); inputRef.current?.focus() }}
            aria-label={t('library.clearSearch')}
            title={t('library.clearSearch')}
          >
            ✕
          </button>
        )}
      </div>

      {downloadError && <div className="error-banner">{downloadError}</div>}
      {!loading && error && <div className="error-banner">{t('library.searchError')}</div>}

      {loading && (
        <div className="lib-grid" aria-busy="true" aria-label={t('library.searching')}>
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <div key={i} className="lib-card lib-card-skeleton" aria-hidden="true">
              <div className="lib-cover lib-skel" />
              <div className="lib-skel lib-skel-line" />
              <div className="lib-skel lib-skel-line short" />
            </div>
          ))}
        </div>
      )}

      {showEmpty && (
        <div className="lib-empty">
          <div className="lib-empty-icon" aria-hidden="true">{keyword.trim() ? '🔍' : '☁️'}</div>
          <p className="view-desc">{keyword.trim() ? t('library.noResults') : t('library.emptyPrompt')}</p>
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="lib-grid">
          {results.map((song) => {
            const selected    = targetSong?.id === song.id
            const downloading = downloadingId === song.id
            const cover       = placeholderCover(song.id, song.title)
            return (
              <div key={song.id} className={`lib-card${selected ? ' selected' : ''}`}>
                <div className="lib-cover" style={song.cover_url ? undefined : { background: cover.gradient }}>
                  {song.cover_url
                    ? <img src={song.cover_url} alt="" loading="lazy" />
                    : <span className="lib-cover-initial" aria-hidden="true">{cover.initial}</span>}

                  <div className="lib-cover-overlay">
                    <button
                      type="button"
                      className="lib-select-btn"
                      onClick={() => void handleSelect(song)}
                      disabled={downloadingId !== null}
                      aria-label={t('library.selectSong', { title: song.title })}
                    >
                      {downloading
                        ? <><span className="at-spinner" aria-hidden="true" /> {t('library.downloading')}</>
                        : t('library.select')}
                    </button>
                  </div>

                  {selected && <span className="lib-selected-badge" aria-hidden="true">✓</span>}
                </div>

                <div className="lib-card-title" title={song.title}>{song.title}</div>
                <div className="lib-card-artist" title={song.artist}>{song.artist || '—'}</div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && !error && total > PAGE_SIZE && (
        <div className="lib-pagination">
          <button
            className="btn btn-ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ‹ {t('library.prevPage')}
          </button>
          <span className="lib-page-info">{t('library.pageOf', { page, totalPages })}</span>
          <button
            className="btn btn-ghost"
            disabled={!hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('library.nextPage')} ›
          </button>
        </div>
      )}
    </div>
  )
}
