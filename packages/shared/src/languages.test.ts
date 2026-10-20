import { describe, expect, it } from 'vitest';

import { LANGUAGE_NAMES, LANGUAGES } from './languages.js';
import { languageSchema } from './preferences.js';

/**
 * The language vocabulary is generated, so these tests guard the *shape* the generator
 * promises rather than the individual names: every code is usable as a label, no two
 * languages share a name (which would make the picker ambiguous), and widening the list
 * does not weaken validation.
 */
describe('the language vocabulary', () => {
  it('names every language in itself, plus the three search aids', () => {
    for (const language of LANGUAGES) {
      const names = LANGUAGE_NAMES[language];

      expect(names.native.trim(), language).not.toBe('');
      expect(names.en.trim(), language).not.toBe('');
      expect(names.ru.trim(), language).not.toBe('');
      expect(names.zh.trim(), language).not.toBe('');
    }
  });

  it('has no duplicate codes and no duplicate native names', () => {
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);

    const native = LANGUAGES.map((language) => LANGUAGE_NAMES[language].native);
    expect(new Set(native).size).toBe(native.length);
  });

  it('accepts a widened code and still refuses an unknown one', () => {
    // `ja` was outside the original ten-language list. Widening it must not need a
    // database migration: the code is the contract, and the stored rows use codes.
    expect(languageSchema.safeParse('ja').success).toBe(true);
    expect(languageSchema.safeParse('xx').success).toBe(false);
  });
});
