/**
 * Short notification chime played on task completion (Ticket 21 §"Play a
 * notification sound"). Synthesized with the Web Audio API rather than
 * shipping an audio asset — matches the rest of the app's stub-audio
 * generation (see utils/audio.ts, engine/*.py's build_stub_model()).
 */
let sharedCtx: AudioContext | null = null

function ensureCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext()
  return sharedCtx
}

/** Two-note ascending chime (C6 → E6), ~350ms, soft attack/release. */
export function playCompletionChime(): void {
  try {
    const ctx = ensureCtx()
    const now = ctx.currentTime
    const notes: Array<{ freq: number; start: number; dur: number }> = [
      { freq: 1046.5, start: 0,    dur: 0.16 }, // C6
      { freq: 1318.5, start: 0.12, dur: 0.22 }, // E6
    ]
    for (const { freq, start, dur } of notes) {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      gain.connect(ctx.destination)

      const t0 = now + start
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    }
  } catch {
    // Web Audio unavailable (e.g. autoplay policy before any user gesture) —
    // the toast/notification-center entry still reflects completion, so a
    // missed chime isn't user-facing failure.
  }
}
