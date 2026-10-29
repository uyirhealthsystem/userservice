import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

// Encryption at rest for health-record files (AES-256-GCM, DATA_ENCRYPTION_KEY).
// Stored as: version byte (1) | 12-byte IV | 16-byte auth tag | ciphertext.
// The version byte leaves room for a key rotation later.

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const encryptionEnabled = () => env.dataEncryptionKey !== undefined;

/** Encrypts when a key is configured; `encrypted` says which it did. */
export function sealBytes(plain: Buffer): { content: Uint8Array<ArrayBuffer>; encrypted: boolean } {
  const key = env.dataEncryptionKey;
  if (!key) return { content: new Uint8Array(plain), encrypted: false };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { content: new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])), encrypted: true };
}

/** The file as received, whichever way it was stored. */
export function openBytes(stored: Uint8Array, encrypted: boolean): Buffer {
  const data = Buffer.from(stored);
  if (!encrypted) return data;
  const key = env.dataEncryptionKey;
  if (!key) throw new Error("an encrypted file was read but DATA_ENCRYPTION_KEY is not set");
  if (data[0] !== VERSION) throw new Error(`unknown encrypted file version ${data[0]}`);
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}
