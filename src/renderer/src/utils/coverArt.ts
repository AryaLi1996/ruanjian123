// Deterministic placeholder cover art for catalogue entries with no album
// image (Ticket UI-08). The grid is built around square covers, so an entry
// without one still needs something with visual weight — a flat grey tile
// would leave the whole page looking broken whenever the upstream catalogue
// (or the offline mock) carries no artwork.
//
// Deterministic by song id: the same song always gets the same colours, so
// the grid doesn't reshuffle its palette between searches or re-renders.

/** FNV-1a — small, stable, and good enough to spread ids across the wheel. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export interface PlaceholderCover {
  /** Ready to drop straight into a `background` declaration. */
  gradient: string
  /** Single glyph drawn over the gradient. */
  initial:  string
}

/**
 * Builds a two-stop gradient and a display initial for a song.
 *
 * Saturation and lightness are fixed rather than hashed: only the hue
 * varies, which keeps every tile in the grid at the same visual weight
 * instead of some blazing and others muddy.
 */
export function placeholderCover(id: string, title: string): PlaceholderCover {
  const hue = hashString(id) % 360
  // A second hue a fixed distance away, so every tile has the same amount
  // of internal contrast.
  const hue2 = (hue + 48) % 360
  return {
    gradient: `linear-gradient(135deg, hsl(${hue} 58% 42%), hsl(${hue2} 62% 26%))`,
    initial:  [...title.trim()][0] ?? '♪',
  }
}
