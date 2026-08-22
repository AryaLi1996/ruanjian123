// Small hex-colour helpers used by the theming system to derive hover/active
// shades and a contrast-safe "on accent" text colour from a single base hex
// value — used both for the built-in presets and for the custom colour
// picker (Ticket 27), so a user-chosen accent gets the same treatment as a
// hand-picked preset instead of only working with the exact base colour.
//
// Ticket 29 adds contrast-correction: rather than trusting that a preset or
// custom pick already reads clearly against the app's dark (or light)
// surfaces, `ensureContrast` nudges lightness/saturation until the colour
// clears WCAG AA, and `deriveAccentShades` applies that correction before
// deriving hover/active so every accent in the app — default, preset, or
// custom — is guaranteed to be legible rather than merely "probably fine".

interface Rgb { r: number; g: number; b: number }
interface Hsl { h: number; s: number; l: number }

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

function rgbToHsl({ r, g, b }: Rgb): Hsl {
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

// Shifts HSL lightness and (optionally) saturation by the given deltas,
// clamped to valid ranges. `shiftLightness` alone is kept for callers that
// only need the old single-axis behaviour.
export function shiftLightness(hex: string, delta: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const { h, s, l } = rgbToHsl(rgb)
  return rgbToHex(hslToRgb(h, s, clamp01(l + delta)))
}

function shiftHsl(hex: string, lightnessDelta: number, saturationDelta: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const { h, s, l } = rgbToHsl(rgb)
  return rgbToHex(hslToRgb(h, clamp01(s + saturationDelta), clamp01(l + lightnessDelta)))
}

// Rotates hue by `degrees` (wrapping 0–360), leaving saturation/lightness
// untouched. Used to derive the "tech gradient" accent (Ticket UI-01 §3,
// e.g. #6C3CE1 → #E83E8C) from whatever single accent colour is currently
// selected, rather than hard-coding a gradient that ignores the user's
// preset/custom accent choice.
export function rotateHue(hex: string, degrees: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const { h, s, l } = rgbToHsl(rgb)
  const rotated = (((h * 360 + degrees) % 360) + 360) % 360
  return rgbToHex(hslToRgb(rotated / 360, s, l))
}

// WCAG relative luminance — the basis for both contrast-ratio checks and for
// picking readable text over an accent-coloured surface.
function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// WCAG 2.x contrast ratio between two colours, 1 (identical) to 21 (black on
// white). Exported so the Settings page can show a live "meets AA" readout
// (Ticket 29 requirement: built-in contrast checker) without duplicating the
// luminance maths.
export function contrastRatio(hexA: string, hexB: string): number {
  const rgbA = hexToRgb(hexA), rgbB = hexToRgb(hexB)
  if (!rgbA || !rgbB) return 1
  const lA = relativeLuminance(rgbA), lB = relativeLuminance(rgbB)
  const lighter = Math.max(lA, lB), darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
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

// Same idea as contrastText, but for a colour that sweeps between two
// backgrounds (--accent-gradient's two stops) — picks whichever of
// near-black/near-white keeps its *worst-case* contrast the highest, so
// on-accent text stays legible across the whole gradient rather than only
// at the start stop.
export function contrastTextForRange(hexA: string, hexB: string): string {
  const rgbA = hexToRgb(hexA), rgbB = hexToRgb(hexB)
  if (!rgbA || !rgbB) return contrastText(hexA)
  const lA = relativeLuminance(rgbA), lB = relativeLuminance(rgbB)
  const worstWhite = Math.min(1.05 / (lA + 0.05), 1.05 / (lB + 0.05))
  const worstBlack = Math.min((lA + 0.05) / 0.05, (lB + 0.05) / 0.05)
  return worstWhite >= worstBlack ? '#ffffff' : '#0b0d12'
}

export function isValidHexColor(value: string): boolean {
  return hexToRgb(value) !== null
}

// Pushes `hex` away from `bgHex`'s lightness (and boosts saturation a touch,
// since a colour desaturates as it approaches white/black) until it clears
// `target` contrast against that background, or until lightness hits a
// sane floor/ceiling. Hue is preserved throughout, so the corrected colour
// still reads as "the same accent", just legible — this is what lets a
// low-contrast preset or a poorly-chosen custom colour still meet WCAG AA
// (Ticket 29 §1/§4) without the user having to pick a better one by hand.
//
// A colour that already clears `target` is returned untouched (just
// hex-normalized) — several brand presets (Spotify's #1DB954, for one)
// already pass comfortably, and the saturation boost used to apply
// unconditionally, silently drifting those exact, ticket-specified brand
// hexes even when no correction was needed.
export function ensureContrast(hex: string, bgHex: string, target = 4.5): string {
  const rgb = hexToRgb(hex)
  const bgRgb = hexToRgb(bgHex)
  if (!rgb || !bgRgb) return hex
  const normalized = rgbToHex(rgb)
  if (contrastRatio(normalized, bgHex) >= target) return normalized

  const bgIsDark = relativeLuminance(bgRgb) < 0.5
  let { h, s, l } = rgbToHsl(rgb)
  s = clamp01(s + 0.06)
  let cur = rgbToHex(hslToRgb(h, s, l))
  const step = bgIsDark ? 0.005 : -0.005
  let guard = 0
  while (contrastRatio(cur, bgHex) < target && l > 0.08 && l < 0.94 && guard < 300) {
    l += step
    cur = rgbToHex(hslToRgb(h, s, clamp01(l)))
    guard++
  }
  return cur
}

export interface DerivedAccent {
  accent:       string
  accentHover:  string
  accentActive: string
  onAccent:     string
  /** Hue-rotated partner colour for --accent-gradient (Ticket UI-01 §3) — the gradient's second stop. */
  accentGradientEnd: string
  /** Contrast ratio of `accent` against the surface colour it was corrected for — surfaced for the Settings contrast readout. */
  contrastOnSurface: number
}

// Degrees to rotate `accent`'s hue by for the gradient's end stop. Chosen so
// the default indigo accent (#6366f1, hue ~243°) lands near magenta/pink
// (~308°) — the same violet→pink sweep as the ticket's #6C3CE1→#E83E8C
// reference — while still tracking whatever hue the user actually picks.
const ACCENT_GRADIENT_HUE_SHIFT = 65

// Builds the full hover/active/on-accent set from a single base colour,
// contrast-corrected against `surfaceHex` (the panel/card background the
// accent will most often sit on or near).
//
// Hover/active follow the guide's "natural light" rule instead of a flat
// darken-by-N%: reducing light on a surface makes it look both darker *and*
// more saturated (a shadowed apple looks deeper red, not just dimmer grey),
// while a highlight looks lighter *and* slightly washed out. So hover
// (highlighted, about-to-interact) goes lighter + less saturated, and active
// (pressed, "light reduced") goes darker + more saturated.
export function deriveAccentShades(baseHex: string, surfaceHex: string, target = 4.5): DerivedAccent {
  const rgb = hexToRgb(baseHex)
  const normalized = rgb ? rgbToHex(rgb) : baseHex
  const accent = ensureContrast(normalized, surfaceHex, target)
  const accentGradientEnd = ensureContrast(rotateHue(accent, ACCENT_GRADIENT_HUE_SHIFT), surfaceHex, target)
  return {
    accent,
    accentHover:  shiftHsl(accent, +0.08, -0.10),
    accentActive: shiftHsl(accent, -0.08, +0.12),
    // Validated against both gradient stops (not just `accent`) since
    // --btn-primary paints on-accent text over the full --accent-gradient,
    // not only its start colour.
    onAccent:     contrastTextForRange(accent, accentGradientEnd),
    accentGradientEnd,
    contrastOnSurface: contrastRatio(accent, surfaceHex),
  }
}

// The dark/light panel background the theming system corrects contrast
// against — kept in sync by hand with app.css's --bg-panel-solid (dark
// default and the :root[data-appearance='light'] override). These are the
// "30% surface" tier of the 60-30-10 split, since accent-as-text or
// accent-as-border most commonly sits on a card/panel rather than directly
// on the page background.
export const PANEL_BG_DARK = '#1e1e1e'
export const PANEL_BG_LIGHT = '#ffffff'
