import { describe, expect, it, vi } from 'vitest'
import { migrateUserData, planUserDataMigration } from './user-data-migration'

const join = (...segments: string[]): string => segments.join('/')

function makeFsDouble(initialFiles: Set<string>) {
  const files = new Set(initialFiles)
  return {
    files,
    exists: (path: string) => files.has(path),
    rename: vi.fn((oldPath: string, newPath: string) => {
      if (!files.has(oldPath)) throw new Error(`ENOENT: ${oldPath}`)
      files.delete(oldPath)
      files.add(newPath)
    }),
  }
}

describe('planUserDataMigration', () => {
  it('skips when old and new dirs are the same path', () => {
    const fs = makeFsDouble(new Set(['/data/ruanjian']))
    const plan = planUserDataMigration('/data/ruanjian', '/data/ruanjian', { exists: fs.exists, join })
    expect(plan).toEqual({ status: 'skipped', reason: 'same-dir' })
  })

  it('skips when the old dir does not exist (fresh install, nothing to migrate)', () => {
    const fs = makeFsDouble(new Set())
    const plan = planUserDataMigration('/data/ruanjian', '/data/SootheVoice', { exists: fs.exists, join })
    expect(plan).toEqual({ status: 'skipped', reason: 'no-old-dir' })
  })

  it('plans to migrate when old dir exists and new dir has no .initialized marker', () => {
    const fs = makeFsDouble(new Set(['/data/ruanjian']))
    const plan = planUserDataMigration('/data/ruanjian', '/data/SootheVoice', { exists: fs.exists, join })
    expect(plan).toEqual({ status: 'migrate' })
  })

  // The core regression case this refactor exists for: a stray, data-less
  // newDir (created as a side effect of an early app.getPath('userData')
  // call, or left behind by an earlier buggy build) must not be mistaken
  // for "already migrated" just because it exists.
  it('still plans to migrate when new dir exists but has no .initialized marker', () => {
    const fs = makeFsDouble(new Set(['/data/ruanjian', '/data/SootheVoice', '/data/SootheVoice/Cache']))
    const plan = planUserDataMigration('/data/ruanjian', '/data/SootheVoice', { exists: fs.exists, join })
    expect(plan).toEqual({ status: 'migrate' })
  })

  it('skips as already-migrated only when new dir has the .initialized marker', () => {
    const fs = makeFsDouble(new Set([
      '/data/ruanjian',
      '/data/SootheVoice',
      '/data/SootheVoice/.initialized',
    ]))
    const plan = planUserDataMigration('/data/ruanjian', '/data/SootheVoice', { exists: fs.exists, join })
    expect(plan).toEqual({ status: 'skipped', reason: 'already-migrated' })
  })
})

describe('migrateUserData', () => {
  it('renames the old dir to the new dir and reports migrated', () => {
    const fs = makeFsDouble(new Set(['/data/ruanjian']))
    const outcome = migrateUserData('/data/ruanjian', '/data/SootheVoice', { ...fs, join })
    expect(outcome).toEqual({ status: 'migrated' })
    expect(fs.files.has('/data/SootheVoice')).toBe(true)
    expect(fs.files.has('/data/ruanjian')).toBe(false)
    expect(fs.rename).toHaveBeenCalledWith('/data/ruanjian', '/data/SootheVoice')
  })

  it('does not call rename at all when the plan says skip', () => {
    const fs = makeFsDouble(new Set())
    const outcome = migrateUserData('/data/ruanjian', '/data/SootheVoice', { ...fs, join })
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-old-dir' })
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('reports failed, and leaves both directories untouched, when rename throws', () => {
    const fs = makeFsDouble(new Set(['/data/ruanjian']))
    const boom = new Error('ENOTEMPTY: directory not empty')
    const rename = vi.fn(() => { throw boom })
    const outcome = migrateUserData('/data/ruanjian', '/data/SootheVoice', { exists: fs.exists, rename, join })
    expect(outcome).toEqual({ status: 'failed', error: boom })
    // Neither side was mutated by the throwing rename stub, matching what a
    // real fs.renameSync failure does (it's atomic: either it fully
    // succeeds or nothing moves) — old data must still be recoverable.
    expect(fs.files.has('/data/ruanjian')).toBe(true)
    expect(fs.files.has('/data/SootheVoice')).toBe(false)
  })
})
