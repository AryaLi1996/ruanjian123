/** Encodes float32 PCM (−1..1 range) as a 16-bit mono WAV Blob. */
export function pcmToWavBlob(samples: number[] | Float32Array, sampleRate: number): Blob {
  const len = samples.length
  const buf = new ArrayBuffer(44 + len * 2)
  const dv  = new DataView(buf)
  const w4  = (o: number, s: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)) }

  w4(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); w4(8, 'WAVE')
  w4(12, 'fmt '); dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)             // PCM
  dv.setUint16(22, 1, true)             // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  w4(36, 'data'); dv.setUint32(40, len * 2, true)

  for (let i = 0; i < len; i++) {
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, (samples as number[])[i])) * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Formats a duration as `mm:ss.d` (one decisecond digit) — e.g. `00:17.2` —
 * for displays that need sub-second precision, such as the waveform
 * region editor's transport readout (Ticket 15).
 */
export function formatTimeDs(seconds: number): string {
  const clamped = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalDs = Math.round(clamped * 10)
  const m = Math.floor(totalDs / 600)
  const s = Math.floor((totalDs % 600) / 10)
  const d = totalDs % 10
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${d}`
}

/** Draws a waveform on an off-screen canvas and returns it as a data URL. */
export async function makeWaveformDataUrl(file: File, w = 400, h = 60): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx   = canvas.getContext('2d')!
    const buf   = await file.arrayBuffer()
    const ac    = new AudioContext()
    const dec   = await ac.decodeAudioData(buf)
    ac.close()

    const data = dec.getChannelData(0)
    const step = Math.ceil(data.length / w)
    const cy   = h / 2
    const amp  = h / 2 - 3

    ctx.fillStyle = '#121212'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#6366f1'
    ctx.lineWidth = 1

    for (let i = 0; i < w; i++) {
      let mn = 1, mx = -1
      for (let j = 0; j < step && i * step + j < data.length; j++) {
        const v = data[i * step + j]; if (v < mn) mn = v; if (v > mx) mx = v
      }
      ctx.beginPath()
      ctx.moveTo(i + 0.5, cy - mx * amp)
      ctx.lineTo(i + 0.5, cy - mn * amp)
      ctx.stroke()
    }
    return canvas.toDataURL()
  } catch {
    return null
  }
}

export async function getAudioInfo(file: File): Promise<{ duration: number; waveformUrl: string | null }> {
  try {
    const buf = await file.arrayBuffer()
    const ac  = new AudioContext()
    const dec = await ac.decodeAudioData(buf)
    ac.close()
    const waveformUrl = await makeWaveformDataUrl(file)
    return { duration: dec.duration, waveformUrl }
  } catch {
    return { duration: 0, waveformUrl: null }
  }
}
