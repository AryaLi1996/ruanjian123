import { create } from 'zustand'
import { deriveAccentShades, isValidHexColor, PANEL_BG_DARK, PANEL_BG_LIGHT } from '../utils/color'
import {
  reblur, type ProcessedBackground,
  DEFAULT_BLUR_PX, MIN_BLUR_PX, MAX_BLUR_PX,
  DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY, MAX_OVERLAY_OPACITY, BRIGHT_OVERLAY_OPACITY,
} from '../utils/backgroundImage'

export type Appearance = 'system' | 'light' | 'dark'
export type FontFamily = 'system' | 'sans' | 'serif' | 'mono'

export interface AccentPreset {
  id:     string
  accent: string
}

// Each preset stores only the "true" brand/base hue — hover, active and the
// on-accent text colour are all derived at apply time (below), contrast-
// corrected against whichever surface (dark or light panel) is currently
// showing. That correction is what actually fixes Ticket 29's "accent is too
// subtle" complaint: several of these bases (indigo, netease-red) measure
// under the WCAG AA 4.5:1 minimum against the dark panel on their own — see
// deriveAccentShades/ensureContrast in utils/color.ts. Brand presets
// (netease/spotify/applemusic/skyblue/youtube) reference mainstream music
// players per Ticket 27/29; violet was retargeted to Ticket 29's suggested
// #8A2BE2 and a YouTube red was added alongside it.
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'indigo',     accent: '#6366f1' },
  { id: 'blue',       accent: '#3b82f6' },
  { id: 'teal',       accent: '#14b8a6' },
  { id: 'green',      accent: '#22c55e' },
  { id: 'orange',     accent: '#f59e0b' },
  { id: 'pink',       accent: '#ec4899' },
  { id: 'red',        accent: '#ef4444' },
  { id: 'violet',     accent: '#8A2BE2' },
  { id: 'netease',    accent: '#E60026' },
  { id: 'spotify',    accent: '#1DB954' },
  { id: 'applemusic', accent: '#FA2D48' },
  { id: 'youtube',    accent: '#FF0000' },
  { id: 'skyblue',    accent: '#1E90FF' },
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
const BG_PREVIEW_KEY  = 'ruanjian.backgroundImagePreview'
const BG_OVERLAY_KEY  = 'ruanjian.backgroundOverlayOpacity'
const BG_BLUR_KEY     = 'ruanjian.backgroundBlurPx'
const AUTO_LYRICS_KEY = 'ruanjian.autoLyricsEnabled'

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

// Resolves an accent preset id or raw "#hex" value to its base brand colour
// (pre contrast-correction).
function resolveAccentBase(value: string): string {
  return isCustomAccentValue(value) && isValidHexColor(value)
    ? value
    : (ACCENT_PRESETS.find((p) => p.id === value) ?? ACCENT_PRESETS[0]).accent
}

// The last accent id/hex applied — kept so applyAppearance can re-derive the
// accent's contrast-corrected shades whenever the resolved light/dark
// surface changes (a dark-mode-legible accent isn't necessarily legible on
// the light panel, and vice versa).
let currentAccentValue = DEFAULT_ACCENT

// Sets the resolved (never "system") mode on <html> — the CSS only ever
// switches on data-appearance="light", defaulting to the dark palette. Also
// re-derives the accent against the newly-resolved surface colour (Ticket
// 29: hover/active and contrast-correction are appearance-aware), and
// returns the resolved value so callers can publish it as reactive state
// (see `resolvedAppearance` below) instead of components having to read
// document.documentElement back out for themselves.
function applyAppearance(appearance: Appearance): 'light' | 'dark' {
  const resolved = appearance === 'system' ? resolveSystemAppearance() : appearance
  document.documentElement.setAttribute('data-appearance', resolved)
  applyAccent(currentAccentValue, resolved)
  syncWindowBackground()
  return resolved
}

