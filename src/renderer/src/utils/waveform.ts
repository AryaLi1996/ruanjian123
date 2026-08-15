/** Downmixes an AudioBuffer to mono and computes [min,max] peak pairs for fast, zoom-independent waveform rendering. */
export function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const channels = buffer.numberOfChannels
  const len = buffer.length
  const step = Math.max(1, Math.floor(len / buckets))
  const peaks = new Float32Array(buckets * 2)
  const chData: Float32Array[] = []
  for (let c = 0; c < channels; c++) chData.push(buffer.getChannelData(c))

  for (let i = 0; i < buckets; i++) {
    const start = i * step
    const end = Math.min(len, start + step)
    let mn = 1, mx = -1
    for (let j = start; j < end; j++) {
      let v = 0
      for (let c = 0; c < channels; c++) v += chData[c][j]
      v /= channels
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    if (start >= end) { mn = 0; mx = 0 }
    peaks[i * 2] = mn
    peaks[i * 2 + 1] = mx
  }
  return peaks
}

/** Resamples a precomputed peaks array onto a canvas of arbitrary pixel width — cheap even for 10-minute files. */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  color: string,
  opts?: { background?: string; heightScale?: number },
): void {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const buckets = peaks.length / 2
  const cy = h / 2
  const amp = (h / 2 - 2) * (opts?.heightScale ?? 1)

  if (opts?.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, w, h) }
  else ctx.clearRect(0, 0, w, h)

  ctx.strokeStyle = color
  ctx.lineWidth = 1
  for (let x = 0; x < w; x++) {
    const idx = Math.min(buckets - 1, Math.floor((x / w) * buckets))
    const mn = peaks[idx * 2]
    const mx = peaks[idx * 2 + 1]
    ctx.beginPath()
    ctx.moveTo(x + 0.5, cy - mx * amp)
    ctx.lineTo(x + 0.5, cy - mn * amp)
    ctx.stroke()
  }
}

/**
 * Estimates the time-shift (seconds) that best aligns `bufB` to `bufA` using
 * cross-correlation over a downsampled mono signal. A positive result means
 * bufB should be delayed by that many seconds to line up with bufA.
 */
export function crossCorrelateOffset(bufA: AudioBuffer, bufB: AudioBuffer, maxLagSec = 5): number {
  const targetRate = 2000
  const a = downsampleMono(bufA, targetRate)
  const b = downsampleMono(bufB, targetRate)
  const maxLag = Math.floor(maxLagSec * targetRate)

  let bestLag = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let score = 0
    let count = 0
    // b delayed by `lag` samples relative to a: compare a[n] with b[n-lag]
    const start = Math.max(0, lag)
    const end = Math.min(a.length, b.length + lag)
    for (let n = start; n < end; n += 4) {   // stride for speed
      score += a[n] * b[n - lag]
      count++
    }
    if (count > 0) {
      const normalized = score / count
      if (normalized > bestScore) { bestScore = normalized; bestLag = lag }
    }
  }
  return bestLag / targetRate
}

function downsampleMono(buffer: AudioBuffer, targetRate: number): Float32Array {
  const channels = buffer.numberOfChannels
  const src = buffer.getChannelData(0)
  const ratio = buffer.sampleRate / targetRate
  const outLen = Math.floor(buffer.duration * targetRate)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.floor(i * ratio)
    let v = src[srcIdx] ?? 0
    if (channels > 1) {
      // Average with channel 2 for a rough mono mix (good enough for alignment).
      const ch2 = buffer.getChannelData(1)
      v = (v + (ch2[srcIdx] ?? 0)) / 2
    }
    out[i] = v
  }
  return out
}
