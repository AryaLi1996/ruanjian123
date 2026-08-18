// Shared geometry for the SootheVoice (舒音) brand mark — "feather +
// soundwave" (Direction 1, Ticket 32). This is the single source of truth
// for the artwork's coordinates.
//
// It's consumed by two different renderers that can't share JSX directly:
//   - BrandLogo.tsx     — the live in-app component, maps this data to JSX
//                          so the soundwave can use var(--color-primary).
//   - generate-brand-svg — scripts/generate-brand-svg.ts regenerates the
//                          static files under src/assets/brand/ from this
//                          same data (with the accent hardcoded, since a
//                          standalone file has no host page to read a CSS
//                          custom property from). Run it after editing the
//                          shapes below:
//                            node scripts/generate-brand-svg.ts

export const FEATHER_PATH = 'M256,86 C302,108 334,176 326,246 C320,300 296,344 258,370 C230,348 210,306 208,246 C206,182 222,120 256,86 Z'
export const QUILL_PATH = 'M258,368 C250,388 240,406 230,426'

export interface SoundwaveBar { x: number; y: number; h: number }

// Equalizer-style bars running along the feather's spine — the "soundwave".
export const SOUNDWAVE_BAR_WIDTH = 7
export const SOUNDWAVE_BAR_RX = 3.5
export const SOUNDWAVE_BARS: SoundwaveBar[] = [
  { x: 218.5, y: 215, h: 26 },
  { x: 230.5, y: 205, h: 46 },
  { x: 242.5, y: 194, h: 68 },
  { x: 254.5, y: 182, h: 92 },
  { x: 266.5, y: 194, h: 68 },
  { x: 278.5, y: 205, h: 46 },
  { x: 290.5, y: 215, h: 26 },
]

export interface WaveArc { d: string; opacity: number }

// Subtle wave lines — sound emanating to the right, decreasing opacity
// with distance from the feather.
export const WAVE_ARCS: WaveArc[] = [
  { d: 'M340,200 Q380,228 340,256', opacity: 0.45 },
  { d: 'M352,180 Q404,228 352,276', opacity: 0.30 },
  { d: 'M364,158 Q430,228 364,298', opacity: 0.18 },
]

// Full-variant app-icon background (dark rounded square).
export const BG_GRADIENT_FROM = '#1A1A2E'
export const BG_GRADIENT_TO = '#16213E'

// Soundwave colour where nothing (theme or otherwise) overrides it —
// the fallback in BrandLogo's var(--color-primary, DEFAULT_ACCENT) and the
// literal fill used in the standalone static SVG files.
export const DEFAULT_ACCENT = '#00E5A0'
