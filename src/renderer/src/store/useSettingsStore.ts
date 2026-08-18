import { create } from 'zustand'

export type Appearance = 'system' | 'light' | 'dark'

export interface AccentPreset {
  id:        string
  accent:    string
  accentDim: string
}

// Accent + a slightly darker "dim" shade used for hover states, matched by
// hand per colour rather than derived, since a generic darken() muddies some
// hues (orange/pink) more than others.
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'indigo', accent: '#6366f1', accentDim: '#4f52c5' },
  { id: 'blue',   accent: '#3b82f6', accentDim: '#2f66c9' },
  { id: 'teal',   accent: '#14b8a6', accentDim: '#0f9488' },
  { id: 'green',  accent: '#22c55e', accentDim: '#189a48' },
  { id: 'orange', accent: '#f59e0b', accentDim: '#c97f08' },
  { id: 'pink',   accent: '#ec4899', accentDim: '#c23578' },
  { id: 'red',    accent: '#ef4444', accentDim: '#c23333' },
  { id: 'violet', accent: '#8b5cf6', accentDim: '#6d3fd6' },
]
const DEFAULT_ACCENT = ACCENT_PRESETS[0].id

const APPEARANCE_KEY = 'ruanjian.appearance'
const ACCENT_KEY     = 'ruanjian.accentColor'
const AVATAR_KEY     = 'ruanjian.avatar'

function resolveSystemAppearance(): 'light' | 'dark' {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)')
  return mq?.matches ? 'light' : 'dark'
}

// Best-effort localStorage read/write — mirrors the pattern main/index.ts
// uses for its own disk writes (e.g. markInitialized). A private-browsing
// profile, a disabled storage permission, or a full quota shouldn't stop a
// setting from applying for the rest of the session, or stop the module from
// loading at all (this runs before React mounts) — it just won't survive a
// restart.
function readPersisted(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function persist(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* best-effort */
  }
}

// Sets the resolved (never "system") mode on <html> — the CSS only ever
// switches on data-appearance="light", defaulting to the dark palette.
function applyAppearance(appearance: Appearance): void {
  const resolved = appearance === 'system' ? resolveSystemAppearance() : appearance
  document.documentElement.setAttribute('data-appearance', resolved)
  syncWindowBackground()
}

function applyAccent(id: string): void {
  const preset = ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0]
  document.documentElement.style.setProperty('--accent', preset.accent)
  document.documentElement.style.setProperty('--accent-dim', preset.accentDim)
}

// Tells the Electron main process to repaint the native window with the
// current --bg (read back from computed style so it always matches app.css,
// rather than duplicating the hex values here). Chromium shows this colour
// as filler during resize/maximize compositing, so without this a
// light-appearance user would briefly see the dark startup default on every
// resize. No-ops outside Electron (e.g. a plain browser preview).
function syncWindowBackground(): void {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (bg) void window.engine?.setBackgroundColor?.(bg).catch(() => {})
}

interface SettingsState {
  appearance:    Appearance
  accentColor:   string
  avatarDataUrl: string | null

  setAppearance:  (appearance: Appearance) => void
  setAccentColor: (id: string) => void
  setAvatar:      (dataUrl: string | null) => void
}

const savedAppearanceRaw = readPersisted(APPEARANCE_KEY)
const savedAppearance: Appearance =
  savedAppearanceRaw === 'light' || savedAppearanceRaw === 'dark' ? savedAppearanceRaw : 'system'
const savedAccent = readPersisted(ACCENT_KEY) ?? DEFAULT_ACCENT
const savedAvatar = readPersisted(AVATAR_KEY)

// Applied synchronously at module load (before React mounts) so the first
// paint already has the right palette/accent instead of flashing defaults.
applyAppearance(savedAppearance)
applyAccent(savedAccent)

export const useSettingsStore = create<SettingsState>((set) => ({
  appearance:    savedAppearance,
  accentColor:   savedAccent,
  avatarDataUrl: savedAvatar,

  setAppearance: (appearance) => {
    persist(APPEARANCE_KEY, appearance)
    applyAppearance(appearance)
    set({ appearance })
  },
  setAccentColor: (id) => {
    persist(ACCENT_KEY, id)
    applyAccent(id)
    set({ accentColor: id })
  },
  setAvatar: (dataUrl) => {
    persist(AVATAR_KEY, dataUrl)
    set({ avatarDataUrl: dataUrl })
  },
}))

// Live-follow OS theme changes while the user hasn't pinned light/dark.
const systemMq = window.matchMedia?.('(prefers-color-scheme: light)')
systemMq?.addEventListener?.('change', () => {
  if (useSettingsStore.getState().appearance === 'system') applyAppearance('system')
})
