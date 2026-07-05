import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for the secrets vault (doc 07 §4.1, doc 08 `secrets`).
 * Each secret gets a fresh data key (DEK); the DEK is wrapped by a master key.
 * v1 master key comes from the FLOWGUARD_MASTER_KEY env var ("local master key
 * in dev", doc 09 Phase 4); a KMS-wrapped master key slots in later without
 * changing the stored format.
 *
 * Buffer layout for both ciphertext and wrapped DEK: iv(12) ‖ authTag(16) ‖ data.
 */
const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export const LOCAL_KMS_KEY_ID = "local:v1";

export interface EncryptedSecret {
  ciphertext: Buffer;
  dekWrapped: Buffer;
  kmsKeyId: string;
}

function seal(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function open(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = sealed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function parseMasterKey(hexOrBase64: string): Buffer {
  const buf = /^[0-9a-fA-F]{64}$/.test(hexOrBase64)
    ? Buffer.from(hexOrBase64, "hex")
    : Buffer.from(hexOrBase64, "base64");
  if (buf.length !== 32) {
    throw new Error("FLOWGUARD_MASTER_KEY must be 32 bytes (64 hex chars or base64)");
  }
  return buf;
}

export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedSecret {
  const dek = randomBytes(32);
  return {
    ciphertext: seal(dek, Buffer.from(plaintext, "utf8")),
    dekWrapped: seal(masterKey, dek),
    kmsKeyId: LOCAL_KMS_KEY_ID,
  };
}

export function decryptSecret(secret: Pick<EncryptedSecret, "ciphertext" | "dekWrapped">, masterKey: Buffer): string {
  const dek = open(masterKey, secret.dekWrapped);
  return open(dek, secret.ciphertext).toString("utf8");
}
