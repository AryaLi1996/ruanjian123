import { decodeId3Text, findMp4Box, id3StringEnd, readSyncsafeOrNormal } from './lrc'

export interface EmbeddedMetadata {
  title:       string | null
  artist:      string | null
  coverArtUrl: string | null   // object URL — caller must URL.revokeObjectURL() when done with it
}

const EMPTY: EmbeddedMetadata = { title: null, artist: null, coverArtUrl: null }

// ── ID3v2 (MP3) ──────────────────────────────────────────────────────────
/** Reads a single ID3v2 text-information frame (TIT2/TPE1/…) as a trimmed string. */
function readId3TextFrame(bytes: Uint8Array, frameStart: number, frameEnd: number): string {
  const encoding = bytes[frameStart]
  const textStart = frameStart + 1
  const textEnd = id3StringEnd(bytes, textStart, frameEnd, encoding)
  return decodeId3Text(bytes.slice(textStart, textEnd), encoding).trim()
}

/** Reads an ID3v2 APIC (attached picture) frame into a Blob object URL. */
function readId3Picture(bytes: Uint8Array, frameStart: number, frameEnd: number): string | null {
  const encoding = bytes[frameStart]
  const mimeStart = frameStart + 1
  const mimeEnd = id3StringEnd(bytes, mimeStart, frameEnd, 0)   // MIME type is always Latin-1
  const mime = new TextDecoder('latin1').decode(bytes.slice(mimeStart, mimeEnd)) || 'image/jpeg'
  const descStart = mimeEnd + 1 /* MIME NUL */ + 1 /* picture type byte */
  const descEnd = id3StringEnd(bytes, descStart, frameEnd, encoding)
  const dataStart = descEnd + (encoding === 1 || encoding === 2 ? 2 : 1)
  if (dataStart >= frameEnd) return null
  const data = bytes.slice(dataStart, frameEnd)
  return URL.createObjectURL(new Blob([data], { type: mime }))
}

function extractID3Metadata(buf: ArrayBuffer): EmbeddedMetadata {
  const dv = new DataView(buf)
  if (dv.byteLength < 10 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2)) !== 'ID3') return EMPTY
  const majorVersion = dv.getUint8(3)
  const tagSize = readSyncsafeOrNormal(dv, 6, true)
  let pos = 10
  const end = Math.min(dv.byteLength, 10 + tagSize)
  const bytes = new Uint8Array(buf)

  let title: string | null = null
  let artist: string | null = null
  let coverArtUrl: string | null = null

  while (pos + 10 <= end && !(title && artist && coverArtUrl)) {
    const frameId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
    const frameSize = majorVersion >= 4
      ? readSyncsafeOrNormal(dv, pos + 4, true)
      : dv.getUint32(pos + 4)
    const frameStart = pos + 10
    if (frameSize <= 0 || frameStart + frameSize > end) break
    const frameEnd = frameStart + frameSize

    try {
      if (frameId === 'TIT2' && !title) title = readId3TextFrame(bytes, frameStart, frameEnd) || null
      else if (frameId === 'TPE1' && !artist) artist = readId3TextFrame(bytes, frameStart, frameEnd) || null
      else if (frameId === 'APIC' && !coverArtUrl) coverArtUrl = readId3Picture(bytes, frameStart, frameEnd)
    } catch { /* skip a malformed frame, keep scanning */ }

    pos = frameEnd
  }
  return { title, artist, coverArtUrl }
}

