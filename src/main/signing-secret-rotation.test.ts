/**
 * Rotating the HMAC signing secret without logging every subscriber out.
 *
 * Both ends hold the same secret, so the moment the service signs with a new
 * one, every token already issued stops verifying — which to this app reads as
 * a license that was revoked, for people whose subscription is perfectly
 * current. These cover the two-step way out: a build that accepts the outgoing
 * secret as well, and the swap that lets the window close again.
 */
import { describe, expect, it } from 'vitest'
import { LICENSE_CONFIG } from './license-config'
import type { LicensePayload } from './subscription-monitor'
import { createToken, verifyToken, verifiedWithPreviousSecret } from './subscription-monitor'
import { createHmac } from 'crypto'

const OLD_SECRET = 'the-outgoing-secret-v1'
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'LICENSE' })).toString('base64url')

const payload: LicensePayload = {
  userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345',
  expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
  issuedAt: Math.floor(Date.now() / 1000),
  features: ['training', 'synthesis', 'separation', 'cover'],
}

/** A token as the service would have signed it with `secret`. */
function tokenSignedWith(secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${HEADER}.${body}`).digest('hex')
  return `${HEADER}.${body}.${sig}`
}

/** Puts the config in the state a mid-rotation build is in, and restores it. */
function whileRotating(body: () => void): void {
  const config = LICENSE_CONFIG as { previousSigningSecret: string }
  const before = config.previousSigningSecret
  config.previousSigningSecret = OLD_SECRET
  try {
    body()
  } finally {
    config.previousSigningSecret = before
  }
}

describe('rotating the signing secret', () => {
  it('refuses a token from the outgoing secret when no rotation is in flight', () => {
    // The default state, and the problem this exists to solve: a genuine
    // license from before the switch is indistinguishable from a forgery.
    expect(verifyToken(tokenSignedWith(OLD_SECRET))).toBeNull()
    expect(verifiedWithPreviousSecret(tokenSignedWith(OLD_SECRET))).toBe(false)
  })

  it('honours a token from the outgoing secret while the window is open', () => {
    whileRotating(() => {
      const stale = tokenSignedWith(OLD_SECRET)
      expect(verifyToken(stale)?.licenseKey).toBe('KEY12345')
      expect(verifiedWithPreviousSecret(stale)).toBe(true)
    })
  })

  it('still honours a token from the current secret, and does not flag it', () => {
    whileRotating(() => {
      const current = createToken(payload)
      expect(verifyToken(current)?.licenseKey).toBe('KEY12345')
      // Nothing to swap: flagging it would mean a server round trip on every
      // launch, for nothing.
      expect(verifiedWithPreviousSecret(current)).toBe(false)
    })
  })

  it('refuses a token signed with neither secret', () => {
    whileRotating(() => {
      const forged = tokenSignedWith('not-either-of-them')
      expect(verifyToken(forged)).toBeNull()
      // And a forgery is not "signed with the previous secret" either — that
      // flag drives a refresh, not an admission.
      expect(verifiedWithPreviousSecret(forged)).toBe(false)
    })
  })

  it('signs only with the current secret, never the outgoing one', () => {
    whileRotating(() => {
      const minted = createToken(payload)
      const config = LICENSE_CONFIG as { previousSigningSecret: string }
      config.previousSigningSecret = ''
      // With the window closed, what this build just minted still verifies —
      // which it would not if signing had reached for the outgoing secret.
      expect(verifyToken(minted)).not.toBeNull()
      config.previousSigningSecret = OLD_SECRET
    })
  })
})
