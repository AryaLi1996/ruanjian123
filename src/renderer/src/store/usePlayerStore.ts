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

const VOLUME_KEY = 'ruanjian.playerVolume'
const LOOP_KEY   = 'ruanjian.playerLoop'
const DEFAULT_VOLUME = 0.85

// Best-effort persistence, matching useLayoutStore/useSettingsStore: a
// private profile or a full quota shouldn't stop the control from working
// for the rest of the session, it just won't survive a restart.
function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    // Explicit null/empty check before Number(): `Number(null)` is 0, which
    // is itself a perfectly valid volume, so folding the two together would
    // start every fresh install silently muted.
    if (raw === null || raw.trim() === '') return DEFAULT_VOLUME
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

function readLoop(): boolean {
  try {
    return localStorage.getItem(LOOP_KEY) === 'true'
  } catch {
    return false
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* best-effort */
  }
}

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
  /** Data URL of a small waveform thumbnail for the loaded material (Ticket UI-03 §1). */
  waveformUrl: string | null
  playing:     boolean
  /** Playhead position in seconds. */
  position:    number
  /** Total length of the loaded material in seconds; 0 when nothing is loaded. */
  duration:    number

  // ── Playback preferences (Ticket UI-03 §3) ──────────────────────────────
  // Unlike the transport fields above these belong to the *user*, not to
  // whichever view currently owns the graph, so they deliberately survive
  // unregistration (they are not part of IDLE below) and persist across
  // restarts. Folding them into the reset would silently restore the default
  // volume every time the user navigated away from the playback page.
  volume:      number
  loop:        boolean
  /** Null whenever no view currently owns an audio graph — see the note above. */
  controls:    PlayerControls | null

  setNowPlaying: (info: {
    title: string | null
    artist: string | null
    coverArtUrl: string | null
    waveformUrl?: string | null
  }) => void
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
  waveformUrl: null,
  playing:     false,
  position:    0,
  duration:    0,
} as const

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...IDLE,
  controls: null,
  volume:   readVolume(),
  loop:     readLoop(),

  // Omitting waveformUrl clears it: the bar falls back to cover art and then
  // a placeholder, and a thumbnail left over from the previous song would be
  // actively misleading.
  setNowPlaying: (info) => set({ waveformUrl: null, ...info }),
  setTransport:  (transport) => set(transport),
  setVolume: (volume) => {
    const next = Math.max(0, Math.min(1, volume))
    persist(VOLUME_KEY, String(next))
    get().controls?.setVolume?.(next)
    set({ volume: next })
  },
  setLoop: (loop) => {
    persist(LOOP_KEY, String(loop))
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
