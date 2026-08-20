// Automatic lyrics recognition (Ticket 43) — client-side fetcher + local
// cache that sit on top of the existing window.engine.searchLyrics IPC
// (main/index.ts's 'lyrics:search' handler, which proxies lrclib.org). This
// module adds what's new for Ticket 43: a 5s timeout, a fuzzy-query retry,
// best-result selection, and a durable cache keyed by artist+title+duration
// so a repeat play never re-queries the network.
import { textFromLyricsBlob, type LyricLine } from './lrc'

export interface LyricsSearchResult {
  id:            number
  trackName:     string
  artistName:    string
  albumName:     string
  duration:      number | null
  instrumental:  boolean
  syncedLyrics:  string | null
  plainLyrics:   string | null
}

export interface AutoLyricsMatch {
  lines:  LyricLine[]
  raw:    string    // the raw LRC/plain blob, as returned by the source — what gets cached
  source: string    // e.g. 'lrclib'
}

const SEARCH_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lyrics search timed out')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Strips remix/edition tags, "feat./ft." credits, and punctuation noise from
 * a title or artist string, so a second, looser search still has a shot at
 * matching a track whose metadata doesn't line up exactly with what the
 * lyrics source has on file (Ticket 43 §2: "ignore punctuation, remix tags,
 * featuring artists").
 */
export function cleanForFuzzyMatch(text: string): string {
  return text
    .replace(/[(（][^)）]*[)）]/g, ' ')          // (Remastered 2011), （钢琴版）, ...
    .replace(/[[【][^\]】]*[\]】]/g, ' ')        // [Explicit], 【Live】, ...
    .replace(/\b(feat|ft|featuring)\.?\s+.+$/i, ' ')  // feat./ft. Some Artist
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')         // remaining punctuation → space (any language)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Prefers a synced result over a plain-text one, and skips instrumental (no-lyrics) entries. */
export function pickBestResult(results: LyricsSearchResult[]): LyricsSearchResult | null {
  const synced = results.find((r) => !r.instrumental && r.syncedLyrics?.trim())
  if (synced) return synced
  return results.find((r) => !r.instrumental && r.plainLyrics?.trim()) ?? null
}

async function searchOnce(track: string, artist: string | undefined): Promise<LyricsSearchResult[]> {
  const results = await withTimeout(window.engine.searchLyrics({ track, artist }), SEARCH_TIMEOUT_MS)
  return results as LyricsSearchResult[]
}

/**
 * Looks up synced (preferred) or plain lyrics for a track: first with the
 * metadata as given, then — only if that comes up empty — with a cleaned,
 * fuzzy query. Returns null on no match, timeout, or network failure;
 * callers treat all three the same way (fall back to manual import/search).
 */
export async function fetchLyricsOnline(title: string, artist: string | null): Promise<AutoLyricsMatch | null> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) return null
  const trimmedArtist = artist?.trim() || undefined

  try {
    let best = pickBestResult(await searchOnce(trimmedTitle, trimmedArtist))

    if (!best) {
      const cleanTitle = cleanForFuzzyMatch(trimmedTitle)
      const cleanArtist = trimmedArtist ? cleanForFuzzyMatch(trimmedArtist) : ''
      const changed = cleanTitle !== trimmedTitle || cleanArtist !== (trimmedArtist ?? '')
      if (cleanTitle && changed) {
        best = pickBestResult(await searchOnce(cleanTitle, cleanArtist || undefined))
      }
    }

    if (!best) return null
    const raw = best.syncedLyrics ?? best.plainLyrics ?? ''
    if (!raw.trim()) return null
    return { lines: textFromLyricsBlob(raw), raw, source: 'lrclib' }
  } catch {
    return null   // timeout / offline / malformed response — treated as "not found"
  }
}

// ── Local cache (Ticket 43 §4) ──────────────────────────────────────────────
// Keyed by a hash of artist+title+duration and backed by main/lyrics-cache.ts
// (userData/lyrics-cache.json) via window.engine.lyricsCacheLoad/Save.

interface LyricsCacheEntry {
  raw:      string
  source:   string
  cachedAt: number
}

const MAX_CACHE_ENTRIES = 500
const CACHE_SAVE_DEBOUNCE_MS = 400

/** Small non-cryptographic hash (FNV-1a) — a stable, compact cache key, no crypto.subtle await needed. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Cache key: a hash of normalized artist + title + rounded duration (Ticket 43 §4). */
export function lyricsCacheKey(artist: string | null, title: string, durationSec: number): string {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return fnv1a(`${norm(artist ?? '')}|${norm(title)}|${Math.round(durationSec)}`)
}

let cachePromise: Promise<Map<string, LyricsCacheEntry>> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function getCache(): Promise<Map<string, LyricsCacheEntry>> {
  if (!cachePromise) {
    cachePromise = window.engine.lyricsCacheLoad()
      .then((obj) => new Map(Object.entries(obj ?? {})))
      .catch(() => new Map())
  }
  return cachePromise
}

function scheduleSave(cache: Map<string, LyricsCacheEntry>): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void window.engine.lyricsCacheSave(Object.fromEntries(cache)).catch(() => {})
  }, CACHE_SAVE_DEBOUNCE_MS)
}

/** Reads a cached match, if any — a repeat play of the same song loads instantly, no network round-trip. */
export async function getCachedLyrics(
  artist: string | null, title: string, durationSec: number,
): Promise<AutoLyricsMatch | null> {
  const cache = await getCache()
  const entry = cache.get(lyricsCacheKey(artist, title, durationSec))
  if (!entry) return null
  return { lines: textFromLyricsBlob(entry.raw), raw: entry.raw, source: entry.source }
}

/** Stores a freshly-fetched match, evicting the oldest entries once the 500-entry cap is exceeded. */
export async function setCachedLyrics(
  artist: string | null, title: string, durationSec: number, raw: string, source: string,
): Promise<void> {
  const cache = await getCache()
  cache.set(lyricsCacheKey(artist, title, durationSec), { raw, source, cachedAt: Date.now() })
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)
    for (let i = 0; i < cache.size - MAX_CACHE_ENTRIES; i++) cache.delete(oldest[i][0])
  }
  scheduleSave(cache)
}
