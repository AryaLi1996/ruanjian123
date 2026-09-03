/**
 * The device id's one job is surviving a reinstall: a machine that already
 * spent its trial must derive the same id afterwards, or the service quite
 * correctly hands it another one.
 *
 * Before Ticket 76 it was every non-loopback MAC present at that moment, so
 * starting Docker, joining a VPN or docking a laptop changed the set — and the
 * reinstall that followed looked like a brand-new machine. These cover the
 * derivation with the OS probes stubbed, so they exercise the logic rather
 * than whatever machine the suite runs on.
 */
import { describe, expect, it } from 'vitest'
import { hardwareSignal, isLocallyAdministered, readMachineId } from './device-id'

/** A burned-in address: bit 1 of the first octet clear. */
const BURNED_IN = '3c:22:fb:11:22:33'

type Iface = { mac: string; internal?: boolean }
const source = (interfaces: Record<string, Iface[]>) => ({
  networkInterfaces: () => interfaces,
  platform: () => 'linux',
  arch: () => 'x64',
})

const NO_MACHINE_ID = {
  readFileSync: () => { throw new Error('ENOENT') },
  execFileSync: () => { throw new Error('ENOENT') },
}

describe('isLocallyAdministered()', () => {
  it('tells a randomised address from a burned-in one', () => {
    // macOS and Windows hand out a different private MAC per network by
    // default; its locally-administered bit is set, which is how it is told
    // apart without having to know every interface name.
    expect(isLocallyAdministered('aa:bb:cc:dd:ee:ff')).toBe(true)
    expect(isLocallyAdministered('02:42:ac:11:00:02')).toBe(true)  // Docker
    expect(isLocallyAdministered(BURNED_IN)).toBe(false)
  })
})

describe('hardwareSignal()', () => {
  it('ignores adapters that come and go, which is what broke the reinstall', () => {
    const bare = hardwareSignal(source({ eth0: [{ mac: BURNED_IN }] }))
    const cluttered = hardwareSignal(source({
      eth0: [{ mac: BURNED_IN }],
      docker0: [{ mac: '02:42:ac:11:00:02' }],
      vmnet1: [{ mac: '00:50:56:c0:00:08' }],
      utun3: [{ mac: '3a:9f:1b:44:55:66' }],
    }))
    expect(cluttered).toBe(bare)
    expect(bare).not.toBeNull()
  })

  it('ignores a randomised Wi-Fi address, so changing network is not a new device', () => {
    const onOneNetwork = hardwareSignal(source({
      eth0: [{ mac: BURNED_IN }], en0: [{ mac: 'aa:bb:cc:dd:ee:ff' }],
    }))
    const onAnother = hardwareSignal(source({
      eth0: [{ mac: BURNED_IN }], en0: [{ mac: '9e:11:22:33:44:55' }],
    }))
    expect(onAnother).toBe(onOneNetwork)
  })

  it('ignores loopback and placeholder adapters', () => {
    expect(hardwareSignal(source({
      lo: [{ mac: '11:22:33:44:55:66', internal: true }],
      eth0: [{ mac: '00:00:00:00:00:00' }],
    }))).toBeNull()
  })

  it('returns null rather than a signal built only from unstable adapters', () => {
    // Null sends getDeviceId to the random-UUID fallback, which is honest
    // about not surviving — better than an id that silently changes.
    expect(hardwareSignal(source({ docker0: [{ mac: '02:42:ac:11:00:02' }] }))).toBeNull()
  })
})

describe('readMachineId()', () => {
  it('reads the identifier each platform actually keeps', () => {
    const calls: string[][] = []
    const deps = {
      readFileSync: (f: string) => { calls.push(['read', f]); throw new Error('ENOENT') },
      execFileSync: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        if (cmd.endsWith('ioreg')) return '  "IOPlatformUUID" = "F1E2D3C4-B5A6"\n'
        return 'MachineGuid    REG_SZ    9a8b7c6d-5e4f\r\n'
      },
    }
    expect(readMachineId('darwin', deps)).toBe('F1E2D3C4-B5A6')
    expect(readMachineId('win32', deps)).toBe('9a8b7c6d-5e4f')
    readMachineId('linux', deps)
    expect(calls.some((c) => c[1] === '/etc/machine-id')).toBe(true)
    // A 32-bit build must not be redirected to the WOW6432 view, where
    // MachineGuid is a different value.
    expect(calls.some((c) => c.includes('/reg:64'))).toBe(true)
  })

  it('falls back to the dbus copy on a host without /etc/machine-id', () => {
    const deps = {
      readFileSync: (f: string) => {
        if (f === '/var/lib/dbus/machine-id') return 'dbus-machine-id-value\n'
        throw new Error('ENOENT')
      },
    }
    expect(readMachineId('linux', deps)).toBe('dbus-machine-id-value')
  })

  it('treats an unreadable probe as "no machine id" rather than failing', () => {
    // A missing binary, a denied registry read or a timeout must fall through
    // to the next signal, not take the app down at launch.
    expect(readMachineId('linux', NO_MACHINE_ID)).toBeNull()
    expect(readMachineId('darwin', NO_MACHINE_ID)).toBeNull()
    expect(readMachineId('win32', NO_MACHINE_ID)).toBeNull()
    expect(readMachineId('sunos', NO_MACHINE_ID)).toBeNull()
  })
})
