import { describe, expect, it } from 'vitest';

import {
  COUNTRY_BY_CODE,
  COUNTRY_HINTS,
  countryLabel,
  countrySchema,
  isCountryCode,
} from './countries.js';

/**
 * The country vocabulary is generated, so these tests guard the *shape* the generator
 * promises: every entry has a stable code and four names, no two entries share a code or
 * a native name (which would make the picker ambiguous), and validation stays closed.
 */
describe('the country vocabulary', () => {
  it('has a code and four names for every country', () => {
    expect(COUNTRY_HINTS.length).toBe(194);

    for (const country of COUNTRY_HINTS) {
      expect(country.code, country.native).toMatch(/^[A-Z]{2}$/);
      expect(country.native.trim(), country.code).not.toBe('');
      expect(country.en.trim(), country.code).not.toBe('');
      expect(country.ru.trim(), country.code).not.toBe('');
      expect(country.zh.trim(), country.code).not.toBe('');
    }
  });

  it('has no duplicate codes and no duplicate native names', () => {
    const codes = COUNTRY_HINTS.map((country) => country.code);
    expect(new Set(codes).size).toBe(codes.length);

    const native = COUNTRY_HINTS.map((country) => country.native);
    expect(new Set(native).size).toBe(native.length);
  });

  it('canonicalises a code and refuses one outside the list', () => {
    expect(countrySchema.parse('de')).toBe('DE');
    expect(countrySchema.parse(' DE ')).toBe('DE');
    expect(countrySchema.safeParse('XX').success).toBe(false);
    expect(countrySchema.safeParse('').success).toBe(false);
    expect(isCountryCode('DE')).toBe(true);
    expect(isCountryCode('de')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
  });

  it('looks up the native name and keeps an unknown code visible', () => {
    expect(COUNTRY_BY_CODE.get('DE')?.native).toBe('Deutschland');
    expect(countryLabel('DE')).toBe('Deutschland');
    // A stale/hand-edited row must be visible rather than render as a blank chip.
    expect(countryLabel('XX')).toBe('XX');
  });
});
