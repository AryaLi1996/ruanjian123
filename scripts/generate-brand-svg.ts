// Regenerates the static SootheVoice (舒音) brand-mark SVGs under
// src/assets/brand/ from the shared shape data in
// src/renderer/src/components/brand/brandMark.ts — the same data the live
// <BrandLogo> component renders as JSX. Keeps the checked-in static files
// (used as the app-icon source and as standalone design assets) from
// drifting out of sync with the in-app artwork.
//
// The static files hardcode DEFAULT_ACCENT rather than
// var(--color-primary): a standalone SVG has no host page to read a CSS
// custom property from, and some non-browser rasterizers (icon-generation
// tools, Quick Look, etc.) don't resolve var() in presentation attributes.
//
// Run after editing brandMark.ts:
//   node scripts/generate-brand-svg.ts

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  BG_GRADIENT_FROM, BG_GRADIENT_TO, DEFAULT_ACCENT,
  FEATHER_PATH, QUILL_PATH,
  SOUNDWAVE_BARS, SOUNDWAVE_BAR_WIDTH, SOUNDWAVE_BAR_RX,
  WAVE_ARCS,
} from '../src/renderer/src/components/brand/brandMark.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'src', 'assets', 'brand')

function soundwaveMarkup(): string {
  const bars = SOUNDWAVE_BARS
    .map((bar) => `    <rect x="${bar.x}" y="${bar.y}" width="${SOUNDWAVE_BAR_WIDTH}" height="${bar.h}" rx="${SOUNDWAVE_BAR_RX}" />`)
    .join('\n')
  return `  <g fill="${DEFAULT_ACCENT}">\n${bars}\n  </g>`
}

function waveArcsMarkup(): string {
  const arcs = WAVE_ARCS
    .map((arc) => `    <path d="${arc.d}" stroke-width="5" stroke-opacity="${arc.opacity}" />`)
    .join('\n')
  return `  <g fill="none" stroke="${DEFAULT_ACCENT}" stroke-linecap="round">\n${arcs}\n  </g>`
}

const FEATHER_MARKUP =
  `  <path\n` +
  `    d="${FEATHER_PATH}"\n` +
  `    fill="#FFFFFF" fill-opacity="0.10" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="4" stroke-linejoin="round" />`
const QUILL_MARKUP =
  `  <path d="${QUILL_PATH}" fill="none" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="4" stroke-linecap="round" />`

const fullSvg = `<!--
  SootheVoice (舒音) brand mark — "feather + soundwave" (Direction 1).
  Full variant: dark rounded-square background, for use as the app icon,
  the About page, and the splash screen.

  GENERATED FILE — do not hand-edit. Source of truth is
  src/renderer/src/components/brand/brandMark.ts; regenerate with
  node scripts/generate-brand-svg.ts

  This static file uses the default accent (${DEFAULT_ACCENT}). Anywhere the logo
  needs to track the user's chosen theme colour (top toolbar, in-app
  surfaces) use the BrandLogo React component instead, which inlines
  the same artwork with the soundwave coloured via the CSS custom
  property color-primary.
  See src/renderer/src/components/brand/BrandLogo.tsx.
-->
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SootheVoice logo">
  <defs>
    <linearGradient id="sv-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${BG_GRADIENT_FROM}" />
      <stop offset="1" stop-color="${BG_GRADIENT_TO}" />
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="512" height="512" rx="96" fill="url(#sv-bg)" />

  <!-- Feather outline -->
${FEATHER_MARKUP}
  <!-- Quill -->
${QUILL_MARKUP}

  <!-- Central soundwave (equalizer bars along the feather's spine) -->
${soundwaveMarkup()}

  <!-- Subtle wave lines (sound emanating to the right) -->
${waveArcsMarkup()}
</svg>
`

const simpleSvg = `<!--
  SootheVoice (舒音) brand mark — "feather + soundwave" (Direction 1).
  Simplified variant: feather outline + soundwave only, no background —
  for the top toolbar and other small/inline UI placements.

  GENERATED FILE — do not hand-edit. Source of truth is
  src/renderer/src/components/brand/brandMark.ts; regenerate with
  node scripts/generate-brand-svg.ts

  This static file uses the default accent (${DEFAULT_ACCENT}). Anywhere the logo
  needs to track the user's chosen theme colour use the BrandLogo React
  component instead (src/renderer/src/components/brand/BrandLogo.tsx),
  which inlines the same artwork with the soundwave coloured via the
  CSS custom property color-primary.
-->
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SootheVoice logo">
  <!-- Feather outline -->
${FEATHER_MARKUP}
  <!-- Quill -->
${QUILL_MARKUP}

  <!-- Central soundwave (equalizer bars along the feather's spine) -->
${soundwaveMarkup()}

  <!-- Subtle wave lines (sound emanating to the right) -->
${waveArcsMarkup()}
</svg>
`

writeFileSync(join(OUT_DIR, 'logo-full.svg'), fullSvg)
writeFileSync(join(OUT_DIR, 'logo-simple.svg'), simpleSvg)
console.log('Wrote', join(OUT_DIR, 'logo-full.svg'))
console.log('Wrote', join(OUT_DIR, 'logo-simple.svg'))
