import { create } from 'zustand'
import { deriveAccentShades, isValidHexColor } from '../utils/color'

export type Appearance = 'system' | 'light' | 'dark'
export type FontFamily = 'system' | 'sans' | 'serif' | 'mono'

export interface AccentPreset {
  id:        string
  accent:    string
  accentDim: string
}

// Accent + a slightly darker "dim" shade used for hover states, matched by
// hand per colour rather than derived, since a generic darken() muddies some
// hues (orange/pink) more than others. Brand presets (netease/spotify/
// applemusic/skyblue) were requested explicitly by Ticket 27 so users get
// recognizable mainstream-player looks alongside the original palette.
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'indigo',     accent: '#6366f1', accentDim: '#4f52c5' },
  { id: 'blue',       accent: '#3b82f6', accentDim: '#2f66c9' },
  { id: 'teal',       accent: '#14b8a6', accentDim: '#0f9488' },
  { id: 'green',      accent: '#22c55e', accentDim: '#189a48' },
  { id: 'orange',     accent: '#f59e0b', accentDim: '#c97f08' },
  { id: 'pink',       accent: '#ec4899', accentDim: '#c23578' },
  { id: 'red',        accent: '#ef4444', accentDim: '#c23333' },
  { id: 'violet',     accent: '#8b5cf6', accentDim: '#6d3fd6' },
  { id: 'netease',    accent: '#E60026', accentDim: '#b8001e' },
  { id: 'spotify',    accent: '#1DB954', accentDim: '#179143' },
  { id: 'applemusic', accent: '#FA2D48', accentDim: '#c9233a' },
  { id: 'skyblue',    accent: '#1E90FF', accentDim: '#1673cc' },
]
const DEFAULT_ACCENT = ACCENT_PRESETS[0].id
// A saved value that starts with '#' is a custom hex colour rather than a
// preset id — the two share one persisted field/select control.
const isCustomAccentValue = (value: string): boolean => value.startsWith('#')

export const FONT_STACKS: Record<FontFamily, string> = {
  system: `'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif`,
  sans:   `'Noto Sans SC', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`,
  serif:  `Georgia, 'Songti SC', 'Times New Roman', serif`,
  mono:   `'JetBrains Mono', Consolas, Menlo, monospace`,
}
const DEFAULT_FONT: FontFamily = 'system'

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 18
const DEFAULT_FONT_SIZE = 14
// The base font-size in app.css that 1x UI scale corresponds to.
const BASE_FONT_SIZE = 14

const APPEARANCE_KEY  = 'ruanjian.appearance'
const ACCENT_KEY      = 'ruanjian.accentColor'
const AVATAR_KEY      = 'ruanjian.avatar'
const FONT_FAMILY_KEY = 'ruanjian.fontFamily'
const FONT_SIZE_KEY   = 'ruanjian.fontSize'
const BG_IMAGE_KEY    = 'ruanjian.backgroundImage'

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

function applyAccent(value: string): void {
  const derived = isCustomAccentValue(value) && isValidHexColor(value)
    ? deriveAccentShades(value)
    : deriveAccentShades((ACCENT_PRESETS.find((p) => p.id === value) ?? ACCENT_PRESETS[0]).accent)
  const root = document.documentElement.style
  root.setProperty('--accent',        derived.accent)
  root.setProperty('--accent-dim',    derived.accentHover)
  root.setProperty('--accent-active', derived.accentActive)
  root.setProperty('--on-accent',     derived.onAccent)
}

function applyFont(family: FontFamily): void {
  document.documentElement.style.setProperty('--font-family', FONT_STACKS[family] ?? FONT_STACKS[DEFAULT_FONT])
}

// The rest of app.css is written in px, not rem, so a plain root font-size
// change wouldn't scale spacing/icons/layout — only text. `zoom` (Chromium,
// which Electron's renderer is built on) scales the whole rendered page like
// a browser zoom, so font size, padding, icons and canvases' CSS box all
// grow together without any layout breaking, matching the "scale
// proportionally without breaking layouts" requirement.
function applyFontSize(size: number): void {
  const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))
  document.documentElement.style.setProperty('--ui-scale', String(clamped / BASE_FONT_SIZE))
}