// Exported so the Settings page can render preset swatches / the live
// preview using the exact colour that will actually be applied, rather than
// the raw (possibly too-subtle) base hex. Takes the resolved appearance
// explicitly (e.g. from the store's `resolvedAppearance` field) rather than
// reading document.documentElement itself, so this stays a pure function of
// its arguments instead of an implicit ordering contract with whichever
// caller last touched the DOM attribute.
export function getEffectiveAccent(value: string, resolvedAppearance: 'light' | 'dark') {
  const surface = resolvedAppearance === 'light' ? PANEL_BG_LIGHT : PANEL_BG_DARK
  return deriveAccentShades(resolveAccentBase(value), surface)
}

function applyAccent(value: string, resolvedAppearance: 'light' | 'dark'): void {
  currentAccentValue = value
  const derived = getEffectiveAccent(value, resolvedAppearance)
  const root = document.documentElement.style
  root.setProperty('--accent',        derived.accent)
  root.setProperty('--accent-hover',  derived.accentHover)
  root.setProperty('--accent-active', derived.accentActive)
  root.setProperty('--on-accent',     derived.onAccent)
  // Ticket UI-01 §3: tech-gradient primary accent, hue-rotated from the
  // resolved --accent so it always matches the active preset/custom colour.
  root.setProperty('--accent-gradient', `linear-gradient(135deg, ${derived.accent} 0%, ${derived.accentGradientEnd} 100%)`)
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

// The overlay's base colour (a cool near-black, matching app.css's original
// static rgba(8,10,16,0.52)) never changes — only its alpha is user/auto
// adjustable (Ticket 30 §5/§7).
function applyOverlayOpacity(opacity: number): void {
  document.documentElement.style.setProperty('--bg-overlay', `rgba(8, 10, 16, ${opacity})`)
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
  appearance:              Appearance
  // The actual light/dark palette in effect right now — `appearance` can be
  // 'system', which this never is. Published as state (rather than left as
  // a DOM-only side effect) so any component can react to it without
  // reading document.documentElement itself (Ticket 29 follow-up).
  resolvedAppearance:      'light' | 'dark'
  accentColor:             string
  avatarDataUrl:           string | null
  fontFamily:              FontFamily
  fontSize:                number
  backgroundImage:         string | null // blurred — what's actually painted
  backgroundPreview:       string | null // unblurred thumbnail, for the Settings page (Ticket 30 §5)
  backgroundOverlayOpacity: number
  backgroundBlurPx:        number
  backgroundBrightWarning: boolean // last upload/adjustment was auto-corrected for brightness (Ticket 30 §7)
  backgroundImageMissing:  boolean // meta says an image should exist but its disk file is gone (Ticket 30 §4)
  // Automatic online lyrics matching on the Playback/Monitor page (Ticket 43 §5) —
  // on by default; users who prefer manual-only import can turn it off here.
  autoLyricsEnabled:       boolean

  setAppearance:            (appearance: Appearance) => void
  setAccentColor:           (idOrHex: string) => void
  setAvatar:                (dataUrl: string | null) => void
  setFontFamily:            (family: FontFamily) => void
  setFontSize:              (size: number) => void
  setBackgroundImage:       (processed: ProcessedBackground | null) => void
  setBackgroundOverlayOpacity: (opacity: number) => void
  setBackgroundBlurPx:      (px: number) => Promise<void>
  setAutoLyricsEnabled:     (enabled: boolean) => void
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
const savedBackgroundImage   = readPersisted(BG_IMAGE_KEY)
const savedBackgroundPreview = readPersisted(BG_PREVIEW_KEY)

const savedOverlayRaw = Number(readPersisted(BG_OVERLAY_KEY))
const savedOverlayOpacity = Number.isFinite(savedOverlayRaw) && savedOverlayRaw >= MIN_OVERLAY_OPACITY && savedOverlayRaw <= MAX_OVERLAY_OPACITY
  ? savedOverlayRaw
  : DEFAULT_OVERLAY_OPACITY
const savedBlurRaw = Number(readPersisted(BG_BLUR_KEY))
const savedBlurPx = Number.isFinite(savedBlurRaw) && savedBlurRaw >= MIN_BLUR_PX && savedBlurRaw <= MAX_BLUR_PX
  ? savedBlurRaw
  : DEFAULT_BLUR_PX

// Defaults on — automatic lyrics fetching only ever kicks in for a song with
// no embedded lyrics, so opting everyone in by default costs nothing for
// users who never touch this setting (Ticket 43 §5).
const savedAutoLyricsRaw = readPersisted(AUTO_LYRICS_KEY)
const savedAutoLyricsEnabled = savedAutoLyricsRaw === null ? true : savedAutoLyricsRaw === 'true'

// Applied synchronously at module load (before React mounts) so the first
// paint already has the right palette/accent/font/background instead of
// flashing defaults. currentAccentValue must be set before applyAppearance
// runs, since it re-derives the accent as part of resolving appearance.
currentAccentValue = savedAccent
const initialResolvedAppearance = applyAppearance(savedAppearance)
applyFont(savedFontFamily)
applyFontSize(savedFontSize)
applyBackgroundImage(savedBackgroundImage)
applyOverlayOpacity(savedOverlayOpacity)

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appearance:               savedAppearance,
  resolvedAppearance:       initialResolvedAppearance,
  accentColor:              savedAccent,
  avatarDataUrl:            savedAvatar,
  fontFamily:               savedFontFamily,
  fontSize:                 savedFontSize,
  backgroundImage:          savedBackgroundImage,
  backgroundPreview:        savedBackgroundPreview,
  backgroundOverlayOpacity: savedOverlayOpacity,
  backgroundBlurPx:         savedBlurPx,
  backgroundBrightWarning:  false,
  backgroundImageMissing:   false,
  autoLyricsEnabled:        savedAutoLyricsEnabled,

  setAppearance: (appearance) => {
    persist(APPEARANCE_KEY, appearance)
    const resolved = applyAppearance(appearance)
    set({ appearance, resolvedAppearance: resolved })
  },
  setAccentColor: (idOrHex) => {
    persist(ACCENT_KEY, idOrHex)
    applyAccent(idOrHex, get().resolvedAppearance)
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
  // `processed` carries the source/preview/blurred trio from
  // utils/backgroundImage.ts's `processBackgroundImage`, or null to remove
  // the background entirely (Ticket 30).
  setBackgroundImage: (processed) => {
    if (processed === null) {
      persist(BG_IMAGE_KEY, null)
      persist(BG_PREVIEW_KEY, null)
      applyBackgroundImage(null)
      void window.engine?.removeBackgroundImage?.().catch(() => {})
      set({ backgroundImage: null, backgroundPreview: null, backgroundBrightWarning: false, backgroundImageMissing: false })
      return
    }
    const { sourceDataUrl, previewDataUrl, blurredDataUrl, brightWarning } = processed
    // A bright upload raises the overlay to at least the "bright" floor —
    // never lowers a higher opacity the user already dialled in by hand
    // (Ticket 30 §7: auto-adjust, don't fight a deliberate user choice).
    const overlayOpacity = brightWarning
      ? Math.max(get().backgroundOverlayOpacity, BRIGHT_OVERLAY_OPACITY)
      : get().backgroundOverlayOpacity

    persist(BG_IMAGE_KEY, blurredDataUrl)
    persist(BG_PREVIEW_KEY, previewDataUrl)
    persist(BG_OVERLAY_KEY, String(overlayOpacity))
    applyBackgroundImage(blurredDataUrl)
    applyOverlayOpacity(overlayOpacity)
    set({
      backgroundImage:          blurredDataUrl,
      backgroundPreview:        previewDataUrl,
      backgroundOverlayOpacity: overlayOpacity,
      backgroundBrightWarning:  brightWarning,
      backgroundImageMissing:   false,
    })
    void window.engine?.saveBackgroundImage?.({
      blurredDataUrl, previewDataUrl, sourceDataUrl,
      meta: { overlayOpacity, blurPx: get().backgroundBlurPx, brightWarning },
    }).catch(() => {})
  },
  setBackgroundOverlayOpacity: (opacity) => {
    const clamped = Math.min(MAX_OVERLAY_OPACITY, Math.max(MIN_OVERLAY_OPACITY, opacity))
    persist(BG_OVERLAY_KEY, String(clamped))
    applyOverlayOpacity(clamped)
    // A manual adjustment supersedes the auto-bump hint, whichever direction it goes.
    set({ backgroundOverlayOpacity: clamped, backgroundBrightWarning: false })
    void window.engine?.saveBackgroundMeta?.({
      overlayOpacity: clamped, blurPx: get().backgroundBlurPx, brightWarning: false,
    }).catch(() => {})
  },
  // Re-blurs from the persisted unblurred source rather than requiring a
  // re-upload (Ticket 30 §5's optional blur-intensity slider). No-ops (but
  // still records the preference for the *next* upload) if no source is on
  // disk yet — e.g. the very first session, before the async save below
  // has landed, or a plain browser preview with no window.engine.
  setBackgroundBlurPx: async (px) => {
    const clamped = Math.min(MAX_BLUR_PX, Math.max(MIN_BLUR_PX, px))
    persist(BG_BLUR_KEY, String(clamped))
    set({ backgroundBlurPx: clamped })
    if (!get().backgroundImage) return

    const sourceDataUrl = await window.engine?.loadBackgroundSource?.().catch(() => null)
    if (!sourceDataUrl) return

    const { blurredDataUrl, brightWarning } = await reblur(sourceDataUrl, clamped)
    const overlayOpacity = brightWarning
      ? Math.max(get().backgroundOverlayOpacity, BRIGHT_OVERLAY_OPACITY)
      : get().backgroundOverlayOpacity

    persist(BG_IMAGE_KEY, blurredDataUrl)
    persist(BG_OVERLAY_KEY, String(overlayOpacity))
    applyBackgroundImage(blurredDataUrl)
    applyOverlayOpacity(overlayOpacity)
    set({ backgroundImage: blurredDataUrl, backgroundOverlayOpacity: overlayOpacity, backgroundBrightWarning: brightWarning })
    void window.engine?.saveBackgroundMeta?.({ overlayOpacity, blurPx: clamped, brightWarning }).catch(() => {})
  },
  setAutoLyricsEnabled: (enabled) => {
    persist(AUTO_LYRICS_KEY, String(enabled))
    set({ autoLyricsEnabled: enabled })
  },
}))

