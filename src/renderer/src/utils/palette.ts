// Dominant-colour extraction for the "魔法色" immersive background
// (Ticket UI-12).
//
// Written against the canvas API rather than pulling in ColorThief or
// Vibrant.js: the whole job is "downsample, bucket, rank", which the
// platform already does natively via drawImage, and a dependency for ~50
// lines would have to be audited, bundled and kept current for no gain.

/** Edge length the source is downsampled to before counting pixels. */
const SAMPLE_SIZE = 48

/** Colour buckets per channel — 4 bits each, so 4096 possible buckets. */
const BITS = 4

export interface Palette {
  /** Most prominent colour that isn't near-black or near-white. */
  dominant: string
  /** A second, visually distinct colour for the gradient's far stop. */
  accent:   string
}

/** Neutral fallback used when an image can't be read (see extractPalette). */
export const NEUTRAL_PALETTE: Palette = { dominant: '#2a2f45', accent: '#161a28' }

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break
    case gn: h = (bn - rn) / d + 2; break
    default: h = (rn - gn) / d + 4
  }
  return [h / 6, s, l]
}

interface Bucket { r: number; g: number; b: number; count: number; score: number }

/**
 * Pulls a two-colour palette out of an already-loaded image.
 *
 * Buckets are ranked by population *weighted by saturation*, not by raw
 * count: album art is very often mostly dark or mostly white, and picking
 * the largest bucket would return that background every time — a grey
 * "magic colour" is worse than no magic colour at all.
 */
export function paletteFromImage(image: CanvasImageSource): Palette {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return NEUTRAL_PALETTE

  ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  } catch {
    // A cross-origin image taints the canvas and makes getImageData throw.
    return NEUTRAL_PALETTE
  }

  const buckets = new Map<number, Bucket>()
  const shift = 8 - BITS

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue           // effectively transparent
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const [, s, l] = rgbToHsl(r, g, b)
    // Skip the extremes: they dominate by area on most artwork and carry no
    // usable hue.
    if (l < 0.12 || l > 0.92) continue

    const key = ((r >> shift) << (BITS * 2)) | ((g >> shift) << BITS) | (b >> shift)
    const existing = buckets.get(key)
    if (existing) {
      existing.r += r; existing.g += g; existing.b += b; existing.count++
    } else {
      buckets.set(key, { r, g, b, count: 1, score: 0 })
    }
  }

  if (buckets.size === 0) return NEUTRAL_PALETTE

  const ranked = [...buckets.values()].map((bucket) => {
    const r = bucket.r / bucket.count, g = bucket.g / bucket.count, b = bucket.b / bucket.count
    const [h, s] = rgbToHsl(r, g, b)
    return { r, g, b, h, s, count: bucket.count, score: bucket.count * (0.25 + s) }
  }).sort((a, b) => b.score - a.score)

  const dominant = ranked[0]
  // The far stop should actually differ: walk the ranking for the first
  // colour more than 1/12 of the wheel away, so the gradient reads as a
  // gradient rather than as one flat colour.
  const distinct = ranked.slice(1).find((c) => {
    const dh = Math.abs(c.h - dominant.h)
    return Math.min(dh, 1 - dh) > 1 / 12
  }) ?? ranked[Math.min(1, ranked.length - 1)]

  return {
    dominant: rgbToHex(dominant.r, dominant.g, dominant.b),
    accent:   rgbToHex(distinct.r, distinct.g, distinct.b),
  }
}

/** Loads `src` and extracts its palette, resolving to the neutral one on failure. */
export function extractPalette(src: string): Promise<Palette> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload  = () => resolve(paletteFromImage(image))
    image.onerror = () => resolve(NEUTRAL_PALETTE)
    image.src = src
  })
}
