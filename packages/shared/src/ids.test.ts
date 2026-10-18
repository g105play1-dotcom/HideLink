import { describe, expect, it } from 'vitest';

import {
  PUBLIC_ID_EXAMPLE,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PATTERN,
  PUBLIC_ID_PREFIX,
  PUBLIC_ID_RANDOM_LENGTH,
  formatPublicIdForDisplay,
  generatePublicId,
  isValidPublicId,
  normalizePublicId,
  parsePublicId,
} from './ids.js';

describe('generatePublicId', () => {
  it('produces IDs that satisfy the canonical pattern', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = generatePublicId();
      expect(id).toHaveLength(PUBLIC_ID_LENGTH);
      expect(id).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('keeps the documented example valid', () => {
    // Guards against a fixture drifting out of sync with the real format, which
    // would otherwise only show up as a confusing failure in an unrelated test.
    expect(PUBLIC_ID_EXAMPLE).toHaveLength(PUBLIC_ID_LENGTH);
    expect(PUBLIC_ID_PATTERN.test(PUBLIC_ID_EXAMPLE)).toBe(true);
  });

  it('never uses visually ambiguous characters in the random part', () => {
    // The prefix is excluded: `AL` deliberately contains an `L`, which is fine
    // precisely because it is fixed and never has to be read from the ID.
    const sample = Array.from({ length: 2000 }, () =>
      generatePublicId().slice(PUBLIC_ID_PREFIX.length),
    ).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('does not collide across a large sample', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => generatePublicId()));
    expect(ids.size).toBe(20_000);
  });

  it('fills every position independently instead of counting upwards', () => {
    // A sequential or partially-random generator would leave some position with
    // very few distinct characters. With 2 000 samples each of the 12 positions
    // should use essentially the whole 32-character alphabet.
    const sample = Array.from({ length: 2_000 }, () =>
      generatePublicId().slice(PUBLIC_ID_PREFIX.length),
    );

    for (let position = 0; position < PUBLIC_ID_RANDOM_LENGTH; position += 1) {
      const distinct = new Set(sample.map((id) => id.charAt(position)));
      expect(distinct.size).toBeGreaterThanOrEqual(24);
    }
  });
});

describe('normalizePublicId', () => {
  it('accepts lowercase, separators and Crockford aliases', () => {
    expect(normalizePublicId('al7km3-9pq2-xrz4')).toBe('AL7KM39PQ2XRZ4');
    expect(normalizePublicId(' AL7KM39PQ2XRZ4 ')).toBe('AL7KM39PQ2XRZ4');
    expect(normalizePublicId('AL7KM39PQ2XRZL')).toBe('AL7KM39PQ2XRZ1');
    expect(normalizePublicId('AL7KM39PQ2XR0I')).toBe('AL7KM39PQ2XR01');
  });

  it('restores the fixed prefix instead of rewriting it to `A1`', () => {
    // Regression guard: applying the `L` -> `1` alias to the whole string used to
    // turn every valid `AL...` ID into `A1...` and reject it.
    expect(normalizePublicId('AL7KM39PQ2XRZ4')).toBe('AL7KM39PQ2XRZ4');
    expect(normalizePublicId('al7km39pq2xrz4')).toBe('AL7KM39PQ2XRZ4');
    expect(normalizePublicId('A17KM39PQ2XRZ4')).toBe('AL7KM39PQ2XRZ4');
    expect(parsePublicId(generatePublicId())).not.toBeNull();
  });
});

describe('parsePublicId', () => {
  it('returns the canonical ID for valid input', () => {
    expect(parsePublicId(' al7km3 9pq2xrz4 ')).toBe('AL7KM39PQ2XRZ4');
  });

  it.each([
    ['too short', 'AL7KM3'],
    ['too long', 'AL7KM39PQ2XRZ41234'],
    ['wrong prefix', 'XX7KM39PQ2XRZ4'],
    ['non-string', 42],
    ['empty', ''],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(parsePublicId(input)).toBeNull();
  });

  it('rejects IDs containing excluded letters even after normalization', () => {
    // `U` is not a Crockford character and is not an alias for anything.
    expect(isValidPublicId('AL7KM39PQ2XRZU')).toBe(false);
    expect(normalizePublicId('AL7KM39PQ2XRZU')).toBe('AL7KM39PQ2XRZU');
    expect(parsePublicId('AL7KM39PQ2XRZU')).toBeNull();
  });
});

describe('formatPublicIdForDisplay', () => {
  it('groups the body into readable chunks', () => {
    expect(formatPublicIdForDisplay('AL7KM39PQ2XRZ4')).toBe('AL7KM3-9PQ2-XRZ4');
  });

  it('leaves invalid IDs untouched', () => {
    expect(formatPublicIdForDisplay('nope')).toBe('nope');
  });

  it('round-trips through normalization', () => {
    const id = generatePublicId();
    expect(parsePublicId(formatPublicIdForDisplay(id))).toBe(id);
  });
});
