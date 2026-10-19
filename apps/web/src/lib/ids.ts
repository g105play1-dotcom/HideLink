/**
 * Client-generated identifiers.
 *
 * `clientMessageId` is an idempotency key that makes an optimistic message
 * reconcilable with the server's echo of it. It is *not* a secret and never
 * authenticates anything, so a cheap CSPRNG draw is enough — but it is still drawn
 * from `crypto` rather than `Math.random`, because a predictable key would let one
 * user's message be confused with another's.
 */
const ALPHABET_32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** A short, URL-safe random identifier (`[0-9a-z]{length}`). */
export function randomId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let output = '';
  for (let index = 0; index < length; index += 1) {
    // 256 is a multiple of 32, so `& 31` maps uniformly over the alphabet.
    output += ALPHABET_32.charAt((bytes[index] as number) & 31);
  }
  return output;
}
