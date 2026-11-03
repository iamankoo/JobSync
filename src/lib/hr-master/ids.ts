import { createHash } from "node:crypto";

/**
 * ContactID strategy: "HRC-" + the first 12 hex characters (upper-case) of SHA-256 over the NORMALISED primary e-mail address.
 *  - Stable: independent of file order, row numbers, research results and of which source supplied the contact.
 *  - Re-derivable by a future importer straight from the e-mail, which doubles as the duplicate-prevention key.
 *  - 48 bits: collisions among tens of thousands of contacts are astronomically unlikely, and the builder asserts uniqueness.
 */
export function contactIdFor(normalizedEmail: string): string {
  return "HRC-" + createHash("sha256").update(normalizedEmail, "utf8").digest("hex").slice(0, 12).toUpperCase();
}

export function duplicateGroupIdFor(emails: readonly string[]): string {
  return "DG-" + createHash("sha256").update([...emails].sort().join("|"), "utf8").digest("hex").slice(0, 8).toUpperCase();
}
