/** AES-256-GCM helpers built on the Web Crypto API (available in Electron renderer). */

export interface EncryptedPayload {
  ciphertext: ArrayBuffer
  iv:         Uint8Array   // 12-byte GCM nonce
}

export async function generateAESKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key)
}

export async function importKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

export async function encryptBuffer(plaintext: ArrayBuffer, key: CryptoKey): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { ciphertext, iv }
}

export async function decryptBuffer(payload: EncryptedPayload, key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: payload.iv.buffer as ArrayBuffer },
    key,
    payload.ciphertext,
  )
}

/** Encode key + iv + ciphertext as a single transferable blob (iv[12] | key[32] | ciphertext). */
export async function packPayload(payload: EncryptedPayload, key: CryptoKey): Promise<ArrayBuffer> {
  const keyRaw   = await exportKey(key)
  const out      = new Uint8Array(12 + 32 + payload.ciphertext.byteLength)
  out.set(payload.iv, 0)
  out.set(new Uint8Array(keyRaw), 12)
  out.set(new Uint8Array(payload.ciphertext), 44)
  return out.buffer
}

export async function unpackPayload(packed: ArrayBuffer): Promise<{ payload: EncryptedPayload; key: CryptoKey }> {
  const buf        = new Uint8Array(packed)
  const iv         = buf.slice(0, 12)
  const keyRaw     = buf.slice(12, 44).buffer
  const ciphertext = buf.slice(44).buffer
  const key        = await importKey(keyRaw)
  return { payload: { ciphertext, iv }, key }
}
