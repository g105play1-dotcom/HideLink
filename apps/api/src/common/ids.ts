import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifier and hashing helpers.
 *
 * Identifiers are plain UUID v4 values with no embedded meaning, so a value seen
 * by a client reveals nothing beyond the fact that it is an identifier. They are
 * regenerated per chat, so two chats with the same person share no identifier.
 */

export const newChatId = (): string => randomUUID();
export const newMessageId = (): string => randomUUID();
export const newRequestId = (): string => randomUUID();
export const newReportId = (): string => randomUUID();

/**
 * Creates the opaque bearer token stored in the browser's HttpOnly cookie.
 *
 * 32 bytes of CSPRNG output, base64url-encoded. Only its SHA-256 digest is ever
 * persisted, so a database leak cannot be replayed as a session.
 */
export const newSessionToken = (): string =>
  randomBytes(32).toString('base64url');

/** SHA-256 hex digest (64 characters). */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Constant-time-ish digest of a sensitive value together with a server-side salt. */
export const saltHash = (value: string, salt: string): string => sha256Hex(`${salt}:${value}`);

/**
 * Derives a stable, non-reversible token for a piece of sensitive request data.
 *
 * Returns `undefined` when no salt is configured: AnonLink's default posture is to
 * store **no** client-identifying data at all, and hashing is only switched on when
 * an operator explicitly opts in for abuse investigation.
 */
export const optionalSaltHash = (
  value: string | undefined,
  salt: string | undefined,
): string | undefined => {
  if (!value || !salt) return undefined;
  return saltHash(value, salt);
};

/**
 * Short, human-friendly per-chat alias for a peer, e.g. `Stranger 7K3M`.
 *
 * Derived from a random value so it leaks nothing about the peer's identity, and
 * so two different chats with the same person cannot be correlated.
 */
export const peerAlias = (): string => {
  const bytes = randomBytes(3);
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let suffix = '';
  for (let i = 0; i < bytes.length; i += 1) {
    suffix += alphabet.charAt((bytes[i] as number) % alphabet.length);
  }
  return `Stranger ${suffix}`;
};
