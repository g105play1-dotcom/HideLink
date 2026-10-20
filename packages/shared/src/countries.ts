import { z } from 'zod';

import { COUNTRY_HINTS, type CountryHint } from './country-data.js';

export { COUNTRY_HINTS };
export type { CountryHint };

/**
 * A country, represented by its ISO 3166-1 alpha-2 code.
 *
 * The code is the domain value, not a name: «Германия», "Germany" and «Deutschland» are
 * the same country, and a free-text field cannot guarantee that two people who mean the
 * same country will spell it the same way (docs/DECISIONS.md D30). The list is closed —
 * only the 194 UN members in the generated vocabulary are accepted — so a typo cannot
 * become a filter that matches nobody.
 *
 * The alias is deliberately `string` rather than a 194-member union: the vocabulary is
 * generated, and the constant truth is the runtime `COUNTRY_HINTS` list plus
 * {@link countrySchema}. TypeScript still forces every consumer to pass *some* string,
 * while the API and the browser both reject an unknown one with the same schema.
 */
export type CountryCode = string;

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_HINTS.map((hint) => hint.code));

/**
 * Whether `value` is one of the generated codes.
 *
 * Comparing an upper-cased value keeps a hand-edited lowercase row readable without
 * silently accepting a code that is not in the vocabulary.
 */
export function isCountryCode(value: string): value is CountryCode {
  return COUNTRY_CODE_SET.has(value.trim().toUpperCase());
}

/**
 * The validator used by every write path and by the browser before a save.
 *
 * It trims and upper-cases first, so `de` and ` DE ` are the same country, then refuses
 * anything outside the list. The resulting value is always canonical.
 */
export const countrySchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(isCountryCode, { message: 'UNKNOWN_COUNTRY' });

/** The display record for a code. Unknown codes yield `undefined`. */
export const COUNTRY_BY_CODE: ReadonlyMap<string, CountryHint> = new Map(
  COUNTRY_HINTS.map((hint) => [hint.code, hint]),
);

/**
 * The country's name in its own language, or the code itself when it is unknown.
 *
 * Returning the code rather than an empty string keeps a stale or hand-edited row
 * visible instead of turning it into a blank chip that looks like a rendering bug.
 */
export function countryLabel(code: string): string {
  return COUNTRY_BY_CODE.get(code)?.native ?? code;
}
