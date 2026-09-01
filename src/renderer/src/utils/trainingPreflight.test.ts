import { describe, expect, it } from 'vitest'
import {
  checkTrainingInputs, estimateTrainingMemoryGb, isEngineReadable,
  LONG_TOTAL_SEC, MANY_FILES_COUNT, MIN_CHUNK_SEC, suggestRemovals,
  type PreflightInput, type TrainingFileInfo,
} from './trainingPreflight'

const MB = 1024 * 1024

function file(name: string, duration: number | null, sizeMb = 10): TrainingFileInfo {
  return { name, sizeBytes: sizeMb * MB, duration }
}

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    files: [file('a.wav', 600), file('b.wav', 600)],
    mode: 'standard',
    deviceMode: 'gpu',
    device: { gpu_available: true, training_device: 'cuda' },
    availableRamGb: 16,
    ...over,
  }
}

/** Severity of the row with this id, or undefined when the row isn't shown. */
function severity(result: ReturnType<typeof checkTrainingInputs>, id: string): string | undefined {
  return result.items.find((i) => i.id === id)?.severity
}

describe('isEngineReadable', () => {
  it('accepts what engine/trainer.py reads', () => {
    for (const name of ['a.wav', 'B.FLAC', 'c.ogg', 'd.mp3']) {
      expect(isEngineReadable(name)).toBe(true)
    }
  })

  it('rejects .m4a, which the dropzone accepts but the engine skips silently', () => {
    expect(isEngineReadable('vocal.m4a')).toBe(false)
    expect(isEngineReadable('no-extension')).toBe(false)
  })
})

describe('estimateTrainingMemoryGb', () => {
  it('adds the fixed working-set allowance on top of the upload', () => {
    expect(estimateTrainingMemoryGb(0)).toBe(2)
    expect(estimateTrainingMemoryGb(2 * 1024 ** 3)).toBeCloseTo(5, 5)
  })
})

describe('checkTrainingInputs', () => {
  it('passes a clean GPU run with enough material', () => {
    const result = checkTrainingInputs(input())
    expect(result.canProceed).toBe(true)
    expect(result.cpuProfessional).toBe(false)
    expect(result.items.every((i) => i.severity === 'ok')).toBe(true)
  })

  it('blocks formats the engine cannot read', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', 600), file('b.m4a', 600)] }))
    expect(severity(result, 'format')).toBe('blocker')
    expect(result.canProceed).toBe(false)
    expect(result.items[0].params.names).toBe('b.m4a')
  })

  it('blocks duplicate names, which overwrite each other on save', () => {
    const result = checkTrainingInputs(input({ files: [file('干音.wav', 600), file('干音.wav', 600)] }))
    expect(severity(result, 'duplicateNames')).toBe('blocker')
    expect(result.canProceed).toBe(false)
  })

  it('warns when some clips are shorter than one training chunk', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', 600), file('b.wav', 1)] }))
    expect(severity(result, 'chunkable')).toBe('warning')
    expect(result.canProceed).toBe(true)
  })

  it('blocks when every clip is too short to produce any chunk', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', 1), file('b.wav', 2)] }))
    expect(severity(result, 'chunkable')).toBe('blocker')
    expect(result.canProceed).toBe(false)
  })

  it('treats exactly one chunk of audio as usable', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', MIN_CHUNK_SEC)] }))
    expect(severity(result, 'chunkable')).toBeUndefined()
  })

  it('warns below the mode-specific recommended duration', () => {
    const short = checkTrainingInputs(input({ files: [file('a.wav', 200)] }))
    expect(severity(short, 'duration')).toBe('warning')

    // 6 minutes clears standard mode's 5 but not professional mode's 15.
    const forStandard = checkTrainingInputs(input({ files: [file('a.wav', 360)] }))
    expect(severity(forStandard, 'duration')).toBe('ok')
    const forPro = checkTrainingInputs(input({ files: [file('a.wav', 360)], mode: 'professional' }))
    expect(severity(forPro, 'duration')).toBe('warning')
  })

  it('warns when no material was uploaded at all (synthetic-data run)', () => {
    const result = checkTrainingInputs(input({ files: [] }))
    expect(severity(result, 'duration')).toBe('warning')
    expect(result.canProceed).toBe(true)
  })

  it('warns when the estimated memory exceeds what is free', () => {
    const result = checkTrainingInputs(input({
      files: [file('a.wav', 600, 4096)], availableRamGb: 4,
    }))
    expect(severity(result, 'memory')).toBe('warning')
    // Advisory, not a blocker: the estimate is coarse and the user can act on it.
    expect(result.canProceed).toBe(true)
  })

  it('reports unknown memory rather than assuming it is fine', () => {
    const result = checkTrainingInputs(input({ availableRamGb: null }))
    expect(severity(result, 'memory')).toBe('warning')
    expect(result.items.find((i) => i.id === 'memory')?.messageKey)
      .toBe('preflight.memory.unknown')
  })

  it('flags a professional run that will land on the CPU', () => {
    const result = checkTrainingInputs(input({ mode: 'professional', deviceMode: 'cpu' }))
    expect(result.cpuProfessional).toBe(true)
    expect(result.items.find((i) => i.id === 'device')?.messageKey)
      .toBe('preflight.cpuProfessional.warn')
  })

  it('treats GPU mode without a usable GPU as a CPU run', () => {
    const result = checkTrainingInputs(input({
      mode: 'professional', deviceMode: 'gpu', device: { gpu_available: false },
    }))
    expect(result.cpuProfessional).toBe(true)
  })

  it('warns about the plain CPU slowdown outside professional mode', () => {
    const result = checkTrainingInputs(input({ deviceMode: 'cpu' }))
    expect(result.cpuProfessional).toBe(false)
    expect(result.items.find((i) => i.id === 'device')?.messageKey).toBe('preflight.device.cpu')
  })

  it('lists blockers before warnings before passes', () => {
    const result = checkTrainingInputs(input({
      files: [file('a.m4a', 600), file('b.wav', 10)],
      deviceMode: 'cpu', mode: 'professional', availableRamGb: 16,
    }))
    const order = result.items.map((i) => i.severity)
    expect(order).toEqual([...order].sort((a, b) =>
      ({ blocker: 0, warning: 1, ok: 2 })[a] - ({ blocker: 0, warning: 1, ok: 2 })[b]))
  })
})

