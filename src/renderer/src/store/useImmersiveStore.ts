import { create } from 'zustand'
import { NEUTRAL_PALETTE, type Palette } from '../utils/palette'

// Immersive playback mode and its "魔法色" backdrop (Ticket UI-12).
//
// Kept out of useAppStore for the same reason useLayoutStore is: this is
// presentation state about how the shell is displayed, not about what the
// app is doing.

interface ImmersiveState {
  /** True while the shell is dimmed down to waveform + transport. */
  immersive: boolean
  /** Colours driving the animated backdrop, from the current cover art. */
  palette:   Palette
  /** Whether a palette has actually been derived from artwork yet. */
  hasPalette: boolean

  setImmersive: (on: boolean) => void
  toggleImmersive: () => void
  setPalette:   (palette: Palette | null) => void
}

export const useImmersiveStore = create<ImmersiveState>((set) => ({
  immersive:  false,
  palette:    NEUTRAL_PALETTE,
  hasPalette: false,

  setImmersive: (on) => set({ immersive: on }),
  toggleImmersive: () => set((s) => ({ immersive: !s.immersive })),
  // Null resets to the neutral pair — the song was cleared, or its artwork
  // couldn't be read, and keeping the previous song's colours would be a
  // quietly wrong signal about what's loaded.
  setPalette: (palette) =>
    set(palette ? { palette, hasPalette: true } : { palette: NEUTRAL_PALETTE, hasPalette: false }),
}))
