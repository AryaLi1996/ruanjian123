import { describe, expect, it } from 'vitest'
import { parseArtistTitleFromFilename } from './metadata'

describe('parseArtistTitleFromFilename', () => {
  it('splits a single "Artist - Title" separator', () => {
    expect(parseArtistTitleFromFilename('Sheryl Crow - Soak Up the Sun.mp3'))
      .toEqual({ artist: 'Sheryl Crow', title: 'Soak Up the Sun' })
  })

  it('strips the extension before splitting', () => {
    expect(parseArtistTitleFromFilename('Artist - Title.flac').title).toBe('Title')
  })

  it('falls back to the bare filename (no artist) when there is no dash', () => {
    expect(parseArtistTitleFromFilename('Just A Title.wav'))
      .toEqual({ artist: null, title: 'Just A Title' })
  })

  it('declines to guess when there is more than one dash-separated segment', () => {
    expect(parseArtistTitleFromFilename('Artist - Title - Remix.mp3'))
      .toEqual({ artist: null, title: 'Artist - Title - Remix' })
  })

  it('requires surrounding whitespace around the dash (not a hyphenated word)', () => {
    expect(parseArtistTitleFromFilename('co-writer.mp3'))
      .toEqual({ artist: null, title: 'co-writer' })
  })
})
