import { describe, expect, it } from 'vitest'
import {
  concatWithGaps, mergeAudioFiles, mergedFileName, mixToMono, resampleLinear,
  MERGE_GAP_SEC, MERGE_SAMPLE_RATE,
} from './mergeAudioFiles'

/** Minimal stand-in for the parts of AudioBuffer this module reads. */
function fakeBuffer(channels: number[][], sampleRate: number): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length:           channels[0].length,
    sampleRate,
    duration:         channels[0].length / sampleRate,
    getChannelData:   (i: number) => Float32Array.from(channels[i]),
  } as unknown as AudioBuffer
}

describe('mixToMono', () => {
  it('averages the channels', () => {
    const mono = mixToMono(fakeBuffer([[1, 0], [0, 1]], 8000))
    expect(Array.from(mono)).toEqual([0.5, 0.5])
  })

  it('copies a mono buffer rather than aliasing it', () => {
    const buffer = fakeBuffer([[0.25, 0.5]], 8000)
    const mono = mixToMono(buffer)
    mono[0] = 99
    expect(buffer.getChannelData(0)[0]).toBe(0.25)
  })
})

describe('resampleLinear', () => {
  it('leaves samples alone when the rate already matches', () => {
    const input = Float32Array.from([1, 2, 3])
    expect(resampleLinear(input, 22_050, 22_050)).toBe(input)
  })

  it('halves the length when halving the rate', () => {
    const input = Float32Array.from(Array.from({ length: 100 }, (_, i) => i / 100))
    expect(resampleLinear(input, 44_100, 22_050)).toHaveLength(50)
  })

  it('interpolates between neighbours instead of dropping samples', () => {
    const out = resampleLinear(Float32Array.from([0, 1]), 2, 3)
    expect(Array.from(out)).toEqual([0, 0.5, 1])
  })

  it('handles empty input', () => {
    expect(resampleLinear(new Float32Array(0), 44_100, 22_050)).toHaveLength(0)
  })
})

describe('concatWithGaps', () => {
  it('joins tracks with a silent gap between them', () => {
    const out = concatWithGaps([Float32Array.from([1, 1]), Float32Array.from([2, 2])], 4, 0.5)
    // 2 samples + 2 samples of gap (0.5s × 4Hz) + 2 samples
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 2, 2])
  })

  it('adds no trailing gap after the last track', () => {
    const out = concatWithGaps([Float32Array.from([1]), Float32Array.from([2])], 4, 0.25)
    expect(out).toHaveLength(1 + 1 + 1)
    expect(out.at(-1)).toBe(2)
  })

  it('skips empty tracks so they cannot contribute a stray gap', () => {
    const out = concatWithGaps([Float32Array.from([1]), new Float32Array(0)], 4, 0.25)
    expect(Array.from(out)).toEqual([1])
  })

  it('returns nothing for nothing', () => {
    expect(concatWithGaps([], 22_050)).toHaveLength(0)
  })
})

describe('mergedFileName', () => {
  it('names the result after the first take', () => {
    expect(mergedFileName('干音_1.wav')).toBe('干音_1_merged.wav')
    expect(mergedFileName('take.one.flac')).toBe('take.one_merged.wav')
    expect(mergedFileName('noext')).toBe('noext_merged.wav')
  })
})

describe('mergeAudioFiles', () => {
  const decode = (rate: number, samples: number[]) =>
    async (): Promise<AudioBuffer> => fakeBuffer([samples], rate)

  /**
   * jsdom's File has no arrayBuffer() (it predates the Blob method), and the
   * merge reads one per file, so fill it in here. The bytes never matter —
   * decoding is injected.
   */
  function wav(name: string): File {
    const file = new File([new Uint8Array(8)], name, { type: 'audio/wav' })
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(8) })
    }
    return file
  }

  it('folds every input into one file at the rate the trainer uses', async () => {
    const result = await mergeAudioFiles(
      [wav('a.wav'), wav('b.wav')],
      decode(MERGE_SAMPLE_RATE, Array.from({ length: MERGE_SAMPLE_RATE }, () => 0.1)),
    )
    expect(result.sourceCount).toBe(2)
    expect(result.file.name).toBe('a_merged.wav')
    expect(result.file.type).toBe('audio/wav')
    // Two 1s takes plus the gap between them; total duration is preserved.
    expect(result.duration).toBeCloseTo(2 + MERGE_GAP_SEC, 2)
  })

  it('refuses an empty selection rather than writing a silent file', async () => {
    await expect(mergeAudioFiles([], decode(MERGE_SAMPLE_RATE, [0])))
      .rejects.toThrow(/nothing to merge/)
  })

  it('propagates a decode failure so the caller can leave the selection intact', async () => {
    await expect(mergeAudioFiles([wav('bad.wav')], async () => { throw new Error('bad header') }))
      .rejects.toThrow('bad header')
  })
})
