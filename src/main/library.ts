/**
 * Cloud Library (云曲库) — Ticket 18.
 *
 * Backs the "search a song, pick it, load its full audio (with original
 * vocals) as the cover-synthesis target" flow. Two responsibilities:
 *
 *  - searchLibrary(): GET /api/library/search?keyword=&page=&pageSize= against
 *    a real catalog service, matching the ticket's response shape
 *    ([{ id, title, artist, original_key, audio_url }]).
 *  - fetchLibraryAudio(): downloads a selected song's full audio once and
 *    caches it under userData, so re-selecting the same song (or reopening
 *    the app) never re-downloads.
 *
 * No real catalog backend ships with this template (same situation as
 * license-config.ts's payment provider — see that file's header comment).
 * Until CLOUD_LIBRARY_API_URL is set, both functions fall back to
 * library-search.ts's built-in catalog so the feature is fully exercisable
 * offline: search, pagination, selection, and audio caching all work end to
 * end, with synthesized placeholder tones standing in for real audio.
 *
 * The pure catalog/normalization/filename logic lives in library-search.ts
 * (no `electron` import, so it's unit-testable — see that file's header);
 * this file only adds the electron-touching orchestration: the real HTTP
 * call, and reading/writing the on-disk cache under userData.
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import {
  searchMock, normalizeSong, clampPage, clampPageSize, safeId, extensionFor,
  pseudoFrequency, makePlaceholderWav, CACHE_EXTENSIONS,
  type LibrarySong, type LibrarySearchResult,
} from './library-search'

export type { LibrarySong, LibrarySearchResult } from './library-search'

// Set CLOUD_LIBRARY_API_URL to point at a real deployment of the ticket's
// GET /api/library/search endpoint. Nothing else in this file (or the IPC
// handler / renderer code that calls it) needs to change to switch modes.
const LIBRARY_API_URL = process.env['CLOUD_LIBRARY_API_URL'] ?? ''

// ── Search ───────────────────────────────────────────────────────────────

export async function searchLibrary(
  keyword: string, page?: number, pageSize?: number
): Promise<LibrarySearchResult> {
  const kw = (keyword ?? '').trim()
  const safePage = clampPage(page)
  const safePageSize = clampPageSize(pageSize)

  return LIBRARY_API_URL
    ? searchRemote(kw, safePage, safePageSize)
    : searchMock(kw, safePage, safePageSize)
}

async function searchRemote(keyword: string, page: number, pageSize: number): Promise<LibrarySearchResult> {
  const params = new URLSearchParams({ keyword, page: String(page), pageSize: String(pageSize) })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`${LIBRARY_API_URL.replace(/\/+$/, '')}/api/library/search?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': `SootheVoice/${app.getVersion()} (Cloud Library search)` },
    })
    if (!res.ok) throw new Error(`cloud library responded ${res.status}`)
    const data: unknown = await res.json()

    // Accept either a bare array (the ticket's literal response shape) or a
    // paginated envelope ({ results, total, ... }) from a real server.
    const isArray = Array.isArray(data)
    const rows: unknown[] = isArray
      ? data
      : Array.isArray((data as Record<string, unknown> | null)?.results)
        ? (data as { results: unknown[] }).results
        : []
    const results = rows.map(normalizeSong).filter((s): s is LibrarySong => s !== null)
    const total = isArray ? results.length : Number((data as Record<string, unknown>)?.total ?? results.length)
    return {
      results, page, pageSize,
      total:   Number.isFinite(total) ? total : results.length,
      hasMore: isArray ? false : page * pageSize < total,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ── Audio download + cache ──────────────────────────────────────────────

function cacheDir(): string {
  return join(app.getPath('userData'), 'library-cache')
}

async function findCached(dir: string, id: string): Promise<string | null> {
  for (const ext of CACHE_EXTENSIONS) {
    const p = join(dir, `${id}.${ext}`)
    if (existsSync(p)) return p
  }
  return null
}

export async function fetchLibraryAudio(song: LibrarySong): Promise<{ path: string; cached: boolean }> {
  const dir = cacheDir()
  await fs.mkdir(dir, { recursive: true })
  const id = safeId(song.id)

  // A song's id is stable across searches, so a repeat selection (or a
  // second cover-creation session) reuses whatever's already on disk instead
  // of re-downloading.
  const existing = await findCached(dir, id)
  if (existing) return { path: existing, cached: true }

  if (song.audio_url.startsWith('mock://')) {
    const path = join(dir, `${id}.wav`)
    await fs.writeFile(path, makePlaceholderWav(pseudoFrequency(id), 8))
    return { path, cached: false }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(song.audio_url, { signal: controller.signal })
    if (!res.ok) throw new Error(`audio download responded ${res.status}`)
    const ext = extensionFor(song.audio_url, res.headers.get('content-type'))
    const path = join(dir, `${id}.${ext}`)
    await fs.writeFile(path, Buffer.from(await res.arrayBuffer()))
    return { path, cached: false }
  } finally {
    clearTimeout(timeout)
  }
}
