// Turns a user-picked photo into the set of assets the app's custom
// background feature (Ticket 27, reworked in Ticket 30) needs:
//   - a downscaled, *unblurred* "source" image — kept around so the blur
//     radius can be changed later (see `reblur`) without re-uploading;
//   - a small, unblurred "preview" thumbnail for the Settings page, so the
//     user can see what they actually uploaded rather than only the
//     blurred result (Ticket 30 §5);
//   - the blurred JPEG actually used as the app background.
//
// Blurring is baked in via the Canvas 2D `filter` API at upload/adjustment
// time rather than left as a live CSS `filter`/`backdrop-filter` on the
// running app — a static pre-blurred image costs nothing to repaint while
// the UI scrolls or animates, whereas a full-window CSS blur is
// recomposited continuously.

export const MAX_BACKGROUND_FILE_BYTES = 10 * 1024 * 1024 // 10MB, per ticket
const MAX_DIMENSION  = 1600 // longest side of the downscaled source/blurred image
const PREVIEW_DIMENSION = 320 // longest side of the settings-page thumbnail

export const MIN_BLUR_PX     = 10
export const MAX_BLUR_PX     = 50
export const DEFAULT_BLUR_PX = 30 // within the ticket's recommended 20–40px range

export const MIN_OVERLAY_OPACITY     = 0.1
export const MAX_OVERLAY_OPACITY     = 0.8
export const DEFAULT_OVERLAY_OPACITY = 0.45 // per ticket §5's suggested default
// Auto-applied (as a floor, not an override) when an upload comes back too
// bright to stay readable at the default overlay — Ticket 30 §7.
export const BRIGHT_OVERLAY_OPACITY = 0.65
// Average luma (0–1) above which an image is considered "too bright" and
// gets the overlay bump above.
const BRIGHT_LUMA_THRESHOLD = 0.62

const JPEG_QUALITY_START = 0.8
const JPEG_QUALITY_FLOOR = 0.5
const MAX_OUTPUT_BYTES   = 500 * 1024 // Ticket 30 §6

export class BackgroundImageError extends Error {}

export interface ProcessedBackground {
  sourceDataUrl:  string  // downscaled, unblurred — kept for later re-blur
  previewDataUrl: string  // small, unblurred — Settings page thumbnail
  blurredDataUrl: string  // what's actually painted as the app background
  brightWarning:  boolean
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => reject(new BackgroundImageError('load-failed'))
    img.src = src
  })
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new BackgroundImageError('canvas-unavailable')
  return ctx
}

// Draws `source` scaled to fit within `maxDim` on its longest side.
function downscale(source: CanvasImageSource, srcW: number, srcH: number, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvasContext(canvas).drawImage(source, 0, 0, w, h)
  return canvas
}

// Blurs `source` at `blurPx`, then crops off the padding used to keep the
// blur from sampling transparent pixels at the edges (which would otherwise
// show up as a dark vignette).
function blurCanvas(source: HTMLCanvasElement, blurPx: number): HTMLCanvasElement {
  const w = source.width, h = source.height
  const pad = blurPx * 2
  const padded = document.createElement('canvas')
  padded.width = w + pad * 2
  padded.height = h + pad * 2
  const pctx = canvasContext(padded)
  pctx.filter = `blur(${blurPx}px)`
  pctx.drawImage(source, pad, pad, w, h)

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  canvasContext(out).drawImage(padded, pad, pad, w, h, 0, 0, w, h)
  return out
}

// Average luma (0–1) of `canvas`, sampled from a tiny downscaled copy so
// this stays cheap regardless of the canvas's real size.
function averageLuma(canvas: HTMLCanvasElement): number {
  const SAMPLE = 24
  const tiny = document.createElement('canvas')
  tiny.width = SAMPLE
  tiny.height = SAMPLE
  const ctx = canvasContext(tiny)
  ctx.drawImage(canvas, 0, 0, SAMPLE, SAMPLE)
  const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE)
  let sum = 0
  const pixels = SAMPLE * SAMPLE
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  return sum / pixels / 255
}

// Encodes `canvas` as JPEG, stepping quality down until the result clears
// the Ticket 30 §6 ~500KB budget or hits the quality floor.
function toBoundedJpeg(canvas: HTMLCanvasElement): string {
  let quality = JPEG_QUALITY_START
  let dataUrl: string
  try {
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  } catch {
    // A canvas tainted by a cross-origin/embedded resource throws on read.
    throw new BackgroundImageError('export-failed')
  }
  const prefixLen = dataUrl.indexOf(',') + 1
  const byteLength = (len: number): number => Math.round((len - prefixLen) * 0.75)
  while (byteLength(dataUrl.length) > MAX_OUTPUT_BYTES && quality > JPEG_QUALITY_FLOOR) {
    quality = Math.max(JPEG_QUALITY_FLOOR, quality - 0.1)
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  return dataUrl
}

// Full pipeline for a freshly-picked file: downscale → preview thumbnail +
// blur at `blurPx` → brightness check.
export async function processBackgroundImage(file: File, blurPx: number = DEFAULT_BLUR_PX): Promise<ProcessedBackground> {
  if (!file.type.startsWith('image/')) throw new BackgroundImageError('invalid-type')
  if (file.size > MAX_BACKGROUND_FILE_BYTES) throw new BackgroundImageError('too-large')

  const objectUrl = URL.createObjectURL(file)
  let img: HTMLImageElement
  try {
    img = await loadImage(objectUrl)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }

  const sourceCanvas  = downscale(img, img.width, img.height, MAX_DIMENSION)
  const previewCanvas = downscale(img, img.width, img.height, PREVIEW_DIMENSION)
  const blurredCanvas = blurCanvas(sourceCanvas, blurPx)
  const brightWarning = averageLuma(blurredCanvas) > BRIGHT_LUMA_THRESHOLD

  return {
    sourceDataUrl:  toBoundedJpeg(sourceCanvas),
    previewDataUrl: toBoundedJpeg(previewCanvas),
    blurredDataUrl: toBoundedJpeg(blurredCanvas),
    brightWarning,
  }
}

// Re-blurs an already-downscaled `sourceDataUrl` (as persisted by a prior
// `processBackgroundImage` call) at a new radius — used when the user moves
// the blur-intensity slider, so adjusting it doesn't require re-uploading
// the original file.
export async function reblur(sourceDataUrl: string, blurPx: number): Promise<{ blurredDataUrl: string; brightWarning: boolean }> {
  const img = await loadImage(sourceDataUrl)
  const sourceCanvas = downscale(img, img.width, img.height, MAX_DIMENSION)
  const blurredCanvas = blurCanvas(sourceCanvas, blurPx)
  const brightWarning = averageLuma(blurredCanvas) > BRIGHT_LUMA_THRESHOLD
  return { blurredDataUrl: toBoundedJpeg(blurredCanvas), brightWarning }
}