/** The row with this id, or undefined when it isn't shown. */
function row(result: ReturnType<typeof checkTrainingInputs>, id: string) {
  return result.items.find((i) => i.id === id)
}

describe('suggestRemovals — Ticket P4', () => {
  it('removes the longest files first, and only as many as it takes', () => {
    const files = [file('short.wav', 60), file('long.wav', 600), file('mid.wav', 300)]
    expect(suggestRemovals(files, 400).map((f) => f.name)).toEqual(['long.wav'])
  })

  it('keeps going while the total is still over the target', () => {
    const files = [file('a.wav', 600), file('b.wav', 600), file('c.wav', 60)]
    expect(suggestRemovals(files, 300).map((f) => f.name)).toEqual(['a.wav', 'b.wav'])
  })

  it('never suggests emptying the dropzone', () => {
    const files = [file('a.wav', 600), file('b.wav', 600)]
    expect(suggestRemovals(files, 1).map((f) => f.name)).toEqual(['a.wav'])
    expect(suggestRemovals([file('only.wav', 9999)], 1)).toEqual([])
  })

  it('suggests nothing when the material is already under the target', () => {
    expect(suggestRemovals([file('a.wav', 100)], 300)).toEqual([])
  })

  it('ignores files whose duration was never decoded', () => {
    expect(suggestRemovals([file('a.wav', null), file('b.wav', 600)], 60).map((f) => f.name))
      .toEqual([])   // only one measured file left; never empties the list
  })
})

describe('checkTrainingInputs — actionable suggestions (Ticket P4)', () => {
  it('names the long files to remove, and offers them for removal', () => {
    const files = [file('a.wav', 900), file('b.wav', 800), file('c.wav', 120)]
    const result = checkTrainingInputs(input({ files, deviceMode: 'cpu', device: null }))
    const long = row(result, 'longMaterial')
    expect(long?.severity).toBe('warning')
    // 1820s total against the CPU's 1200s bar: dropping the longest clears it.
    expect(long?.removable).toEqual(['a.wav'])
    expect(long?.files?.map((f) => f.name)).toEqual(['a.wav'])
    expect(result.canProceed).toBe(true)   // advice, never a cap
  })

  it('holds a GPU run to a far higher bar before suggesting a trim', () => {
    const files = [file('a.wav', 900), file('b.wav', 800)]
    expect(row(checkTrainingInputs(input({ files })), 'longMaterial')).toBeUndefined()
    expect(LONG_TOTAL_SEC.gpu).toBeGreaterThan(LONG_TOTAL_SEC.cpu)
  })

  it('offers to remove the sub-chunk clips it warns about', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', 600), file('tiny.wav', 1)] }))
    expect(row(result, 'chunkable')?.removable).toEqual(['tiny.wav'])
    expect(row(result, 'chunkable')?.files?.[0].duration).toBe(1)
  })

  it('does not offer removal when removing everything is the only way out', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', 1), file('b.wav', 2)] }))
    expect(row(result, 'chunkable')?.severity).toBe('blocker')
    expect(row(result, 'chunkable')?.removable).toBeUndefined()
    expect(row(result, 'chunkable')?.files).toHaveLength(2)
  })

  it('offers to remove unreadable files, which never trained anyway', () => {
    const result = checkTrainingInputs(input({ files: [file('a.wav', 600), file('b.m4a', 600)] }))
    expect(row(result, 'format')?.removable).toEqual(['b.m4a'])
  })

  it('advises on too many files for the memory available, without a remove button', () => {
    const files = Array.from({ length: MANY_FILES_COUNT + 2 }, (_, i) => file(`t${i}.wav`, 120))
    const result = checkTrainingInputs(input({ files, availableRamGb: 8 }))
    const count = row(result, 'fileCount')
    expect(count?.severity).toBe('warning')
    // Merging takes is a judgement about the material, not a deletion.
    expect(count?.removable).toBeUndefined()
  })

  it('stays quiet about file count on a machine with memory to spare', () => {
    const files = Array.from({ length: MANY_FILES_COUNT + 2 }, (_, i) => file(`t${i}.wav`, 120))
    expect(row(checkTrainingInputs(input({ files, availableRamGb: 32 })), 'fileCount')).toBeUndefined()
  })
})
