import { describe, expect, it } from 'vitest'
import {
  searchMock, normalizeSong, clampPage, clampPageSize, safeId, extensionFor,
  pseudoFrequency, makePlaceholderWav, MOCK_CATALOG, DEFAULT_PAGE_SIZE,
} from './library-search'

describe('searchMock()', () => {
  it('finds "浮夸" by an exact title keyword (Ticket 18 acceptance criterion)', () => {
    const { results, total } = searchMock('浮夸', 1, DEFAULT_PAGE_SIZE)
    expect(total).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ title: '浮夸', artist: '陈奕迅' })
  })

  it('matches case-insensitively against artist as well as title', () => {
    const { results } = searchMock('BEYOND', 1, DEFAULT_PAGE_SIZE)
    expect(results.map((r) => r.id)).toContain('lib-010')
  })

  it('returns the full catalog, first page, when the keyword is empty', () => {
    const { results, total, hasMore } = searchMock('', 1, DEFAULT_PAGE_SIZE)
    expect(total).toBe(MOCK_CATALOG.length)
    expect(results).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(hasMore).toBe(MOCK_CATALOG.length > DEFAULT_PAGE_SIZE)
  })

  it('paginates: page 2 picks up where page 1 left off, and hasMore reflects the tail', () => {
    const pageSize = 3
    const page1 = searchMock('', 1, pageSize)
    const page2 = searchMock('', 2, pageSize)
    expect(page1.results).toHaveLength(pageSize)
    expect(page1.hasMore).toBe(true)
    expect(page2.results.map((r) => r.id)).not.toEqual(page1.results.map((r) => r.id))

    const lastPage = Math.ceil(MOCK_CATALOG.length / pageSize)
    const tail = searchMock('', lastPage, pageSize)
    expect(tail.hasMore).toBe(false)
  })

  it('returns an empty page (not an error) past the end of the results', () => {
    const { results, hasMore } = searchMock('浮夸', 5, DEFAULT_PAGE_SIZE)
    expect(results).toEqual([])
    expect(hasMore).toBe(false)
  })

  it('finds nothing for an unmatched keyword', () => {
    const { results, total } = searchMock('nonexistent-song-xyz', 1, DEFAULT_PAGE_SIZE)
    expect(results).toEqual([])
    expect(total).toBe(0)
  })
})

describe('clampPage() / clampPageSize()', () => {
  it('defaults an invalid page to 1', () => {
    expect(clampPage(0)).toBe(1)
    expect(clampPage(-3)).toBe(1)
    expect(clampPage(undefined)).toBe(1)
    expect(clampPage(Number.NaN)).toBe(1)
  })

  it('defaults an invalid pageSize and caps an oversized one', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE)
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE)
    expect(clampPageSize(9999)).toBe(50)
  })

  it('floors fractional input', () => {
    expect(clampPage(2.9)).toBe(2)
    expect(clampPageSize(7.8)).toBe(7)
  })
})

describe('normalizeSong()', () => {
  it('passes through a well-formed remote row', () => {
    const song = normalizeSong({ id: 42, title: '浮夸', artist: '陈奕迅', original_key: 'F#m', audio_url: 'https://cdn.example.com/a.mp3' })
    expect(song).toEqual({
      id: '42', title: '浮夸', artist: '陈奕迅', original_key: 'F#m',
      audio_url: 'https://cdn.example.com/a.mp3', cover_url: null,
    })
  })

  it('defaults missing optional fields instead of throwing', () => {
    const song = normalizeSong({ id: 'x', title: 'Song' })
    expect(song).toEqual({ id: 'x', title: 'Song', artist: '', original_key: null, audio_url: '', cover_url: null })
  })

  // Ticket UI-08: covers arrive under several different names depending on
  // the catalogue, so normalizeSong accepts the common aliases.
  it('picks up cover art under any of the accepted field names', () => {
    for (const key of ['cover_url', 'coverUrl', 'pic_url', 'picUrl', 'album_art', 'cover']) {
      const song = normalizeSong({ id: '1', title: 'S', [key]: 'https://cdn/x.jpg' })
      expect(song?.cover_url).toBe('https://cdn/x.jpg')
    }
  })

  it('ignores a non-string or empty cover field', () => {
    expect(normalizeSong({ id: '1', title: 'S', cover_url: 42 })?.cover_url).toBeNull()
    expect(normalizeSong({ id: '1', title: 'S', cover_url: '' })?.cover_url).toBeNull()
  })

  it('rejects a row missing id or title', () => {
    expect(normalizeSong({ title: 'Song' })).toBeNull()
    expect(normalizeSong({ id: '1' })).toBeNull()
    expect(normalizeSong(null)).toBeNull()
    expect(normalizeSong('not an object')).toBeNull()
  })
})

describe('safeId()', () => {
  it('strips characters that are unsafe in a filename', () => {
    expect(safeId('lib-001')).toBe('lib-001')
    expect(safeId('song/with:weird?chars')).toBe('song_with_weird_chars')
  })

  it('falls back to a placeholder for an empty id', () => {
    expect(safeId('')).toBe('song')
  })
})

describe('extensionFor()', () => {
  it('prefers a recognizable extension already in the URL', () => {
    expect(extensionFor('https://cdn.example.com/track.flac?sig=abc', 'audio/mpeg')).toBe('flac')
  })

  it('falls back to content-type when the URL has no usable extension', () => {
    expect(extensionFor('https://cdn.example.com/stream', 'audio/ogg')).toBe('ogg')
    expect(extensionFor('https://cdn.example.com/stream', 'audio/mpeg')).toBe('mp3')
  })

  it('defaults to wav when nothing else matches', () => {
    expect(extensionFor('https://cdn.example.com/stream', null)).toBe('wav')
  })
})

describe('pseudoFrequency()', () => {
  it('is deterministic and stays within the 220-440 Hz range', () => {
    const f1 = pseudoFrequency('lib-001')
    const f2 = pseudoFrequency('lib-001')
    expect(f1).toBe(f2)
    expect(f1).toBeGreaterThanOrEqual(220)
    expect(f1).toBeLessThan(440)
  })

  it('varies across different ids (collisions are not the expectation)', () => {
    const freqs = new Set(MOCK_CATALOG.map((s) => pseudoFrequency(s.id)))
    expect(freqs.size).toBeGreaterThan(1)
  })
})

describe('makePlaceholderWav()', () => {
  it('writes a well-formed WAV header sized for the requested duration', () => {
    const sampleRate = 8000
    const buf = makePlaceholderWav(440, 1, sampleRate)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(buf.subarray(36, 40).toString('ascii')).toBe('data')
    const dataSize = buf.readUInt32LE(40)
    expect(dataSize).toBe(sampleRate * 2)   // 1 second, mono, 16-bit
    expect(buf.length).toBe(44 + dataSize)
  })
})
