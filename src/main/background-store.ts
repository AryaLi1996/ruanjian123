/**
 * Persists the custom background image (Ticket 27, reworked in Ticket 30)
 * to userData/background/ instead of leaving it solely in the renderer's
 * localStorage.
 *
 * localStorage alone was risky for this feature: the blurred background,
 * its unblurred "source" (kept for re-blurring, see utils/backgroundImage.ts
 * `reblur`) and a settings-page preview thumbnail can together approach
 * localStorage's shared per-origin quota — the same quota the avatar photo
 * also uses. This module is the durable side, mirroring the pattern
 * model-registry.ts already established for the trained-model library: the
 * renderer still writes an instant, synchronous localStorage cache so the
 * very first paint has no flash (see useSettingsStore.ts), but this is the
 * copy that survives a cleared localStorage and is what the "background
 * image file is missing" warning in Settings actually checks.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface BackgroundMeta {
  overlayOpacity: number
  blurPx:         number
  brightWarning:  boolean
}

export interface SaveBackgroundPayload {
  blurredDataUrl: string
  previewDataUrl: string
  sourceDataUrl:  string
  meta:           BackgroundMeta
}

export interface LoadedBackground {
  blurredDataUrl: string
  previewDataUrl: string
  meta:           BackgroundMeta
}

function dir():        string { return join(app.getPath('userData'), 'background') }
function blurredPath(): string { return join(dir(), 'background.jpg') }
function previewPath(): string { return join(dir(), 'preview.jpg') }
function sourcePath():  string { return join(dir(), 'source.jpg') }
function metaPath():    string { return join(dir(), 'meta.json') }

function dataUrlToBuffer(dataUrl: string): Buffer {
  const idx = dataUrl.indexOf(',')
  return Buffer.from(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl, 'base64')
}

function bufferToDataUrl(buf: Buffer): string {
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

export async function saveBackground(payload: SaveBackgroundPayload): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  await Promise.all([
    fs.writeFile(blurredPath(), dataUrlToBuffer(payload.blurredDataUrl)),
    fs.writeFile(previewPath(), dataUrlToBuffer(payload.previewDataUrl)),
    fs.writeFile(sourcePath(),  dataUrlToBuffer(payload.sourceDataUrl)),
    fs.writeFile(metaPath(), JSON.stringify(payload.meta, null, 2), 'utf8'),
  ])
}

export async function saveBackgroundMeta(meta: BackgroundMeta): Promise<void> {
  // Only the overlay-opacity/blur-radius/brightness settings changed (e.g.
  // the overlay slider moved) — the image files themselves are untouched.
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(metaPath(), JSON.stringify(meta, null, 2), 'utf8')
}

// Returns:
//  - `null` if no background has ever been saved on this profile
//  - `{ missing: true }` if meta.json exists but the image files it refers
//    to don't (deleted by hand, sync conflict, disk issue, ...)
//  - the loaded images + settings otherwise
export async function loadBackground(): Promise<LoadedBackground | { missing: true } | null> {
  let meta: BackgroundMeta
  try {
    meta = JSON.parse(await fs.readFile(metaPath(), 'utf8'))
  } catch {
    return null
  }
  try {
    const [blurred, preview] = await Promise.all([fs.readFile(blurredPath()), fs.readFile(previewPath())])
    return { blurredDataUrl: bufferToDataUrl(blurred), previewDataUrl: bufferToDataUrl(preview), meta }
  } catch {
    return { missing: true }
  }
}

// Used when the blur-intensity slider changes — re-blurring needs the
// unblurred downscaled source, not the (already blurred) background.jpg.
export async function loadBackgroundSource(): Promise<string | null> {
  try {
    return bufferToDataUrl(await fs.readFile(sourcePath()))
  } catch {
    return null
  }
}

export async function removeBackground(): Promise<void> {
  await Promise.allSettled([
    fs.rm(blurredPath(), { force: true }),
    fs.rm(previewPath(), { force: true }),
    fs.rm(sourcePath(),  { force: true }),
    fs.rm(metaPath(),    { force: true }),
  ])
}
