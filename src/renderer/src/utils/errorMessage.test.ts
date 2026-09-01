import { describe, expect, it } from 'vitest'
import { describeError } from './errorMessage'

const FALLBACK = 'fallback'

describe('describeError', () => {
  it('unwraps the Electron remote-method wrapper', () => {
    const err = new Error(
      "Error invoking remote method 'engine:stream': Error: 磁盘空间不足，无法写入模型文件"
    )
    expect(describeError(err, FALLBACK)).toBe('磁盘空间不足，无法写入模型文件')
  })

  it('strips a plain Error prefix from a stringified rejection', () => {
    expect(describeError('Error: dataset failed to load', FALLBACK)).toBe('dataset failed to load')
  })

  it('strips typed error prefixes', () => {
    expect(describeError(new TypeError('bad shape'), FALLBACK)).toBe('bad shape')
    expect(describeError('RangeError: out of range', FALLBACK)).toBe('out of range')
  })

  it('keeps an already-clean message untouched', () => {
    expect(describeError(new Error('Python 3.10 not found'), FALLBACK)).toBe('Python 3.10 not found')
  })

  it('does not eat a message that merely mentions an error', () => {
    expect(describeError(new Error('training failed: see Error log'), FALLBACK))
      .toBe('training failed: see Error log')
  })

  it('falls back when there is nothing readable', () => {
    expect(describeError(new Error('   '), FALLBACK)).toBe(FALLBACK)
    expect(describeError(undefined, FALLBACK)).toBe(FALLBACK)
    expect(describeError(null, FALLBACK)).toBe(FALLBACK)
    expect(describeError({}, FALLBACK)).toBe('[object Object]')
  })
})
