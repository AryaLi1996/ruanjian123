// Small hex-colour helpers used by the theming system to derive hover/active
// shades and a contrast-safe "on accent" text colour from a single base hex
// value — used both for the built-in presets and for the custom colour
// picker (Ticket 27), so a user-chosen accent gets the same treatment as a
// hand-picked preset instead of only working with the exact base colour.

interface Rgb { r: number; g: number; b: number }

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)))
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const int = parseInt(m[1], 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break
    case gn: h = (bn - rn) / d + 2; break
    default: h = (rn - gn) / d + 4
  }
  return { h: h / 6, s, l }
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) { const v = clampByte(l * 255); return { r: v, g: v, b: v } }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: clampByte(hue2rgb(p, q, h + 1 / 3) * 255),
    g: clampByte(hue2rgb(p, q, h) * 255),
    b: clampByte(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

// Shifts HSL lightness by `delta` (e.g. -0.1 = 10% darker), used for
// hover/active shades so any accent — preset or custom-picked — gets
// consistent, readable state colours.
export function shiftLightness(hex: string, delta: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const { h, s, l } = rgbToHsl(rgb)
  return rgbToHex(hslToRgb(h, s, clamp01(l + delta)))
}

// WCAG relative luminance, used to pick readable text over an accent-coloured
// surface (e.g. the primary button, the selected accent swatch's checkmark).
function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// Returns near-black or near-white — whichever gives the stronger contrast
// against the given background colour — for text/icons drawn on top of it.
export function contrastText(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return '#ffffff'
  const l = relativeLuminance(rgb)
  const contrastWithWhite = 1.05 / (l + 0.05)
  const contrastWithBlack = (l + 0.05) / 0.05
  return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#0b0d12'
}

export function isValidHexColor(value: string): boolean {
  return hexToRgb(value) !== null
}

export interface DerivedAccent {
  accent:       string
  accentHover:  string
  accentActive: string
  onAccent:     string
}

// Builds the full hover/active/on-accent set from a single base colour.
export function deriveAccentShades(baseHex: string): DerivedAccent {
  const rgb = hexToRgb(baseHex)
  const accent = rgb ? rgbToHex(rgb) : baseHex
  return {
    accent,
    accentHover:  shiftLightness(accent, -0.08),
    accentActive: shiftLightness(accent, -0.16),
    onAccent:     contrastText(accent),
  }
}
