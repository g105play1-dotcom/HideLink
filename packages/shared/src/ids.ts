/**
 * Public anonymous identity ("User ID") format.
 *
 * Design goals (see docs/SECURITY.md):
 *  - No sequential / guessable values, so the ID cannot leak how many users exist.
 *  - 60 bits of entropy, which makes blind enumeration infeasible.
 *  - Human-transcribable: Crockford Base32 avoids visually ambiguous characters.
 *  - The ID is PUBLIC and must never be used as an authentication secret.
 */

/** Alphabet without the visually ambiguous characters I, L, O and U. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Prefix that makes a User ID recognisable and cheap to validate. */
export const PUBLIC_ID_PREFIX = 'AL';

/** Number of random characters after the prefix => 12 * 5 = 60 bits of entropy. */
export const PUBLIC_ID_RANDOM_LENGTH = 12;

/** Total length, prefix included. */
export const PUBLIC_ID_LENGTH = PUBLIC_ID_PREFIX.length + PUBLIC_ID_RANDOM_LENGTH;

/**
 * Strict validation pattern. Only the canonical upper-case form is accepted;
 * use {@link normalizePublicId} first when handling user input.
 */
export const PUBLIC_ID_PATTERN = /^AL[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

/** Example of a well-formed User ID, used in UI copy and tests. */
export const PUBLIC_ID_EXAMPLE = 'AL7KM39PQ2XRZ4';

/**
 * Creates a new random public User ID.
 *
 * Uses the platform CSPRNG (`globalThis.crypto`), available in Node.js >= 19 and
 * in every supported browser. `byte & 31` is used instead of `byte % 32`: because
 * 256 is an exact multiple of 32 this mapping is uniform, i.e. free of modulo bias.
 */
export function generatePublicId(): string {
  const bytes = new Uint8Array(PUBLIC_ID_RANDOM_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  let id = PUBLIC_ID_PREFIX;
  for (let i = 0; i < bytes.length; i += 1) {
    id += CROCKFORD_ALPHABET.charAt((bytes[i] as number) & 31);
  }
  return id;
}

/**
 * Normalises user input into the canonical User ID form.
 *
 * Accepts decorative separators (`AL7KM3-9PQ2-XRZ4`), lower case, and the
 * Crockford transcription aliases: `I`/`L` become `1` and `O` becomes `0`.
 *
 * The fixed prefix is split off *before* the aliases are applied. That order is
 * essential: `L` is the Crockford alias of `1`, so rewriting the whole string
 * would turn a perfectly correct `AL...` into `A1...` and reject every User ID.
 * The prefix itself is accepted as either `AL` or its `A1` misreading.
 */
export function normalizePublicId(input: string): string {
  const compact = input
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');

  const looksPrefixed = compact.startsWith('AL') || compact.startsWith('A1');
  const prefix = looksPrefixed ? PUBLIC_ID_PREFIX : '';
  const body = looksPrefixed ? compact.slice(PUBLIC_ID_PREFIX.length) : compact;

  return `${prefix}${body.replace(/[IL]/g, '1').replace(/O/g, '0')}`;
}

/** Returns `true` when `input` is a syntactically valid public User ID. */
export function isValidPublicId(input: string): boolean {
  return PUBLIC_ID_PATTERN.test(input);
}

/** Normalises then validates. Returns the canonical ID or `null`. */
export function parsePublicId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = normalizePublicId(input);
  return isValidPublicId(normalized) ? normalized : null;
}

/** Groups an ID for display: `AL7KM39PQ2XRZ4` -> `AL7KM3-9PQ2-XRZ4`. */
export function formatPublicIdForDisplay(id: string): string {
  if (!isValidPublicId(id)) return id;
  const body = id.slice(PUBLIC_ID_PREFIX.length);
  return `${PUBLIC_ID_PREFIX}${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}
