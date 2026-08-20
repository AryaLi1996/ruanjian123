/**
 * Persists automatically-matched lyrics to userData/lyrics-cache.json, keyed
 * by a hash of artist + title + duration (see renderer's
 * utils/autoLyrics.ts). Without this, replaying the same song would re-query
 * the online lyrics source on every single load (Ticket 43 §4).
 *
 * Mirrors model-registry.ts's shape: a small durable JSON file in userData,
 * loaded/saved wholesale over IPC rather than pulling in electron-store.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface LyricsCacheEntry {
  raw:      string   // the LRC (or plain-text) blob as returned by the source
  source:   string    // e.g. 'lrclib' — free-form so a future source doesn't need a type change
  cachedAt: number
}

export type LyricsCache = Record<string, LyricsCacheEntry>

// Hard cap so years of daily use can't let this file grow without bound —
// oldest entries (by cachedAt) are evicted first once it's exceeded.
const MAX_ENTRIES = 500

function cachePath(): string {
  return join(app.getPath('userData'), 'lyrics-cache.json')
}

export async function loadLyricsCache(): Promise<LyricsCache> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : {}
  } catch {
    // Missing on first launch, or corrupt — start from an empty cache rather
    // than failing to load the Playback/Monitor page.
    return {}
  }
}

export async function saveLyricsCache(cache: LyricsCache): Promise<void> {
  const entries = Object.entries(cache)
  const capped = entries.length > MAX_ENTRIES
    ? Object.fromEntries(
        entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt).slice(0, MAX_ENTRIES),
      )
    : cache
  await fs.writeFile(cachePath(), JSON.stringify(capped), 'utf8')
}