function applyBackgroundImage(dataUrl: string | null): void {
  document.documentElement.style.setProperty('--bg-image', dataUrl ? `url("${dataUrl}")` : 'none')
  document.documentElement.setAttribute('data-has-bg-image', dataUrl ? 'true' : 'false')
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
  appearance:        Appearance
  accentColor:       string
  avatarDataUrl:      string | null
  fontFamily:         FontFamily
  fontSize:           number
  backgroundImage:    string | null

  setAppearance:      (appearance: Appearance) => void
  setAccentColor:     (idOrHex: string) => void
  setAvatar:          (dataUrl: string | null) => void
  setFontFamily:      (family: FontFamily) => void
  setFontSize:        (size: number) => void
  setBackgroundImage: (dataUrl: string | null) => void
}

const savedAppearanceRaw = readPersisted(APPEARANCE_KEY)
const savedAppearance: Appearance =
  savedAppearanceRaw === 'light' || savedAppearanceRaw === 'dark' ? savedAppearanceRaw : 'system'
const savedAccent = readPersisted(ACCENT_KEY) ?? DEFAULT_ACCENT
const savedAvatar = readPersisted(AVATAR_KEY)

const savedFontFamilyRaw = readPersisted(FONT_FAMILY_KEY)
const savedFontFamily: FontFamily =
  savedFontFamilyRaw && savedFontFamilyRaw in FONT_STACKS ? (savedFontFamilyRaw as FontFamily) : DEFAULT_FONT
const savedFontSizeRaw = Number(readPersisted(FONT_SIZE_KEY))
const savedFontSize = Number.isFinite(savedFontSizeRaw) && savedFontSizeRaw >= FONT_SIZE_MIN && savedFontSizeRaw <= FONT_SIZE_MAX
  ? savedFontSizeRaw
  : DEFAULT_FONT_SIZE
const savedBackgroundImage = readPersisted(BG_IMAGE_KEY)

// Applied synchronously at module load (before React mounts) so the first
// paint already has the right palette/accent/font/background instead of
// flashing defaults.
applyAppearance(savedAppearance)
applyAccent(savedAccent)
applyFont(savedFontFamily)
applyFontSize(savedFontSize)
applyBackgroundImage(savedBackgroundImage)

export const useSettingsStore = create<SettingsState>((set) => ({
  appearance:      savedAppearance,
  accentColor:     savedAccent,
  avatarDataUrl:   savedAvatar,
  fontFamily:      savedFontFamily,
  fontSize:        savedFontSize,
  backgroundImage: savedBackgroundImage,

  setAppearance: (appearance) => {
    persist(APPEARANCE_KEY, appearance)
    applyAppearance(appearance)
    set({ appearance })
  },
  setAccentColor: (idOrHex) => {
    persist(ACCENT_KEY, idOrHex)
    applyAccent(idOrHex)
    set({ accentColor: idOrHex })
  },
  setAvatar: (dataUrl) => {
    persist(AVATAR_KEY, dataUrl)
    set({ avatarDataUrl: dataUrl })
  },
  setFontFamily: (family) => {
    persist(FONT_FAMILY_KEY, family)
    applyFont(family)
    set({ fontFamily: family })
  },
  setFontSize: (size) => {
    const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))
    persist(FONT_SIZE_KEY, String(clamped))
    applyFontSize(clamped)
    set({ fontSize: clamped })
  },
  setBackgroundImage: (dataUrl) => {
    persist(BG_IMAGE_KEY, dataUrl)
    applyBackgroundImage(dataUrl)
    set({ backgroundImage: dataUrl })
  },
}))

// Live-follow OS theme changes while the user hasn't pinned light/dark.
const systemMq = window.matchMedia?.('(prefers-color-scheme: light)')
systemMq?.addEventListener?.('change', () => {
  if (useSettingsStore.getState().appearance === 'system') applyAppearance('system')
})
