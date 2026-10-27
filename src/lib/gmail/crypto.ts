import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for stored refresh tokens. The member ID is bound in as associated data, so a token copied
 * into another member's row fails to decrypt (one member's access can never be used for another).
 * Format: "v1." + base64url(iv[12] | tag[16] | ciphertext).
 */
export function encryptToken(plain: string, key: Buffer, memberId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`gmail:${memberId}`));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

/** Returns null if the value was tampered with, belongs to another member, or the key is wrong. */
export function decryptToken(stored: string, key: Buffer, memberId: string): string | null {
  if (!stored.startsWith("v1.")) return null;
  try {
    const buf = Buffer.from(stored.slice(3), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(`gmail:${memberId}`));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