// Reconciles against the durable disk copy (main/background-store.ts):
//  - if this profile's localStorage was cleared/never had one but disk does
//    (e.g. reinstalled the renderer's storage, or a first read on a second
//    window), adopt the disk copy instead of staying on the default;
//  - if disk says an image should exist but its files are gone, surface the
//    Ticket 30 §4 "missing" warning rather than pretending nothing's wrong.
// Deliberately async/best-effort — see setBackgroundImage's own comment on
// why the *first paint* still comes from the synchronous localStorage read
// above rather than waiting on this.
void window.engine?.loadBackgroundImage?.().then((result) => {
  if (!result) return
  if ('missing' in result) {
    useSettingsStore.setState({ backgroundImageMissing: true })
    return
  }
  if (!savedBackgroundImage) {
    applyBackgroundImage(result.blurredDataUrl)
    applyOverlayOpacity(result.meta.overlayOpacity)
    persist(BG_IMAGE_KEY, result.blurredDataUrl)
    persist(BG_PREVIEW_KEY, result.previewDataUrl)
    persist(BG_OVERLAY_KEY, String(result.meta.overlayOpacity))
    persist(BG_BLUR_KEY, String(result.meta.blurPx))
    useSettingsStore.setState({
      backgroundImage:          result.blurredDataUrl,
      backgroundPreview:        result.previewDataUrl,
      backgroundOverlayOpacity: result.meta.overlayOpacity,
      backgroundBlurPx:         result.meta.blurPx,
      backgroundBrightWarning:  result.meta.brightWarning,
    })
  }
}).catch(() => {})

// Live-follow OS theme changes while the user hasn't pinned light/dark.
const systemMq = window.matchMedia?.('(prefers-color-scheme: light)')
systemMq?.addEventListener?.('change', () => {
  if (useSettingsStore.getState().appearance === 'system') {
    const resolved = applyAppearance('system')
    useSettingsStore.setState({ resolvedAppearance: resolved })
  }
})
