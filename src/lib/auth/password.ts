import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

const OPTS: ScryptOptions = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

/** Salted scrypt hash, stored as `scrypt1$<salt>$<hash>` (base64). The plaintext is never stored. */
export async function hashSecret(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, KEY_LEN, OPTS);
  return `scrypt1$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Constant-time check of `plain` against a stored hash. False for anything malformed. */
export async function verifySecret(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt1" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  if (expected.length !== KEY_LEN) return false;
  const actual = await scrypt(plain, Buffer.from(saltB64, "base64"), KEY_LEN, OPTS);
  return timingSafeEqual(actual, expected);
}
