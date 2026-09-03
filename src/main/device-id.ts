/**
 * Anonymous, stable device identifier (Ticket 33 §5, revised by Ticket 76).
 *
 * Used only to prevent one physical machine from claiming more than one free
 * trial — a separate concern from the anonymous *payment* user id in
 * subscription-monitor.ts (`_getOrCreateAnonId`), which never needs hardware
 * binding since it only exists to correlate a user's own orders.
 *
 * Three signals, in falling order of how well they survive a reinstall:
 *
 *   1. The operating system's own machine id — `/etc/machine-id`,
 *      `IOPlatformUUID`, `MachineGuid`. Written when the OS was installed and
 *      untouched by anything this app does, which is exactly the property
 *      wanted here.
 *   2. A filtered MAC signal, for a host that reports no machine id.
 *   3. A random UUID — Ticket 33 §2 accepts this; it just will not survive a
 *      reinstall, which is better than refusing to start a trial.
 *
 * This used to be (2) alone, unfiltered, and that is why reinstalling on a
 * physical machine handed out a fresh trial. The signal was every non-loopback
 * adapter present *at that moment*: Docker's bridge, a VPN's tun device, a
 * dock's ethernet — and, decisively, Wi-Fi MAC randomisation, which macOS and
 * Windows apply per-network by default. Join a different network between the
 * uninstall and the reinstall and the set differs, so the digest differs, and
 * the service quite correctly sees a machine it has never met.
 *
 * The id is not a secret (same threat model as the anonymous payment id), so
 * it is stored in plaintext. Its format satisfies the service's
 * `_DEVICE_ID_RE` (`^[A-Za-z0-9_-]{16,128}$`).
 */
import { createHash, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { promises as fs, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as os from 'os'

const DEVICE_ID_FILE = '.device_id'

/** A hung `ioreg` or `reg` must not hold up launch. */
const PROBE_TIMEOUT_MS = 2000

/** Injection seam for the OS probes, so the derivation can be tested without
 *  reading whatever machine the suite happens to run on. */
export interface MachineIdDeps {
  readFileSync?: (path: string, encoding: 'utf8') => string
  execFileSync?: (cmd: string, args: string[], opts: object) => string | Buffer
}

/**
 * Whether a MAC is one the machine made up rather than one burned into an
 * adapter.
 *
 * Bit 1 of the first octet is the "locally administered" flag, and it is set
 * by everything unstable worth excluding: randomised Wi-Fi addresses, Docker
 * and container bridges, most hypervisor adapters, VPN interfaces. A real
 * NIC's burned-in address has it clear — one test for the whole class of
 * drift that name matching can only guess at.
 */
export function isLocallyAdministered(mac: string): boolean {
  const firstOctet = parseInt(String(mac).slice(0, 2), 16)
  return Number.isFinite(firstOctet) && (firstOctet & 0x02) !== 0
}

/** Interfaces whose presence depends on what is running, not on what the
 *  machine is. Matched on name because some do hand out globally
 *  administered addresses. */
const VIRTUAL_IFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|utun|wg|ppp|awdl|llw|zt|ham|Hyper-V|VMware|VirtualBox|Bluetooth|Loopback|Teredo|isatap)/i

type Interfaces = Record<string, Array<{ mac?: string; internal?: boolean }> | undefined>

/**
 * Something stable about this machine's hardware, or null when nothing
 * survives the filtering — a better answer than a signal that changes when
 * Docker starts.
 */
export function hardwareSignal(source: {
  networkInterfaces: () => Interfaces
  platform: () => string
  arch: () => string
} = os as never): string | null {
  const macs = Object.entries(source.networkInterfaces() || {})
    .filter(([name]) => !VIRTUAL_IFACE.test(name))
    .flatMap(([, addrs]) => (addrs || []).filter(Boolean))
    .filter((iface) => !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00')
    .filter((iface) => !isLocallyAdministered(iface.mac as string))
    .map((iface) => (iface.mac as string).toLowerCase())

  if (macs.length === 0) return null

  const unique = Array.from(new Set(macs)).sort()
  return `${unique.join(',')}|${source.platform()}|${source.arch()}`
}

/**
 * A machine id the OS keeps, or null. Every failure is a null: this is one of
 * three signals and the next one is right there.
 */
export function readMachineId(platform: string, deps: MachineIdDeps = {}): string | null {
  const read = deps.readFileSync ?? readFileSync
  const run = deps.execFileSync ?? execFileSync
  const exec = (cmd: string, args: string[]): string =>
    String(run(cmd, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }))

  try {
    if (platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = String(read(file, 'utf8')).trim()
          if (id) return id
        } catch { /* try the next one */ }
      }
      return null
    }

    if (platform === 'darwin') {
      const out = exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      return out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null
    }

    if (platform === 'win32') {
      // /reg:64 so a 32-bit build is not silently redirected to the WOW6432
      // view, where MachineGuid is a different value.
      const out = exec('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64',
      ])
      return out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] ?? null
    }
  } catch {
    // Not installed, not permitted, timed out, or an OS that has none.
  }
  return null
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

let _cached: string | null = null

/**
 * This machine's id, creating and persisting one on first call.
 *
 * A previously stored id always wins. That is what makes this change safe to
 * ship: every install that already has a `.device_id` keeps it, so nobody's
 * trial resets and nobody is handed a second one. The new derivation applies
 * only where there is nothing stored — a new install, or the reinstall this
 * exists to get right.
 */
export async function getDeviceId(deps: MachineIdDeps = {}): Promise<string> {
  if (_cached) return _cached

  const idPath = join(app.getPath('userData'), DEVICE_ID_FILE)

  if (existsSync(idPath)) {
    try {
      const id = (await fs.readFile(idPath, 'utf8')).trim()
      if (id) { _cached = id; return id }
    } catch { /* fall through and regenerate */ }
  }

  // Prefixed before hashing so a machine id and a MAC signal cannot collide,
  // and so the raw OS identifier never leaves this process.
  const machineId = readMachineId(os.platform(), deps)
  const signal = machineId
    ? `machine:${machineId}|${os.platform()}|${os.arch()}`
    : hardwareSignal()

  const id = signal ? hash(signal) : randomUUID()

  try {
    await fs.writeFile(idPath, id, { mode: 0o600 })
  } catch { /* best-effort persistence — id is still usable this session */ }

  _cached = id
  return id
}

/** Test seam: forget the memoised id. */
export function resetCache(): void {
  _cached = null
}
