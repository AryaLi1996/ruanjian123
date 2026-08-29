import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assetFileName, requiredAssets, missingAssets, isTrainingReady, collectProjectAssets,
} from './project-assets'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'project-assets-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function writeAudio(name: string): Promise<string> {
  const p = join(root, name)
  await fs.writeFile(p, name)   // contents are irrelevant; only the copy is under test
  return p
}

describe('assetFileName', () => {
  it('maps engine stem names onto the standard file names', () => {
    expect(assetFileName('vocals', 'standard')).toBe('vocals.wav')
    expect(assetFileName('accompaniment', 'standard')).toBe('accompaniment.wav')
    expect(assetFileName('lead_dry', 'enhanced')).toBe('lead_vocal.wav')
    expect(assetFileName('harmony_dry', 'enhanced')).toBe('backing_vocal.wav')
  })

  it('stores the enhanced-mode accompaniment as instrumentals.wav', () => {
    expect(assetFileName('accompaniment', 'enhanced')).toBe('instrumentals.wav')
  })

  it('ignores stems it has no standard name for', () => {
    expect(assetFileName('something_new', 'standard')).toBeNull()
  })
})

describe('missingAssets', () => {
  it('requires vocals + accompaniment in standard mode', () => {
    expect(requiredAssets('standard')).toEqual(['vocals.wav', 'accompaniment.wav'])
    expect(missingAssets({ 'vocals.wav': '/a' }, 'standard')).toEqual(['accompaniment.wav'])
    expect(isTrainingReady({ 'vocals.wav': '/a', 'accompaniment.wav': '/b' }, 'standard')).toBe(true)
  })

  it('treats no separation at all as everything missing', () => {
    expect(missingAssets(null, 'enhanced'))
      .toEqual(['lead_vocal.wav', 'backing_vocal.wav', 'instrumentals.wav'])
    expect(isTrainingReady(null, 'standard')).toBe(false)
  })
})

describe('collectProjectAssets', () => {
  it('copies standard-mode stems and the original into the project folder', async () => {
    const result = await collectProjectAssets({
      projectsDir:  join(root, 'projects'),
      projectId:    'project_123',
      mode:         'standard',
      originalPath: await writeAudio('downloaded.mp3'),
      stems: {
        vocals:        await writeAudio('song_vocals.wav'),
        accompaniment: await writeAudio('song_accompaniment.wav'),
      },
    })

    expect(result.projectDir).toBe(join(root, 'projects', 'project_123'))
    expect(result.missing).toEqual([])
    expect(Object.keys(result.assets).sort())
      .toEqual(['accompaniment.wav', 'original.wav', 'vocals.wav'])
    expect(await fs.readFile(result.assets['vocals.wav'], 'utf8')).toBe('song_vocals.wav')
    expect(await fs.readFile(result.assets['original.wav'], 'utf8')).toBe('downloaded.mp3')
  })

  it('copies enhanced-mode stems under their three-stem names', async () => {
    const result = await collectProjectAssets({
      projectsDir: join(root, 'projects'),
      projectId:   'p2',
      mode:        'enhanced',
      stems: {
        lead_dry:      await writeAudio('song_lead_dry.wav'),
        harmony_dry:   await writeAudio('song_harmony_dry.wav'),
        accompaniment: await writeAudio('song_accompaniment.wav'),
      },
    })

    expect(result.missing).toEqual([])
    expect(Object.keys(result.assets).sort())
      .toEqual(['backing_vocal.wav', 'instrumentals.wav', 'lead_vocal.wav'])
    expect(await fs.readFile(result.assets['instrumentals.wav'], 'utf8')).toBe('song_accompaniment.wav')
  })

  it('leaves the source stems in place so preview keeps working', async () => {
    const vocals = await writeAudio('song_vocals.wav')
    await collectProjectAssets({
      projectsDir: join(root, 'projects'), projectId: 'p3', mode: 'standard',
      stems: { vocals, accompaniment: await writeAudio('song_accompaniment.wav') },
    })
    await expect(fs.access(vocals)).resolves.toBeUndefined()
  })

  it('reports what is missing instead of throwing when a stem cannot be copied', async () => {
    const result = await collectProjectAssets({
      projectsDir: join(root, 'projects'),
      projectId:   'p4',
      mode:        'standard',
      stems: {
        vocals:        join(root, 'gone.wav'),   // never written
        accompaniment: await writeAudio('song_accompaniment.wav'),
      },
    })

    expect(result.assets['accompaniment.wav']).toBeTruthy()
    expect(result.assets['vocals.wav']).toBeUndefined()
    expect(result.missing).toEqual(['vocals.wav'])
  })
})
