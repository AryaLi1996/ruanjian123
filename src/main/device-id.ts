/**
 * Anonymous, hardware-bound device identifier (Ticket 33 §5).
 *
 * Used only to prevent one physical machine from claiming more than one
 * free trial — a separate concern from the anonymous *payment* user id in
 * subscription-monitor.ts (`_getOrCreateAnonId`), which never needs
 * hardware binding since it only exists to correlate a user's own orders.
 *
 * Strategy:
 *   1. Reuse the id already persisted on this machine, if any.
 *   2. Otherwise derive one from stable hardware signals (MAC addresses +
 *      platform/arch), so reinstalling the app recomputes the *same* id and
 *      a fresh trial isn't granted for free (matches Ticket 33 §5's
 *      preference for hardware binding, without adding a native dependency
 *      like node-machine-id).
 *   3. If no usable MAC address is available (e.g. a VM with a stripped
 *      adapter list), fall back to a random UUID — Ticket 33 §2 explicitly
 *      accepts this as a fallback; it just won't survive a reinstall.
 * The id is not a secret (same threat model as the existing anonymous
 * payment id), so it's stored in plaintext.
 */
import { createHash, randomUUID } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as os from 'os'

const DEVICE_ID_FILE = '.device_id'

function hardwareSignal(): string | null {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface): iface is NonNullable<typeof iface> => Boolean(iface))
    // Exclude internal (loopback) interfaces and the placeholder MAC some
    // platforms report when no real adapter is present.
    .filter((iface) => !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00')
    .map((iface) => iface.mac.toLowerCase())

  if (macs.length === 0) return null

  const unique = Array.from(new Set(macs)).sort()
  return `${unique.join(',')}|${os.platform()}|${os.arch()}`
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

let _cached: string | null = null

export async function getDeviceId(): Promise<string> {
  if (_cached) return _cached

  const idPath = join(app.getPath('userData'), DEVICE_ID_FILE)

  if (existsSync(idPath)) {
    try {
      const id = (await fs.readFile(idPath, 'utf8')).trim()
      if (id) { _cached = id; return id }
    } catch { /* fall through and regenerate */ }
  }

  const signal = hardwareSignal()
  const id = signal ? hash(signal) : randomUUID()

  try {
    await fs.writeFile(idPath, id, { mode: 0o600 })
  } catch { /* best-effort persistence — id is still usable this session */ }

  _cached = id
  return id
}
