/**
 * Cloud Library (云曲库) — Ticket 18.
 *
 * Pure, electron-free helpers for library.ts: the offline/dev fallback
 * catalog, its search + pagination, response normalization, and the
 * download-cache filename helpers. Split out from library.ts (which layers
 * the electron-touching bits — app.getPath()/app.getVersion(), real fetch
 * calls, disk writes — on top) so this logic is unit-testable under Vitest;
 * see vitest.config.ts's header comment for why anything importing
 * `electron` can't be.
 */

export interface LibrarySong {
  id:            string
  title:         string
  artist:        string
  original_key:  string | null
  audio_url:     string
}

export interface LibrarySearchResult {
  results:  LibrarySong[]
  page:     number
  pageSize: number
  total:    number
  hasMore:  boolean
}

export const DEFAULT_PAGE_SIZE = 10
export const MAX_PAGE_SIZE = 50

// ── Offline / dev fallback catalog ──────────────────────────────────────
// `audio_url` uses a `mock://` scheme rather than a real file — library.ts's
// fetchLibraryAudio() recognizes that scheme and synthesizes a short
// placeholder tone instead of downloading. A real catalog's rows carry
// ordinary https:// URLs and never take that path. Includes "浮夸" so the
// ticket's acceptance criterion ("searching 浮夸 returns relevant results")
// holds without any server configured.
export const MOCK_CATALOG: readonly LibrarySong[] = [
  { id: 'lib-001', title: '浮夸',     artist: '陈奕迅', original_key: 'F#m', audio_url: 'mock://lib-001' },
  { id: 'lib-002', title: '十年',     artist: '陈奕迅', original_key: 'C',   audio_url: 'mock://lib-002' },
  { id: 'lib-003', title: '好久不见', artist: '陈奕迅', original_key: 'G',   audio_url: 'mock://lib-003' },
  { id: 'lib-004', title: '晴天',     artist: '周杰伦', original_key: 'C',   audio_url: 'mock://lib-004' },
  { id: 'lib-005', title: '告白气球', artist: '周杰伦', original_key: 'F',   audio_url: 'mock://lib-005' },
  { id: 'lib-006', title: '演员',     artist: '薛之谦', original_key: 'Dm',  audio_url: 'mock://lib-006' },
  { id: 'lib-007', title: '光年之外', artist: '邓紫棋', original_key: 'Am',  audio_url: 'mock://lib-007' },
  { id: 'lib-008', title: '如果爱忘了', artist: '林俊杰', original_key: 'Eb', audio_url: 'mock://lib-008' },
  { id: 'lib-009', title: '起风了',   artist: '买辣椒也用券', original_key: 'C', audio_url: 'mock://lib-009' },
  { id: 'lib-010', title: '海阔天空', artist: 'Beyond', original_key: 'C',  audio_url: 'mock://lib-010' },
] as const

export function clampPage(page: unknown): number {
  const n = Math.floor(Number(page))
  return Number.isFinite(n) && n > 0 ? n : 1
}

export function clampPageSize(pageSize: unknown): number {
  const n = Math.floor(Number(pageSize))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, n)
}

export function searchMock(keyword: string, page: number, pageSize: number): LibrarySearchResult {
  const kw = keyword.trim().toLowerCase()
  const matched = kw
    ? MOCK_CATALOG.filter((s) => s.title.toLowerCase().includes(kw) || s.artist.toLowerCase().includes(kw))
    : MOCK_CATALOG
  const total = matched.length
  const start = (page - 1) * pageSize
  const results = matched.slice(start, start + pageSize)
  return { results: [...results], page, pageSize, total, hasMore: start + results.length < total }
}

/** Normalizes one row of a remote API response into a LibrarySong, or null if it's unusable. */
export function normalizeSong(raw: unknown): LibrarySong | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!o.id || !o.title) return null
  return {
    id:            String(o.id),
    title:         String(o.title),
    artist:        typeof o.artist === 'string' ? o.artist : '',
    original_key:  typeof o.original_key === 'string' ? o.original_key : null,
    audio_url:     typeof o.audio_url === 'string' ? o.audio_url : '',
  }
}

// ── Audio cache filename helpers ─────────────────────────────────────────

export const CACHE_EXTENSIONS = ['wav', 'flac', 'mp3', 'ogg', 'm4a'] as const

/** Sanitizes a song id into a filesystem-safe cache file stem. */
export function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'song'
}

export function extensionFor(url: string, contentType: string | null): string {
  const fromUrl = url.split('?')[0].split('.').pop()?.toLowerCase()
  if (fromUrl && (CACHE_EXTENSIONS as readonly string[]).includes(fromUrl)) return fromUrl
  if (contentType?.includes('flac')) return 'flac'
  if (contentType?.includes('mpeg') || contentType?.includes('mp3')) return 'mp3'
  if (contentType?.includes('ogg')) return 'ogg'
  return 'wav'
}

/** Deterministic per-song-id placeholder tone frequency (220–440 Hz). */
export function pseudoFrequency(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return 220 + (hash % 220)
}

/** Minimal mono 16-bit PCM WAV encoder — stands in for real audio in the offline fallback catalog. */
export function makePlaceholderWav(freqHz: number, durationSec: number, sampleRate = 44_100): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate)
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const fade = Math.min(1, t * 8, (durationSec - t) * 8) // quick in/out fade, avoids a click
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.2 * Math.max(0, fade)
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2)
  }
  return buf
}
