/**
 * Message text normalisation performed on the **server**.
 *
 * The client applies the same rules for immediate feedback, but the server never
 * trusts that: this is the version whose output is stored in memory and broadcast
 * to the peer.
 *
 * What it does, and why:
 *  - rejects text that is empty after normalisation (a message of only zero-width
 *    characters is a classic way to make an empty bubble appear);
 *  - removes control characters, which are used to garble terminals, break log
 *    viewers and forge layout in other clients;
 *  - keeps `\n` and `\t` because they are legitimate formatting, but caps runs of
 *    blank lines so a single message cannot push a whole page off-screen;
 *  - trims trailing whitespace and enforces the configured length in *code points*,
 *    so an emoji is never sliced in half;
 *  - deliberately does NOT strip `<` / `>`: clients render message text as text
 *    nodes, and lossy "HTML sanitising" on plain-text data is a common own-goal.
 */

// Matching control characters is the entire point here: they are what garbles terminals,
// breaks log viewers and forges layout in other clients. The rule exists to catch a
// regex that *accidentally* contains a control character.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const EXCESS_NEWLINES = /\n{3,}/g;

export interface SanitizeResult {
  text: string;
  /** `true` when normalisation produced an empty string. */
  empty: boolean;
  /** `true` when the text had to be shortened to fit the limit. */
  truncated: boolean;
}

export function sanitizeMessageText(raw: string, maxLength: number): SanitizeResult {
  const normalised = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(ZERO_WIDTH, '')
    .replace(EXCESS_NEWLINES, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();

  if (normalised.length === 0) {
    return { text: '', empty: true, truncated: false };
  }

  // Code-point-aware truncation: `Array.from` splits by code point, so surrogate
  // pairs (most emoji) stay intact.
  const codePoints = Array.from(normalised);
  if (codePoints.length <= maxLength) {
    return { text: normalised, empty: false, truncated: false };
  }

  return { text: codePoints.slice(0, maxLength).join(''), empty: false, truncated: true };
}
