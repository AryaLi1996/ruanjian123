/**
 * Machine-bound AES-256-GCM key management and model file encryption.
 *
 * Key derivation:
 *   key = SHA-256(random_seed[16] | machine_fingerprint | app_salt)
 *
 * The random_seed is stored in userData/keys/model.key; the machine
 * fingerprint is re-derived at runtime (hostname + CPU model + arch).
 * Copying model.key + model.enc to another machine produces a different
 * key → AES-GCM authentication fails → model cannot be loaded.
 *
 * Encrypted file layout:  nonce[12] | auth_tag[16] | ciphertext[N]
 */
import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as os from 'os'

const KEY_FILE   = join('keys', 'model.key')   // relative to userData
const APP_SALT   = 'ruanjian-v1-model-key-2026'
const NONCE_LEN  = 12
const TAG_LEN    = 16

// ── Machine fingerprint ───────────────────────────────────────────────────────

function machineFingerprint(): string {
  const cpu = os.cpus()[0]?.model ?? 'unknown-cpu'
  return `${os.hostname()}|${os.platform()}-${os.arch()}|${cpu}`
}

// ── Key persistence ───────────────────────────────────────────────────────────

let _cachedKey: Buffer | null = null

export async function getModelKey(): Promise<Buffer> {
  if (_cachedKey) return _cachedKey

  const keyPath = join(app.getPath('userData'), KEY_FILE)

  try {
    // Load existing random seed and re-derive key with current machine fingerprint
    const seed = await fs.readFile(keyPath)           // 16 random bytes
    _cachedKey  = deriveKey(seed)
    return _cachedKey
  } catch {
    // First run — generate a new random seed
    const seed = randomBytes(16)
    await fs.mkdir(join(app.getPath('userData'), 'keys'), { recursive: true })
    await fs.writeFile(keyPath, seed, { mode: 0o600 }) // owner-read-only
    _cachedKey = deriveKey(seed)
    return _cachedKey
  }
}

function deriveKey(seed: Buffer): Buffer {
  return createHash('sha256')
    .update(seed)
    .update(Buffer.from(machineFingerprint()))
    .update(Buffer.from(APP_SALT))
    .digest()   // 32-byte AES-256 key
}

export function getModelKeyHex(key: Buffer): string {
  return key.toString('hex')  // 64 hex chars
}

// ── Encryption ────────────────────────────────────────────────────────────────

/** Encrypt raw ONNX bytes → nonce[12] | tag[16] | ciphertext[N]. */
export async function encryptModelBytes(plaintext: Buffer): Promise<Buffer> {
  const key    = await getModelKey()
  const nonce  = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc    = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag    = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, enc])
}

/** Decrypt nonce | tag | ciphertext back to ONNX bytes. Throws on auth failure. */
export async function decryptModelBytes(encrypted: Buffer): Promise<Buffer> {
  const key     = await getModelKey()
  const nonce   = encrypted.subarray(0, NONCE_LEN)
  const tag     = encrypted.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN)
  const ct      = encrypted.subarray(NONCE_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** Encrypt a model file on disk and return the .enc path. */
export async function encryptModelFile(modelPath: string): Promise<string> {
  const plain   = await fs.readFile(modelPath)
  const enc     = await encryptModelBytes(plain)
  const encPath = modelPath.replace(/\.onnx$/, '.enc')
  await fs.writeFile(encPath, enc, { mode: 0o600 })
  return encPath
}

/** Decrypt a .enc file and return plaintext ONNX bytes (never written to disk). */
export async function decryptModelFile(encPath: string): Promise<Buffer> {
  const enc = await fs.readFile(encPath)
  return decryptModelBytes(enc)
}
