/**
 * Ticket P6: concatenate a training selection into one file.
 *
 * The pre-flight's "remove these files" suggestion (Ticket P4) assumes the
 * user is willing to lose material. Often they are not — every take is
 * someone's recording, and being told to delete two of seven is a decision
 * they'd rather not make. Merging is the other answer to the same problem:
 * total duration is unchanged, but the engine sees one file instead of
 * seven, which is what the memory-shaped limits actually care about (the
 * renderer reads every file into an ArrayBuffer at once, and `engine:save-files`
 * writes them all in one IPC message).
 *
 * It does not shorten anything, so it is offered alongside removal rather
 * than instead of it: a run that is too long for the device stays too long.
 *
 * Decoding is done through the Web Audio API, the same route the dropzone
 * already uses for durations and waveforms, and the result is written as
 * 16-bit mono PCM — which is exactly what engine/trainer.py's
 * preprocess_vocals() reduces every input to anyway (mono, resampled,
 * loudness-normalised), so nothing the trainer would have used is lost.
 */
import { pcmToWavBlob } from './audio'

/** Sample rate of the merged file. Matches SYNTH_SR in engine/trainer.py. */
export const MERGE_SAMPLE_RATE = 22_050

/** Silence inserted between takes so two clips don't run into each other. */
export const MERGE_GAP_SEC = 0.25

export interface MergeResult {
  file:     File
  /** Length of the merged audio, in seconds. */
  duration: number
  /** How many inputs went in — the merged file replaces exactly these. */
  sourceCount: number
}

/** Mixes an AudioBuffer's channels down to one, without changing its rate. */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < channel.length; i++) out[i] += channel[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels
  return out
}

/**
 * Linear resample onto `MERGE_SAMPLE_RATE`.
 *
 * The same interpolation engine/train_dataset.py uses to reconcile two
 * already-decoded WAVs: not an anti-aliased broadcast resample, and it
 * doesn't need to be — the trainer resamples to this exact rate with the
 * same technique before it ever sees the file.
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate))
  const out = new Float32Array(outLength)
  const ratio = (samples.length - 1) / Math.max(1, outLength - 1)
  for (let i = 0; i < outLength; i++) {
    const pos  = i * ratio
    const left = Math.floor(pos)
    const frac = pos - left
    const a = samples[left] ?? 0
    const b = samples[left + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

/**
 * Join decoded mono tracks end to end, separated by `gapSec` of silence.
 *
 * The gap is deliberate: preprocess_vocals() slices the result into
 * fixed-length chunks with no regard for where one take ended, so butting two
 * recordings against each other manufactures a discontinuity mid-chunk that
 * the model would learn as a click.
 */
export function concatWithGaps(
  tracks: Float32Array[], sampleRate: number, gapSec = MERGE_GAP_SEC,
): Float32Array {
  const usable = tracks.filter((t) => t.length > 0)
  if (usable.length === 0) return new Float32Array(0)

  const gap   = Math.max(0, Math.round(gapSec * sampleRate))
  const total = usable.reduce((sum, t) => sum + t.length, 0) + gap * (usable.length - 1)
  const out   = new Float32Array(total)

  let offset = 0
  usable.forEach((track, i) => {
    out.set(track, offset)
    offset += track.length + (i < usable.length - 1 ? gap : 0)
  })
  return out
}

/** Names the merged file after the first input, so it is recognisable in the list. */
export function mergedFileName(firstName: string): string {
  const base = firstName.replace(/\.[^.]+$/, '')
  return `${base}_merged.wav`
}

/**
 * Decode every file, concatenate, and return the result as a single File.
 *
 * `decode` is injected so the merge logic is testable without a real
 * AudioContext; production passes the browser's decodeAudioData.
 */
export async function mergeAudioFiles(
  files: File[],
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<MergeResult> {
  if (files.length === 0) throw new Error('mergeAudioFiles: nothing to merge')

  const tracks: Float32Array[] = []
  for (const file of files) {
    const buffer = await decode(await file.arrayBuffer())
    tracks.push(resampleLinear(mixToMono(buffer), buffer.sampleRate, MERGE_SAMPLE_RATE))
  }

  const merged = concatWithGaps(tracks, MERGE_SAMPLE_RATE)
  const blob   = pcmToWavBlob(merged, MERGE_SAMPLE_RATE)
  const name   = mergedFileName(files[0].name)

  return {
    file:        new File([blob], name, { type: 'audio/wav' }),
    duration:    merged.length / MERGE_SAMPLE_RATE,
    sourceCount: files.length,
  }
}
