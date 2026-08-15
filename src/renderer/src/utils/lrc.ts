export interface LyricLine {
  time: number          // seconds
  text: string
  translation?: string
}

/**
 * Parses standard LRC content, supporting multiple timestamp tags per line
 * and translation lines that share an identical timestamp with the line before them.
 */
export function parseLRC(content: string): LyricLine[] {
  const tagRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  const rawEntries: { time: number; text: string }[] = []

  for (const line of content.split(/\r?\n/)) {
    const times: number[] = []
    tagRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(line))) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0
      times.push(min * 60 + sec + frac)
    }
    if (!times.length) continue   // metadata tag (e.g. [ar:], [ti:]) or plain text — skip
    const text = line.replace(tagRe, '').trim()
    for (const time of times) rawEntries.push({ time, text })
  }

  rawEntries.sort((a, b) => a.time - b.time)

  const merged: LyricLine[] = []
  for (const entry of rawEntries) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.time - entry.time) < 0.001 && !last.translation) {
      last.translation = entry.text
    } else {
      merged.push({ time: entry.time, text: entry.text })
    }
  }
  return merged
}

/** Binary search for the index of the active lyric line at time `t` (last line with time <= t). */
export function findLyricIndex(lines: LyricLine[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/** Wraps plain (untimed) lyric text as sequential lines, one second apart, for display-only fallback. */
function wrapPlainText(text: string): LyricLine[] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((t, i) => ({ time: i, text: t.trim() }))
}

function textFromLyricsBlob(raw: string): LyricLine[] {
  const parsed = parseLRC(raw)
  return parsed.length ? parsed : wrapPlainText(raw)
}

// ── ID3v2 (MP3) ──────────────────────────────────────────────────────────
function readSyncsafeOrNormal(dv: DataView, off: number, syncsafe: boolean): number {
  if (!syncsafe) return dv.getUint32(off)
  return (dv.getUint8(off) << 21) | (dv.getUint8(off + 1) << 14) |
         (dv.getUint8(off + 2) << 7) | dv.getUint8(off + 3)
}

function decodeId3Text(bytes: Uint8Array, encoding: number): string {
  if (encoding === 1 || encoding === 2) return new TextDecoder('utf-16').decode(bytes)
  return new TextDecoder(encoding === 3 ? 'utf-8' : 'latin1').decode(bytes)
}

/** Extracts lyrics from ID3v2 USLT (unsynced) or SYLT (synced) frames. */
function extractID3Lyrics(buf: ArrayBuffer): LyricLine[] | null {
  const dv = new DataView(buf)
  if (dv.byteLength < 10 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2)) !== 'ID3') return null
  const majorVersion = dv.getUint8(3)
  const tagSize = readSyncsafeOrNormal(dv, 6, true)
  let pos = 10
  const end = Math.min(dv.byteLength, 10 + tagSize)
  const bytes = new Uint8Array(buf)

  while (pos + 10 <= end) {
    const frameId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
    const frameSize = majorVersion >= 4
      ? readSyncsafeOrNormal(dv, pos + 4, true)
      : dv.getUint32(pos + 4)
    const frameStart = pos + 10
    if (frameSize <= 0 || frameStart + frameSize > end) break

    if (frameId === 'USLT') {
      const encoding = bytes[frameStart]
      let p = frameStart + 4   // encoding(1) + language(3)
      while (p < frameStart + frameSize && bytes[p] !== 0) p++   // skip content descriptor
      const textStart = p + 1
      const text = decodeId3Text(bytes.slice(textStart, frameStart + frameSize), encoding)
      if (text.trim()) return textFromLyricsBlob(text)
    }

    if (frameId === 'SYLT') {
      const encoding = bytes[frameStart]
      let p = frameStart + 5   // encoding(1) + language(3) + timestampFormat(1)
      p += 1                   // contentType(1)
      while (p < frameStart + frameSize && bytes[p] !== 0) p++   // skip content descriptor
      p += 1
      const lines: LyricLine[] = []
      while (p < frameStart + frameSize) {
        const textEnd = bytes.indexOf(0, p)
        if (textEnd === -1 || textEnd + 4 > frameStart + frameSize) break
        const text = decodeId3Text(bytes.slice(p, textEnd), encoding)
        const timestampMs = dv.getUint32(textEnd + 1)
        lines.push({ time: timestampMs / 1000, text })
        p = textEnd + 5
      }
      if (lines.length) return lines.sort((a, b) => a.time - b.time)
    }

    pos = frameStart + frameSize
  }
  return null
}

