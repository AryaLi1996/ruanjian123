// Turns a user-picked photo into a pre-blurred JPEG data URL used as the
// app's custom background (Ticket 27). Blurring is baked in at upload time
// with the Canvas 2D `filter` API (Chromium supports it) rather than left as
// a live CSS `filter`/`backdrop-filter` on the running app — a static
// pre-blurred image costs nothing to repaint while the UI scrolls or
// animates, whereas a full-window CSS blur is recomposited continuously.

export const MAX_BACKGROUND_FILE_BYTES = 10 * 1024 * 1024 // 10MB, per ticket
const MAX_DIMENSION = 1600 // longest side after downscale — keeps the blurred
                            // result well under localStorage's per-origin quota
const BLUR_PX = 30 // within the ticket's recommended 20–40px range
const JPEG_QUALITY = 0.8

export class BackgroundImageError extends Error {}

function loadImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new BackgroundImageError('load-failed'))
    img.src = objectUrl
  })
}

// Draws the image scaled down (preserving aspect ratio), blurs it, then crops
// off the padding used to keep the blur from sampling transparent pixels at
// the edges (which would otherwise show up as a dark vignette).
export async function processBackgroundImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new BackgroundImageError('invalid-type')
  if (file.size > MAX_BACKGROUND_FILE_BYTES) throw new BackgroundImageError('too-large')

  const objectUrl = URL.createObjectURL(file)
  let img: HTMLImageElement
  try {
    img = await loadImage(objectUrl)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }

  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))

  // Oversized padded canvas: the image fully covers it, so the blur has real
  // pixels to sample right up to (and past) the edge of the final crop.
  const pad = BLUR_PX * 2
  const padded = document.createElement('canvas')
  padded.width = w + pad * 2
  padded.height = h + pad * 2
  const pctx = padded.getContext('2d')
  if (!pctx) throw new BackgroundImageError('canvas-unavailable')
  pctx.filter = `blur(${BLUR_PX}px)`
  pctx.drawImage(img, pad, pad, w, h)

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')
  if (!octx) throw new BackgroundImageError('canvas-unavailable')
  octx.drawImage(padded, pad, pad, w, h, 0, 0, w, h)

  try {
    return out.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    // A canvas tainted by a cross-origin/embedded resource throws on read.
    throw new BackgroundImageError('export-failed')
  }
}
