import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayerStore, type PlayerControls } from './usePlayerStore'

const VOLUME_KEY = 'ruanjian.playerVolume'
const LOOP_KEY   = 'ruanjian.playerLoop'
const DEFAULT_VOLUME = 0.85

function makeControls(overrides: Partial<PlayerControls> = {}): PlayerControls {
  return { togglePlay: () => {}, stop: () => {}, seek: () => {}, ...overrides }
}

function resetStore(): void {
  localStorage.clear()
  usePlayerStore.setState({
    title: null, artist: null, coverArtUrl: null, waveformUrl: null,
    playing: false, position: 0, duration: 0,
    controls: null, volume: DEFAULT_VOLUME, loop: false,
  })
}

beforeEach(resetStore)

describe('usePlayerStore volume', () => {
  it('clamps out-of-range values into 0–1', () => {
    const { setVolume } = usePlayerStore.getState()
    setVolume(2.5)
    expect(usePlayerStore.getState().volume).toBe(1)
    setVolume(-3)
    expect(usePlayerStore.getState().volume).toBe(0)
    setVolume(0.35)
    expect(usePlayerStore.getState().volume).toBe(0.35)
  })

  it('persists the value it accepted, not the raw input', () => {
    usePlayerStore.getState().setVolume(4)
    expect(localStorage.getItem(VOLUME_KEY)).toBe('1')
  })

  it('forwards the clamped volume to the owning view', () => {
    const setVolume = vi.fn()
    usePlayerStore.getState().registerControls(makeControls({ setVolume }))
    usePlayerStore.getState().setVolume(2)
    expect(setVolume).toHaveBeenCalledWith(1)
  })
})

describe('usePlayerStore loop', () => {
  it('persists and forwards to the owning view', () => {
    const setLoop = vi.fn()
    usePlayerStore.getState().registerControls(makeControls({ setLoop }))

    usePlayerStore.getState().setLoop(true)
    expect(usePlayerStore.getState().loop).toBe(true)
    expect(localStorage.getItem(LOOP_KEY)).toBe('true')
    expect(setLoop).toHaveBeenCalledWith(true)

    usePlayerStore.getState().setLoop(false)
    expect(usePlayerStore.getState().loop).toBe(false)
    expect(localStorage.getItem(LOOP_KEY)).toBe('false')
  })
})

describe('usePlayerStore registration lifecycle', () => {
  it('clears now-playing and transport state when the owning view unregisters', () => {
    const controls = makeControls()
    const unregister = usePlayerStore.getState().registerControls(controls)
    usePlayerStore.getState().setNowPlaying({
      title: 'take3.wav', artist: 'Local', coverArtUrl: 'blob:cover', waveformUrl: 'data:image/png;base64,AA',
    })
    usePlayerStore.getState().setTransport({ playing: true, position: 42, duration: 120 })

    unregister()

    const s = usePlayerStore.getState()
    expect(s.controls).toBeNull()
    expect(s.title).toBeNull()
    expect(s.waveformUrl).toBeNull()
    expect(s.playing).toBe(false)
    expect(s.position).toBe(0)
    expect(s.duration).toBe(0)
  })

  // Why volume/loop are deliberately kept out of IDLE: they're user
  // preferences, not properties of whichever view happens to own the graph.
  // Folding them into the reset restores the default volume every time the
  // user navigates away from the playback page.
  it('preserves volume and loop across unregistration', () => {
    usePlayerStore.getState().setVolume(0.25)
    usePlayerStore.getState().setLoop(true)

    const unregister = usePlayerStore.getState().registerControls(makeControls())
    unregister()

    expect(usePlayerStore.getState().volume).toBe(0.25)
    expect(usePlayerStore.getState().loop).toBe(true)
  })

  it('ignores a stale unregister once a newer owner has registered', () => {
    const staleUnregister = usePlayerStore.getState().registerControls(makeControls())
    const newer = makeControls()
    usePlayerStore.getState().registerControls(newer)

    staleUnregister()

    expect(usePlayerStore.getState().controls).toBe(newer)
  })
})

describe('usePlayerStore setNowPlaying', () => {
  // The bar falls back to cover art, then a placeholder, when there's no
  // waveform; a thumbnail left from the previous song would be misleading.
  it('drops a previous waveform thumbnail when the next call omits one', () => {
    usePlayerStore.getState().setNowPlaying({
      title: 'a.wav', artist: null, coverArtUrl: null, waveformUrl: 'data:image/png;base64,AA',
    })
    expect(usePlayerStore.getState().waveformUrl).toBe('data:image/png;base64,AA')

    usePlayerStore.getState().setNowPlaying({ title: 'b.wav', artist: null, coverArtUrl: null })
    expect(usePlayerStore.getState().waveformUrl).toBeNull()
  })
})
