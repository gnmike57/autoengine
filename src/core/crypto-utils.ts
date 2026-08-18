/**
 * Shared crypto / hashing helpers used across the automation suite.
 *
 * Consolidates two djb2-style hashes that previously existed inline in
 * cloak-backend.ts (pickProxy email→pool index) and profile-determinism.ts
 * (hashEmailDomain). Single source of truth keeps both stable and avoids
 * drift if one is tweaked but the other isn't.
 */

import * as crypto from "crypto";

/** djb2 hash of an arbitrary string — returns a non-negative integer. */
export function djb2Hash(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash = hash & hash; // force int32
  }
  return Math.abs(hash);
}

/** Stable hash of an email's domain (case + whitespace normalised). */
export function emailDomainHash(email: string, rotation: number = 0): number {
  const atIndex = email.indexOf("@");
  let domain = (atIndex !== -1 ? email.substring(atIndex + 1) : email).toLowerCase().trim();
  if (rotation > 0) domain = `${domain}:rot${rotation}`;
  return djb2Hash(domain);
}

/** Stable hash of a full email (case + whitespace normalised). */
export function emailHash(email: string, rotation: number = 0): number {
  let input = email.toLowerCase().trim();
  if (rotation > 0) input = `${input}:rot${rotation}`;
  return djb2Hash(input);
}

/** Derive a deterministic 5-digit fingerprint seed from an account email
 *  so the same account always presents the same hardware fingerprint.
 *  Uses sha-256 for cryptographic strength, then maps into 10000..99999.
 *
 *  When `rotation` > 0, a different seed is derived for the same email so
 *  the credential can be retried with a fresh fingerprint after a burn. The
 *  rotation counter is appended to the hash input — rotation=0 (default)
 *  gives the original seed for backward compatibility. */
export function emailToFingerprintSeed(email: string, rotation: number = 0): number {
  const input = rotation > 0
    ? `${email.trim().toLowerCase()}:rot${rotation}`
    : email.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return (parseInt(hash.slice(0, 5), 16) % 89999) + 10000;
}
