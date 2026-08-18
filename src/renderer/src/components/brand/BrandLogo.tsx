// SootheVoice (舒音) brand mark — "feather + soundwave" (Direction 1).
//
// Inlined as JSX (rather than referenced via <img src="*.svg">) so the
// soundwave can be painted with var(--color-primary) and track the user's
// theme colour (Ticket 27/29) live, in every place the logo appears. An
// externally-loaded SVG file can't see the host document's CSS variables,
// so the static files under src/assets/brand/ (same artwork, fixed default
// accent) exist only as source assets — e.g. for generating the app icon —
// not for use inside the running app.
//
// `variant="full"` is the dark rounded-square version (app icon, About
// page, splash screen). `variant="simple"` is the feather + soundwave only,
// transparent background, for the toolbar and other small inline spots.
//
// The actual shape data (feather outline, soundwave bars, wave arcs) lives
// in ./brandMark.ts, shared with scripts/generate-brand-svg.ts so the
// static files and this component can't drift apart.

import { useId } from 'react'
import {
  BG_GRADIENT_FROM, BG_GRADIENT_TO, DEFAULT_ACCENT,
  FEATHER_PATH, QUILL_PATH,
  SOUNDWAVE_BARS, SOUNDWAVE_BAR_WIDTH, SOUNDWAVE_BAR_RX,
  WAVE_ARCS,
} from './brandMark'

interface BrandLogoProps {
  variant?: 'full' | 'simple'
  size?: number
  className?: string
  // Every current placement (toolbar, About, splash) sits the mark right
  // next to visible text that already states the app name, so by default
  // this is purely decorative to a screen reader — announcing it too would
  // just be a redundant (and, in zh-CN, English-only) "image, SootheVoice"
  // ahead of the real "舒音" text. Pass an explicit label only for a
  // standalone placement with no adjacent name text.
  ariaLabel?: string
}

const ACCENT_VAR = `var(--color-primary, ${DEFAULT_ACCENT})`

export function BrandLogo({ variant = 'full', size = 32, className, ariaLabel }: BrandLogoProps): JSX.Element {
  // Unique per instance so multiple full-variant logos in the same DOM
  // (however unlikely today) don't collide on a shared gradient id.
  const gradientId = `sv-logo-bg-${useId()}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {variant === 'full' && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={BG_GRADIENT_FROM} />
              <stop offset="1" stopColor={BG_GRADIENT_TO} />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="512" height="512" rx="96" fill={`url(#${gradientId})`} />
        </>
      )}

      {/* Feather outline */}
      <path
        d={FEATHER_PATH}
        fill="#FFFFFF" fillOpacity={0.10} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={4} strokeLinejoin="round"
      />
      {/* Quill */}
      <path d={QUILL_PATH} fill="none" stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={4} strokeLinecap="round" />

      {/* Central soundwave — the accent colour that follows the theme */}
      <g fill={ACCENT_VAR}>
        {SOUNDWAVE_BARS.map((bar) => (
          <rect key={`${bar.x}-${bar.y}`} x={bar.x} y={bar.y} width={SOUNDWAVE_BAR_WIDTH} height={bar.h} rx={SOUNDWAVE_BAR_RX} />
        ))}
      </g>

      {/* Subtle wave lines — sound emanating to the right */}
      <g fill="none" stroke={ACCENT_VAR} strokeLinecap="round">
        {WAVE_ARCS.map((arc) => (
          <path key={arc.d} d={arc.d} strokeWidth={5} strokeOpacity={arc.opacity} />
        ))}
      </g>
    </svg>
  )
}
