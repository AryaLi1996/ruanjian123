/**
 * Pure decision/action logic for the Ticket 40 userData migration, split out
 * of index.ts so it's actually unit-testable — the original version called
 * app.getPath()/existsSync/renameSync directly, which meant this had only
 * ever been exercised manually (scratch-copy simulations and one live run
 * against real license/trial/model data). Electron/fs access is injected via
 * `deps` instead.
 */

export interface MigrationDeps {
  exists: (path: string) => boolean
  rename: (oldPath: string, newPath: string) => void
  join:   (...segments: string[]) => string
}

export type MigrationOutcome =
  | { status: 'skipped'; reason: 'same-dir' | 'no-old-dir' | 'already-migrated' }
  | { status: 'migrated' }
  | { status: 'failed'; error: unknown }

/**
 * Whether `newDir` should be treated as "already has a real profile" is
 * decided by the presence of the `.initialized` marker file (written by
 * markInitialized() in index.ts on first successful launch), not merely by
 * `newDir` existing on disk.
 *
 * That distinction matters: Electron's own app.getPath('userData') creates
 * the directory as a side effect of being called — encountered exactly this
 * while testing this fix, where an early, unrelated getPath('userData') call
 * silently pre-created an empty newDir and made the migration's old
 * `existsSync(newDir)` check false-negative forever after. A stray empty
 * directory (from that, or from anyone who happened to run an earlier
 * buggy/prerelease build under the new name) must not permanently strand
 * the old directory's real data behind it.
 */
export function planUserDataMigration(
  oldDir: string,
  newDir: string,
  deps: Pick<MigrationDeps, 'exists' | 'join'>,
): MigrationOutcome | { status: 'migrate' } {
  if (oldDir === newDir) return { status: 'skipped', reason: 'same-dir' }
  if (!deps.exists(oldDir)) return { status: 'skipped', reason: 'no-old-dir' }
  if (deps.exists(deps.join(newDir, '.initialized'))) {
    return { status: 'skipped', reason: 'already-migrated' }
  }
  return { status: 'migrate' }
}

/**
 * Runs the plan above and actually performs the rename. Split from
 * planUserDataMigration() so the decision logic (the part worth asserting
 * on in detail) can be tested without touching a real filesystem, while this
 * wrapper covers the success/failure outcome of the actual rename attempt.
 *
 * A failure here (e.g. a leftover non-empty newDir from the exact stray-
 * directory scenario above — fs.rename onto a non-empty directory throws
 * ENOTEMPTY — or a permissions/AV-lock issue) intentionally does NOT delete
 * or otherwise touch either directory: the old data stays exactly where it
 * was, recoverable by hand. The caller surfaces this to the user instead of
 * only logging it (see index.ts's post-launch dialog).
 */
export function migrateUserData(
  oldDir: string,
  newDir: string,
  deps: MigrationDeps,
): MigrationOutcome {
  const plan = planUserDataMigration(oldDir, newDir, deps)
  if (plan.status !== 'migrate') return plan
  try {
    deps.rename(oldDir, newDir)
    return { status: 'migrated' }
  } catch (error) {
    return { status: 'failed', error }
  }
}