// ── FLAC (Vorbis Comment + METADATA_BLOCK_PICTURE) ────────────────────────
function extractFLACMetadata(buf: ArrayBuffer): EmbeddedMetadata {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  if (bytes.length < 4 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'fLaC') return EMPTY

  let title: string | null = null
  let artist: string | null = null
  let coverArtUrl: string | null = null

  let pos = 4
  while (pos + 4 <= bytes.length) {
    const header = bytes[pos]
    const isLast = (header & 0x80) !== 0
    const blockType = header & 0x7f
    const blockLen = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const blockStart = pos + 4
    const blockEnd = blockStart + blockLen

    if (blockType === 4) {   // VORBIS_COMMENT — little-endian per the Vorbis comment spec
      let p = blockStart
      const vendorLen = dv.getUint32(p, true); p += 4 + vendorLen
      const commentCount = dv.getUint32(p, true); p += 4
      for (let i = 0; i < commentCount && p + 4 <= blockEnd; i++) {
        const len = dv.getUint32(p, true); p += 4
        const comment = new TextDecoder('utf-8').decode(bytes.slice(p, p + len))
        p += len
        const eq = comment.indexOf('=')
        if (eq <= 0) continue
        const key = comment.slice(0, eq).toUpperCase()
        if (key === 'TITLE' && !title) title = comment.slice(eq + 1)
        else if (key === 'ARTIST' && !artist) artist = comment.slice(eq + 1)
      }
    } else if (blockType === 6 && !coverArtUrl) {   // METADATA_BLOCK_PICTURE — big-endian
      try {
        let p = blockStart + 4   // skip picture type
        const mimeLen = dv.getUint32(p); p += 4
        const mime = new TextDecoder('utf-8').decode(bytes.slice(p, p + mimeLen)) || 'image/jpeg'; p += mimeLen
        const descLen = dv.getUint32(p); p += 4 + descLen
        p += 16   // width(4) + height(4) + colorDepth(4) + colorsUsed(4)
        const dataLen = dv.getUint32(p); p += 4
        const data = bytes.slice(p, p + dataLen)
        if (data.length) coverArtUrl = URL.createObjectURL(new Blob([data], { type: mime }))
      } catch { /* malformed PICTURE block — skip */ }
    }

    if (isLast) break
    pos = blockEnd
  }
  return { title, artist, coverArtUrl }
}

// ── M4A / MP4 (©nam / ©ART / covr atoms) ───────────────────────────────────
function readMp4TextAtom(bytes: Uint8Array, dv: DataView, start: number, end: number, name: string): string | null {
  const box = findMp4Box(bytes, dv, start, end, [name])
  if (!box) return null
  const data = findMp4Box(bytes, dv, box[0], box[1], ['data'])
  if (!data) return null
  const text = new TextDecoder('utf-8').decode(bytes.slice(data[0] + 8, data[1]))
  return text.trim() || null
}

function extractM4AMetadata(buf: ArrayBuffer): EmbeddedMetadata {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  const ilst = findMp4Box(bytes, dv, 0, bytes.length, ['moov', 'udta', 'meta', 'ilst'])
  if (!ilst) return EMPTY
  const [ilstStart, ilstEnd] = ilst

  const title = readMp4TextAtom(bytes, dv, ilstStart, ilstEnd, '©nam')
  const artist = readMp4TextAtom(bytes, dv, ilstStart, ilstEnd, '©ART')

  let coverArtUrl: string | null = null
  const covr = findMp4Box(bytes, dv, ilstStart, ilstEnd, ['covr'])
  if (covr) {
    const data = findMp4Box(bytes, dv, covr[0], covr[1], ['data'])
    if (data) {
      const [dataStart, dataEnd] = data
      const typeIndicator = dv.getUint32(dataStart)   // 13 = JPEG, 14 = PNG (Apple metadata spec)
      const mime = typeIndicator === 14 ? 'image/png' : 'image/jpeg'
      const img = bytes.slice(dataStart + 8, dataEnd)
      if (img.length) coverArtUrl = URL.createObjectURL(new Blob([img], { type: mime }))
    }
  }
  return { title, artist, coverArtUrl }
}

// ── Filename fallback (Ticket 43 §1) ────────────────────────────────────────
/**
 * Falls back to filename patterns like "Artist - Title.mp3" when embedded
 * tags don't carry an artist — the second-priority song-identification
 * source, after ID3/Vorbis/MP4 metadata. Only trusts a single " - "
 * separator; anything else (no dash, or several) is treated as an
 * unattributed track name rather than guessing wrong.
 */
export function parseArtistTitleFromFilename(filename: string): { artist: string | null; title: string | null } {
  const base = filename.replace(/\.[^./]+$/, '').trim()
  const parts = base.split(/\s+-\s+/)
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { artist: parts[0].trim(), title: parts[1].trim() }
  }
  return { artist: null, title: base || null }
}

/** Best-effort embedded title / artist / cover-art extraction for MP3 / FLAC / M4A files. */
export async function extractEmbeddedMetadata(file: File): Promise<EmbeddedMetadata> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  try {
    const buf = await file.arrayBuffer()
    if (ext === 'mp3') return extractID3Metadata(buf)
    if (ext === 'flac') return extractFLACMetadata(buf)
    if (ext === 'm4a' || ext === 'mp4') return extractM4AMetadata(buf)
    return EMPTY
  } catch {
    return EMPTY
  }
}