// ── FLAC (Vorbis Comment) ─────────────────────────────────────────────────
function extractFLACLyrics(buf: ArrayBuffer): LyricLine[] | null {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  if (bytes.length < 4 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'fLaC') return null

  let pos = 4
  while (pos + 4 <= bytes.length) {
    const header = bytes[pos]
    const isLast = (header & 0x80) !== 0
    const blockType = header & 0x7f
    const blockLen = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const blockStart = pos + 4
    if (blockType === 4) {   // VORBIS_COMMENT
      let p = blockStart
      const vendorLen = dv.getUint32(p, true); p += 4 + vendorLen
      const commentCount = dv.getUint32(p, true); p += 4
      for (let i = 0; i < commentCount && p + 4 <= blockStart + blockLen; i++) {
        const len = dv.getUint32(p, true); p += 4
        const comment = new TextDecoder('utf-8').decode(bytes.slice(p, p + len))
        p += len
        const eq = comment.indexOf('=')
        if (eq > 0 && comment.slice(0, eq).toUpperCase() === 'LYRICS') {
          return textFromLyricsBlob(comment.slice(eq + 1))
        }
      }
    }
    if (isLast) break
    pos = blockStart + blockLen
  }
  return null
}

// ── M4A / MP4 (©lyr atom) ─────────────────────────────────────────────────
function findMp4Box(bytes: Uint8Array, dv: DataView, start: number, end: number, path: string[]): [number, number] | null {
  let pos = start
  while (pos + 8 <= end) {
    const size = dv.getUint32(pos)
    const name = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const boxEnd = size === 0 ? end : pos + size
    if (name === path[0]) {
      if (path.length === 1) return [pos + 8, boxEnd]
      // Containers whose children start right after an extra 4-byte version/flags field.
      const childStart = ['meta'].includes(name) ? pos + 12 : pos + 8
      const nested = findMp4Box(bytes, dv, childStart, boxEnd, path.slice(1))
      if (nested) return nested
    }
    pos = boxEnd
  }
  return null
}

function extractM4ALyrics(buf: ArrayBuffer): LyricLine[] | null {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  const lyr = findMp4Box(bytes, dv, 0, bytes.length, ['moov', 'udta', 'meta', 'ilst', '\u00a9lyr'])
  if (!lyr) return null
  const [lyrStart, lyrEnd] = lyr
  const data = findMp4Box(bytes, dv, lyrStart, lyrEnd, ['data'])
  if (!data) return null
  const [dataStart, dataEnd] = data
  const textBytes = bytes.slice(dataStart + 8, dataEnd)   // skip version(4) + reserved(4)
  const text = new TextDecoder('utf-8').decode(textBytes)
  return text.trim() ? textFromLyricsBlob(text) : null
}

/** Best-effort embedded-lyrics extraction for MP3 / FLAC / M4A files. Returns null if none found. */
export async function extractEmbeddedLyrics(file: File): Promise<LyricLine[] | null> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  try {
    const buf = await file.arrayBuffer()
    if (ext === 'mp3') return extractID3Lyrics(buf)
    if (ext === 'flac') return extractFLACLyrics(buf)
    if (ext === 'm4a' || ext === 'mp4') return extractM4ALyrics(buf)
    return null
  } catch {
    return null
  }
}
