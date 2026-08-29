import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LibrarySong, LibraryDownloadProgress } from '../../global'

const PAGE_SIZE = 10
const DEBOUNCE_MS = 400

/**
 * FC-01: cache files are named after a sanitized song id — mirrors
 * main/library-search.ts's safeId(), which is what actually names them.
 * Renderer and main are separate TS programs (see global.d.ts's header), so
 * the rule is duplicated rather than imported; keep the two in step.
 */
function cacheKeyFor(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'song'
}

interface CloudLibraryModalProps {
  onClose:  () => void
  /** Called once the song's audio has finished downloading/caching, right before the modal closes. */
  onSelect: (song: LibrarySong, audioPath: string) => void
}

/**
 * "云曲库" search modal (Ticket 18). Debounced keyword search against
 * window.engine.searchLibrary (proxied through main — see main/library.ts),
 * with pagination and loading states. Selecting a result downloads its full
 * audio (cached by main so a repeat pick is instant) before handing control
 * back to the caller via onSelect.
 */
export function CloudLibraryModal({ onClose, onSelect }: CloudLibraryModalProps): JSX.Element {
  const { t } = useTranslation()

  const [keyword, setKeyword] = useState('')
  const [page,    setPage]    = useState(1)
  const [results, setResults] = useState<LibrarySong[]>([])
  const [total,   setTotal]   = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // FC-01: which songs already have a local copy ("本地就绪"), and how far
  // along the one currently downloading is.
  const [cachedKeys, setCachedKeys] = useState<Set<string>>(new Set())
  const [downloadPct, setDownloadPct] = useState<number | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Cache contents are read once per open: nothing else adds to the cache
  // while the modal is up except this modal's own downloads, which update
  // the set directly in handleSelect.
  useEffect(() => {
    let alive = true
    window.engine.listCachedLibraryIds()
      .then((ids) => { if (alive) setCachedKeys(new Set(ids)) })
      .catch(() => { /* the badge is a nicety — a failure here just shows none */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const unsub = window.engine.onLibraryDownloadProgress((p: LibraryDownloadProgress) => {
      setDownloadPct(p.percent)
    })
    return unsub
  }, [])

  // Debounced search — fires on keyword change, and again whenever page
  // changes (pagination clicks call runSearch directly, but this also
  // covers it so the two stay in sync with a single source of truth).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void runSearch(keyword, page) }, DEBOUNCE_MS)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, page])

  async function runSearch(kw: string, pg: number): Promise<void> {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await window.engine.searchLibrary(kw, pg, PAGE_SIZE)
      if (requestId !== requestIdRef.current) return   // a newer keystroke/page superseded this request
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
  }

  function handleKeywordChange(value: string): void {
    setKeyword(value)
    setPage(1)   // any new search starts back at page 1
  }

  async function handleSelect(song: LibrarySong): Promise<void> {
    setDownloadError(null)
    setDownloadingId(song.id)
    setDownloadPct(null)
    try {
      const { path } = await window.engine.fetchLibraryAudio(song)
      setCachedKeys((prev) => new Set(prev).add(cacheKeyFor(song.id)))
      onSelect(song, path)
    } catch (err) {
      setDownloadError(String(err))
    } finally {
      setDownloadingId(null)
      setDownloadPct(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="library-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="library-modal-card" role="dialog" aria-modal="true" aria-label={t('library.title')}>
        <div className="library-modal-header">
          <span className="pbm-panel-title" style={{ marginBottom: 0 }}>☁️ {t('library.title')}</span>
          <button className="btn btn-ghost pbm-mini-btn" onClick={onClose}>{t('library.close')}</button>
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <input
            ref={inputRef}
            className="input"
            value={keyword}
            placeholder={t('library.searchPlaceholder')}
            onChange={(e) => handleKeywordChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (debounceRef.current) clearTimeout(debounceRef.current)
              void runSearch(keyword, page)
            }}
          />
        </div>

        {downloadError && <div className="error-banner" style={{ marginBottom: 10 }}>{downloadError}</div>}

        <div className="library-modal-results">
          {loading && <div className="view-desc">{t('library.searching')}</div>}
          {!loading && error && <div className="view-desc">{t('library.searchError')}</div>}
          {!loading && !error && results.length === 0 && (
            <div className="view-desc">{keyword.trim() ? t('library.noResults') : t('library.emptyPrompt')}</div>
          )}
          {!loading && !error && results.map((song) => {
            const cached      = cachedKeys.has(cacheKeyFor(song.id))
            const downloading = downloadingId === song.id
            return (
              <div key={song.id} className="library-modal-result">
                <div className="library-modal-result-info">
                  <div className="library-modal-result-title">{song.title}</div>
                  <div className="library-modal-result-meta">
                    {[song.artist, song.original_key ? `Key: ${song.original_key}` : null].filter(Boolean).join(' · ')}
                  </div>
                  {downloading && (
                    <>
                      <div className="library-modal-result-meta">
                        {downloadPct !== null && downloadPct >= 0
                          ? t('library.downloadingPercent', { percent: downloadPct })
                          : t('library.downloadingResource')}
                      </div>
                      <div className="library-download-bar">
                        <div
                          className={`library-download-bar-fill${downloadPct === null || downloadPct < 0 ? ' indeterminate' : ''}`}
                          style={downloadPct !== null && downloadPct >= 0 ? { width: `${downloadPct}%` } : undefined}
                        />
                      </div>
                    </>
                  )}
                </div>
                {cached && !downloading && (
                  <span className="library-cached-badge">✓ {t('library.localReady')}</span>
                )}
                <button
                  className="btn btn-primary pbm-mini-btn"
                  disabled={downloadingId !== null}
                  onClick={() => void handleSelect(song)}
                >
                  {downloading ? t('library.downloading') : t('library.select')}
                </button>
              </div>
            )
          })}
        </div>

        {!loading && !error && total > PAGE_SIZE && (
          <div className="library-modal-pagination">
            <button
              className="btn btn-ghost pbm-mini-btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹ {t('library.prevPage')}
            </button>
            <span className="library-modal-page-info">{t('library.pageOf', { page, totalPages })}</span>
            <button
              className="btn btn-ghost pbm-mini-btn"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('library.nextPage')} ›
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
