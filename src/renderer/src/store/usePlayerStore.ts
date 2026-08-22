import { create } from 'zustand'

// Global "now playing" state backing the persistent bottom player bar
// (Ticket UI-02 §4).
//
// The actual audio graph (AudioContext, per-stem buffer sources, gain nodes)
// lives in PlaybackMonitorView, which owns the multi-track mixing the app is
// built around. Rather than hoist that whole engine into a store — a much
// larger refactor than this layout ticket calls for, and one that would have
// to re-home the mixer, the recorder and the lyric sync along with it — the
// view *publishes* its transport state here and *registers* the three
// commands the bar needs. The bar is then a pure view over this store.
//
// Consequence worth being explicit about: the controls are registered on
// PlaybackMonitorView mount and torn down on unmount, so navigating away from
// the playback page still stops audio (the view closes its AudioContext in
// its own cleanup). `controls === null` is exactly that state, and the bar
// renders a disabled/idle treatment with a shortcut back to the page rather
// than pretending it can still drive playback.

export interface PlayerControls {
  togglePlay: () => void
  stop:       () => void
  seek:       (sec: number) => void
  setVolume?: (volume: number) => void
  setLoop?:   (loop: boolean) => void
}

interface PlayerState {
  title:       string | null
  artist:      string | null
  coverArtUrl: string | null
  playing:     boolean
  /** Playhead position in seconds. */
  position:    number
  /** Total length of the loaded material in seconds; 0 when nothing is loaded. */
  duration:    number
  volume:      number
  loop:        boolean
  /** Null whenever no view currently owns an audio graph — see the note above. */
  controls:    PlayerControls | null

  setNowPlaying: (info: { title: string | null; artist: string | null; coverArtUrl: string | null }) => void
  setTransport:  (transport: { playing: boolean; position: number; duration: number }) => void
  /** Registers the owning view's transport commands; returns an unregister fn for the effect cleanup. */
  registerControls: (controls: PlayerControls) => () => void
  setVolume:       (volume: number) => void
  setLoop:         (loop: boolean) => void
}

const IDLE = {
  title:       null,
  artist:      null,
  coverArtUrl: null,
  playing:     false,
  position:    0,
  duration:    0,
  volume:      0.85,
  loop:        false,
} as const

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...IDLE,
  controls: null,

  setNowPlaying: (info) => set(info),
  setTransport:  (transport) => set(transport),
  setVolume: (volume) => {
    const next = Math.max(0, Math.min(1, volume))
    get().controls?.setVolume?.(next)
    set({ volume: next })
  },
  setLoop: (loop) => {
    get().controls?.setLoop?.(loop)
    set({ loop })
  },

  registerControls: (controls) => {
    set({ controls })
    return () => {
      // Only clear if we're still the registered owner — guards against a
      // stale cleanup from a previous mount wiping a newer one's controls
      // during React's StrictMode double-invoke (or a fast remount).
      if (get().controls === controls) set({ ...IDLE, controls: null })
    }
  },
}))
