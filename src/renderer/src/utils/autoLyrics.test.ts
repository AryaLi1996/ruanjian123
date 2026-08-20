import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanForFuzzyMatch,
  fetchLyricsOnline,
  getCachedLyrics,
  lyricsCacheKey,
  pickBestResult,
  setCachedLyrics,
  type LyricsSearchResult,
} from './autoLyrics'

function result(overrides: Partial<LyricsSearchResult> = {}): LyricsSearchResult {
  return {
    id: 1, trackName: 'Track', artistName: 'Artist', albumName: 'Album',
    duration: 200, instrumental: false, syncedLyrics: null, plainLyrics: null,
    ...overrides,
  }
}

describe('cleanForFuzzyMatch', () => {
  it('strips parenthetical remix/edition tags', () => {
    expect(cleanForFuzzyMatch('Song Title (Remastered 2011)')).toBe('Song Title')
  })

  it('strips bracketed tags', () => {
    expect(cleanForFuzzyMatch('Song Title [Radio Edit]')).toBe('Song Title')
  })

  it('strips a trailing "feat./ft." credit', () => {
    expect(cleanForFuzzyMatch('Song Title feat. Someone Else')).toBe('Song Title')
    expect(cleanForFuzzyMatch('Song Title ft Someone Else')).toBe('Song Title')
  })

  it('collapses punctuation to whitespace and trims', () => {
    expect(cleanForFuzzyMatch("Don't Stop - Believin'!!")).toBe('Don t Stop Believin')
  })

  it('keeps non-Latin text intact aside from punctuation', () => {
    expect(cleanForFuzzyMatch('晴天（钢琴版）')).toBe('晴天')
  })
})

describe('pickBestResult', () => {
  it('prefers a synced result over a plain-text one', () => {
    const plain = result({ id: 1, plainLyrics: 'plain' })
    const synced = result({ id: 2, syncedLyrics: '[00:01.00]synced' })
    expect(pickBestResult([plain, synced])).toBe(synced)
  })

  it('falls back to plain lyrics when nothing is synced', () => {
    const plain = result({ id: 1, plainLyrics: 'plain' })
    expect(pickBestResult([plain])).toBe(plain)
  })

  it('skips instrumental entries even if they claim lyrics', () => {
    const instrumental = result({ id: 1, instrumental: true, syncedLyrics: '[00:01.00]x' })
    expect(pickBestResult([instrumental])).toBeNull()
  })

  it('returns null for an empty result set', () => {
    expect(pickBestResult([])).toBeNull()
  })
})

describe('lyricsCacheKey', () => {
  it('is stable for the same normalized inputs', () => {
    expect(lyricsCacheKey('Artist', 'Title', 200.4))
      .toBe(lyricsCacheKey('  artist ', 'title', 200))
  })

  it('differs when artist, title, or duration differ', () => {
    const base = lyricsCacheKey('Artist', 'Title', 200)
    expect(lyricsCacheKey('Other', 'Title', 200)).not.toBe(base)
    expect(lyricsCacheKey('Artist', 'Other', 200)).not.toBe(base)
    expect(lyricsCacheKey('Artist', 'Title', 201)).not.toBe(base)
  })

  it('treats a null artist as its own stable bucket', () => {
    expect(lyricsCacheKey(null, 'Title', 200)).toBe(lyricsCacheKey('', 'Title', 200))
  })
})

describe('fetchLyricsOnline', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'window', {
      value: { engine: { searchLyrics: vi.fn() } },
      configurable: true,
      writable: true,
    })
  })

  it('returns the synced match from an exact-query search', async () => {
    const searchLyrics = vi.fn().mockResolvedValue([
      result({ syncedLyrics: '[00:01.00]hello' }),
    ])
    ;(globalThis as unknown as { window: { engine: { searchLyrics: typeof searchLyrics } } })
      .window.engine.searchLyrics = searchLyrics

    const match = await fetchLyricsOnline('Title', 'Artist')
    expect(match).not.toBeNull()
    expect(match?.source).toBe('lrclib')
    expect(match?.lines[0]).toMatchObject({ time: 1, text: 'hello' })
    expect(searchLyrics).toHaveBeenCalledTimes(1)
  })

  it('retries with a cleaned query when the exact query has no match', async () => {
    const searchLyrics = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([result({ syncedLyrics: '[00:02.00]retry hit' })])
    ;(globalThis as unknown as { window: { engine: { searchLyrics: typeof searchLyrics } } })
      .window.engine.searchLyrics = searchLyrics

    const match = await fetchLyricsOnline('Song (Remastered)', 'Artist feat. Someone')
    expect(match?.lines[0].text).toBe('retry hit')
    expect(searchLyrics).toHaveBeenCalledTimes(2)
    expect(searchLyrics.mock.calls[1][0]).toMatchObject({ track: 'Song' })
  })

  it('returns null when nothing matches on either pass', async () => {
    const searchLyrics = vi.fn().mockResolvedValue([])
    ;(globalThis as unknown as { window: { engine: { searchLyrics: typeof searchLyrics } } })
      .window.engine.searchLyrics = searchLyrics
    expect(await fetchLyricsOnline('Title', 'Artist')).toBeNull()
  })

  it('returns null (not a thrown error) when the search rejects', async () => {
    const searchLyrics = vi.fn().mockRejectedValue(new Error('offline'))
    ;(globalThis as unknown as { window: { engine: { searchLyrics: typeof searchLyrics } } })
      .window.engine.searchLyrics = searchLyrics
    await expect(fetchLyricsOnline('Title', 'Artist')).resolves.toBeNull()
  })

  it('returns null for a blank title without calling the network', async () => {
    const searchLyrics = vi.fn()
    ;(globalThis as unknown as { window: { engine: { searchLyrics: typeof searchLyrics } } })
      .window.engine.searchLyrics = searchLyrics
    expect(await fetchLyricsOnline('   ', 'Artist')).toBeNull()
    expect(searchLyrics).not.toHaveBeenCalled()
  })
})

describe('lyrics cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    Object.defineProperty(globalThis, 'window', {
      value: {
        engine: {
          lyricsCacheLoad: vi.fn().mockResolvedValue({}),
          lyricsCacheSave: vi.fn().mockResolvedValue(undefined),
        },
      },
      configurable: true,
      writable: true,
    })
  })

  it('round-trips a cached entry through set/get', async () => {
    await setCachedLyrics('Artist', 'Title', 200, '[00:03.00]cached line', 'lrclib')
    const found = await getCachedLyrics('Artist', 'Title', 200)
    expect(found?.lines[0]).toMatchObject({ time: 3, text: 'cached line' })
    expect(found?.source).toBe('lrclib')
  })

  it('misses for a different song', async () => {
    await setCachedLyrics('Artist', 'Title', 200, '[00:03.00]cached line', 'lrclib')
    expect(await getCachedLyrics('Artist', 'Other Title', 200)).toBeNull()
  })
})
